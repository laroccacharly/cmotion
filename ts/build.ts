// A script end to end: voiceovers, images, compile, scene renders and the joined video, each step cached.
//
// - voiceover: generated/voiceover/<key>.mp3, keyed by text, voice, model and format
// - images: generated/images/<key>.png, keyed by prompt, size, quality, background and model
// - music: generated/music/<key>.mp3, keyed by prompt and model
// - scenes: build/scenes/<id>.mp4, keyed by the compiled scene, the engine binary and x264 settings
// - video: script.mp4, keyed by the ordered scene keys and the music
import { join } from "node:path"
import { Console, Effect, FileSystem, Schema } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import type { CredentialsError } from "effect-lib/credentials"
import { type Config, packageDir, tscBin } from "./config.ts"
import { Engine, type Encoding } from "./engine.ts"
import { type ImageError, type OpenAIImages, sceneImages } from "./images.ts"
import { canonicalJson, sha } from "./key.ts"
import { buildDir, imageDir, musicDir, outputFile, renderFile, sceneRenderDir, voiceoverDir } from "./layout.ts"
import { type MusicError, music, musicFile, musicKey, type MusicGeneration } from "./music.ts"
import { type ProcessError, run } from "./process.ts"
import { loadScript, type ScriptError, selectScenes } from "./script.ts"
import { type ElevenLabs, type VoiceoverError, voiceover } from "./voiceover.ts"

export class BuildError extends Schema.TaggedError<BuildError>()("BuildError", {
  message: Schema.String,
}) {}

const Video = Schema.Struct({
  width: Schema.Finite,
  height: Schema.Finite,
  fps: Schema.Finite,
  scenes: Schema.Array(Schema.Struct({ id: Schema.String, duration: Schema.Finite })),
})
// The scenes again as plain JSON, since each scene's key covers all of it.
const RawVideo = Schema.Struct({ scenes: Schema.Array(Schema.Json) })

export const readVideo: (renderJson: string) => Effect.Effect<{ video: typeof Video.Type; raw: ReadonlyArray<Schema.Json> }, BuildError, FileSystem.FileSystem> = Effect.fn("readVideo")(
  function* readVideo(renderJson: string) {
    const text = yield* (yield* FileSystem.FileSystem).readFileString(renderJson).pipe(Effect.mapError((error) => new BuildError({ message: error.message })))
    const invalid = (error: Schema.SchemaError) => new BuildError({ message: `Invalid ${renderJson}: ${error.message}` })
    const video = yield* Schema.decodeEffect(Schema.fromJsonString(Video))(text).pipe(Effect.mapError(invalid))
    const raw = yield* Schema.decodeEffect(Schema.fromJsonString(RawVideo))(text).pipe(Effect.mapError(invalid))
    return { video, raw: raw.scenes }
  }
)

// Everything a scene render depends on. The audio path is the voiceover's own cache key.
const sceneKey = (video: typeof Video.Type, scene: Schema.Json, engine: Uint8Array, encoding: Encoding) =>
  sha(canonicalJson([{ width: video.width, height: video.height, fps: video.fps }, scene, encoding.preset, encoding.crf]), engine)

const upToDate = (fs: FileSystem.FileSystem, out: string, keyFile: string, key: string) =>
  Effect.gen(function* () {
    if (!(yield* fs.exists(out))) return false
    return (yield* fs.readFileString(keyFile)).trim() === key
  }).pipe(Effect.orElseSucceed(() => false))

const fsError = (error: { readonly message: string }) => new BuildError({ message: error.message })

// Type-checks the video's scenes and theme against the DSL, through build/tsconfig.json.
export const typecheck: (dir: string) => Effect.Effect<void, BuildError | ProcessError, FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner> = Effect.fn("typecheck")(
  function* typecheck(dir: string) {
    const tsconfig = join(buildDir(dir), "tsconfig.json")
    const config = {
      extends: join(packageDir, "tsconfig.json"),
      compilerOptions: { types: [] },
      include: [join(dir, "theme.ts"), join(dir, "scenes", "**", "*.ts")],
    }
    const fs = yield* FileSystem.FileSystem
    yield* fs.makeDirectory(buildDir(dir), { recursive: true }).pipe(Effect.andThen(fs.writeFileString(tsconfig, `${JSON.stringify(config, null, 2)}\n`)), Effect.mapError(fsError))
    yield* run("type check", tscBin, ["-p", tsconfig], { inherit: true })
  }
)

export interface CompileOptions {
  // Only these scenes, for stills; every scene when empty.
  readonly scenes?: ReadonlyArray<string>
  // Default build/render.json.
  readonly out?: string
}

// Type-checks the scenes, then writes build/render.json from them and the generated voiceovers and images.
export const compile: (
  dir: string,
  imageModel: string,
  options?: CompileOptions
) => Effect.Effect<string, BuildError | ProcessError, FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner> = Effect.fn("compile")(function* compile(
  dir: string,
  imageModel: string,
  options: CompileOptions = {}
) {
  yield* typecheck(dir)
  const out = options.out ?? renderFile(dir)
  const only = (options.scenes ?? []).flatMap((id) => ["--scene", id])
  // In its own bun, so each build imports the scene files fresh.
  yield* run("compile", process.execPath, [join(packageDir, "ts", "compile.ts"), dir, imageModel, ...only, "--out", out], { inherit: true })
  return out
})

// Renders these scenes of render.json (all when ids is empty) to scenesDir/<id>.mp4 unless an identical render exists.
// Returns every scene's key, in order.
export const renderScenes: (
  renderJson: string,
  scenesDir: string,
  encoding: Encoding,
  jobs: number,
  ids: ReadonlyArray<string>
) => Effect.Effect<ReadonlyArray<string>, BuildError | ProcessError, Engine | FileSystem.FileSystem> = Effect.fn("renderScenes")(function* renderScenes(
  renderJson: string,
  scenesDir: string,
  encoding: Encoding,
  jobs: number,
  ids: ReadonlyArray<string>
) {
  const fs = yield* FileSystem.FileSystem
  const engine = yield* Engine
  const { video, raw } = yield* readVideo(renderJson)
  const binary = yield* fs.readFile(yield* engine.binary).pipe(Effect.mapError(fsError))
  const keys = raw.map((scene) => sceneKey(video, scene, binary, encoding))
  yield* fs.makeDirectory(scenesDir, { recursive: true }).pipe(Effect.mapError(fsError))

  const render = Effect.fnUntraced(function* (id: string, key: string) {
    const out = join(scenesDir, `${id}.mp4`)
    const keyFile = join(scenesDir, `${id}.key`)
    if (yield* upToDate(fs, out, keyFile, key)) return yield* Console.log(`  scene ${id}: cached`)
    yield* Console.log(`  scene ${id}: rendering`)
    const partial = join(scenesDir, `${id}.partial.mp4`)
    yield* engine.render(renderJson, id, partial, encoding)
    yield* fs.rename(partial, out).pipe(Effect.andThen(fs.writeFileString(keyFile, key)), Effect.mapError(fsError))
  })

  const selected = video.scenes.flatMap((scene, i) => (ids.length === 0 || ids.includes(scene.id) ? [{ id: scene.id, key: keys[i] ?? "" }] : []))
  yield* Effect.forEach(selected, ({ id, key }) => render(id, key), { concurrency: jobs, discard: true })
  return keys
})

const duration = (path: string) =>
  run("ffprobe", "ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path]).pipe(Effect.map((text) => Number.parseFloat(text)))

// Music under the joined video: its file, gain and cache key.
export interface Background {
  readonly file: string
  readonly volume: number
  readonly key: string
}

// Seconds of crossfade where a short track repeats.
const LOOP_FADE = 1

// Writes the music under the video to out, exactly `total` samples at 48kHz: a long track is cut to the video,
// a short one repeats with a crossfade at each seam. Then gain, a 1s fade in and a 2s fade out. Built on its
// own and its length checked, so the music can never stop before the video does.
const musicBed: (background: Background, total: number, out: string) => Effect.Effect<void, BuildError | ProcessError, ChildProcessSpawner.ChildProcessSpawner> = Effect.fn(
  "musicBed"
)(function* musicBed(background: Background, total: number, out: string) {
  const seconds = total / 48000
  const track = yield* duration(background.file)
  if (!(track > LOOP_FADE * 2)) return yield* new BuildError({ message: `music ${background.file} is too short (${track}s)` })
  const copies = track >= seconds ? 1 : Math.ceil((seconds - LOOP_FADE) / (track - LOOP_FADE))
  const inputs = Array.from({ length: copies }, () => ["-i", background.file]).flat()
  const resampled = Array.from({ length: copies }, (_, i) => `[${i}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[c${i}];`).join("")
  const chained = Array.from({ length: copies - 1 }, (_, i) => `[${i === 0 ? "c0" : `x${i}`}][c${i + 1}]acrossfade=d=${LOOP_FADE}[x${i + 1}];`).join("")
  const fadeOut = Math.max(0, seconds - 2).toFixed(3)
  const shape = `atrim=end_sample=${total},volume=${background.volume},afade=t=in:d=1,afade=t=out:st=${fadeOut}:d=2[bed]`
  const filter = `${resampled}${chained}[${copies === 1 ? "c0" : `x${copies - 1}`}]${shape}`
  yield* run("music bed", "ffmpeg", ["-v", "error", "-y", ...inputs, "-filter_complex", filter, "-map", "[bed]", "-c:a", "pcm_s16le", out])
  const samples = Number.parseInt(yield* run("ffprobe", "ffprobe", ["-v", "error", "-show_entries", "stream=duration_ts", "-of", "csv=p=0", out]), 10)
  if (samples < total) return yield* new BuildError({ message: `music bed is ${(samples / 48000).toFixed(2)}s, shorter than the ${seconds.toFixed(2)}s video` })
})

// Joins the scene mp4s without re-encoding the video, unless the same scenes were joined before.
// Only the audio is re-encoded: copied AAC carries each file's encoder padding, which drifts the voiceover by tens of
// ms over a video. Each scene's audio is cut to its exact frame count instead.
// Music, made to the video's length by musicBed, ducks under the voiceover.
export const joinScenes: (
  renderJson: string,
  scenesDir: string,
  keys: ReadonlyArray<string>,
  out: string,
  keyFile: string,
  background?: Background
) => Effect.Effect<void, BuildError | ProcessError, FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner> = Effect.fn("joinScenes")(function* joinScenes(
  renderJson: string,
  scenesDir: string,
  keys: ReadonlyArray<string>,
  out: string,
  keyFile: string,
  background?: Background
) {
  const fs = yield* FileSystem.FileSystem
  const { video } = yield* readVideo(renderJson)
  const { scenes, fps } = video
  // bed:2 is the length-checked bed; joins from before it can have lost their music partway.
  const musicPart = background ? [`music:${background.key}:${background.volume}:bed:2`] : []
  const key = sha(...scenes.map((scene, i) => `${scene.id}:${keys[i] ?? ""}`), ...musicPart)
  if (yield* upToDate(fs, out, keyFile, key)) return yield* Console.log(`  video: cached → ${out}`)
  const files = scenes.map((scene) => join(scenesDir, `${scene.id}.mp4`))
  const concatList = join(scenesDir, "concat.txt")
  yield* fs.writeFileString(concatList, files.map((file) => `file '${file}'\n`).join("")).pipe(Effect.mapError(fsError))
  // Same frame count as the engine: whole frames, rounded up.
  const samples = scenes.map((scene) => Math.round((Math.ceil(scene.duration * fps - 1e-3) * 48000) / fps))
  const trims = samples.map((n, i) => `[${i + 1}:a]atrim=end_sample=${n},asetpts=PTS-STARTPTS[a${i}];`).join("")
  const joined = scenes.map((_, i) => `[a${i}]`).join("")
  const partial = out.replace(/\.mp4$/u, ".partial.mp4")
  yield* Console.log(`  video: joining ${scenes.length} scenes`)
  const bed = join(scenesDir, "music-bed.wav")
  if (background) yield* musicBed(background, samples.reduce((a, n) => a + n, 0), bed)
  const inputs = [...files.flatMap((file) => ["-i", file]), ...(background ? ["-i", bed] : [])]
  const voice = `${trims}${joined}concat=n=${scenes.length}:v=0:a=1`
  const filter = background
    ? `${voice}[voice];[${scenes.length + 1}:a]anull[bed];` +
      "[voice]asplit[v1][v2];[bed][v2]sidechaincompress=threshold=0.03:ratio=4:attack=20:release=400[ducked];[v1][ducked]amix=inputs=2:duration=first:normalize=0[a]"
    : `${voice}[a]`
  const output = ["-map", "0:v", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", partial]
  yield* run("join", "ffmpeg", ["-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", concatList, ...inputs, "-filter_complex", filter, ...output])
  yield* fs.rename(partial, out).pipe(Effect.andThen(fs.writeFileString(keyFile, key)), Effect.mapError(fsError))
  yield* Console.log(`  video → ${out} (${(yield* duration(out)).toFixed(1)}s)`)
})

export type BuildServices = Engine | ElevenLabs | OpenAIImages | MusicGeneration | FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner
export type BuildFailure = BuildError | ProcessError | ScriptError | VoiceoverError | ImageError | MusicError | CredentialsError

// New voiceovers, images and music first, then compile and render. With scene ids, only those render and nothing is joined.
export const build: (dir: string, ids: ReadonlyArray<string>, config: Config) => Effect.Effect<string, BuildFailure, BuildServices> = Effect.fn("build")(function* build(
  dir: string,
  ids: ReadonlyArray<string>,
  config: Config
) {
  const script = yield* loadScript(dir)
  yield* selectScenes(script, ids)
  // Every scene compiles, so every voiceover and image is needed.
  yield* Effect.forEach(script.scenes, (scene) => voiceover(script, scene, voiceoverDir(dir)), { discard: true })
  yield* sceneImages(script.scenes, imageDir(dir), config.imageModel, config.imageJobs)
  if (script.music) yield* music(script.music, musicDir(dir))
  yield* (yield* Engine).binary
  const renderJson = yield* compile(dir, config.imageModel)
  const scenesDir = sceneRenderDir(dir)
  const keys = yield* renderScenes(renderJson, scenesDir, config, config.jobs, ids)
  const out = outputFile(dir)
  const background = script.music && { file: musicFile(musicDir(dir), script.music), volume: script.music.volume, key: musicKey(script.music) }
  if (ids.length === 0) yield* joinScenes(renderJson, scenesDir, keys, out, join(buildDir(dir), "script.key"), background)
  return out
})
