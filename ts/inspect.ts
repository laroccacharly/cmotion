// Looking at a video without rendering it: stills of chosen frames, and an overview of every scene's last settled
// frame, each tiled into one labelled PNG with the layout problems the engine finds (nodes past the frame's edge or
// under a showing subtitle) printed under it.
//
// Every image gets a new numbered name (build/stills/007-cue-now.png), so a viewer never shows a stale one.
import { join } from "node:path"
import { Console, Effect, FileSystem, Option, Schema } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import { BuildError, compile, readVideo } from "./build.ts"
import { fontsDir } from "./config.ts"
import { normalize, type Word } from "./dsl.ts"
import { Engine } from "./engine.ts"
import { buildDir, stillsDir, voiceoverDir } from "./layout.ts"
import { type ProcessError, run } from "./process.ts"
import { loadScript, type Script, type ScriptError } from "./script.ts"
import { voiceoverKey } from "./voiceover.ts"

// Every scene fades out over its last 0.4s (compile.ts), so the settled frame is taken a little before.
const FADE = 0.4
export const inspectTime = (duration: number, fps: number): number => Math.max(0, Math.floor((duration - FADE - 0.1) * fps) / fps)

// ---------- frames ----------

/** A frame to look at: `scene` (its settled last frame), `scene:2.5` (seconds), or `scene@word` (when it is said),
 * with `#n` for the nth time the word is said and `+0.5` / `-0.2` to shift in seconds: `cue@now#2+0.6`. */
export type Frame =
  | { readonly scene: string; readonly kind: "end" }
  | { readonly scene: string; readonly kind: "seconds"; readonly seconds: number }
  | { readonly scene: string; readonly kind: "word"; readonly word: string; readonly n?: number; readonly shift: number }

export const parseFrame = (spec: string): Option.Option<Frame> => {
  const seconds = spec.match(/^([\w-]+):(\d+(?:\.\d+)?)$/u)
  if (seconds) return Option.some({ scene: seconds[1]!, kind: "seconds", seconds: Number(seconds[2]) })
  const word = spec.match(/^([\w-]+)@([^#+-]+)(?:#(\d+))?([+-]\d+(?:\.\d+)?)?$/u)
  if (word) return Option.some({ scene: word[1]!, kind: "word", word: word[2]!, ...(word[3] ? { n: Number(word[3]) } : {}), shift: Number(word[4] ?? 0) })
  if (/^[\w-]+$/u.test(spec)) return Option.some({ scene: spec, kind: "end" })
  return Option.none()
}

/** The frame's time in scene seconds. A word said more than once needs #n, as s.at does. */
export const frameTime = (frame: Frame, scene: { duration: number; words: ReadonlyArray<Word>; leadIn: number }, fps: number): number | string => {
  if (frame.kind === "end") return inspectTime(scene.duration, fps)
  if (frame.kind === "seconds") return frame.seconds
  const hits = scene.words.filter((w) => normalize(w.text) === normalize(frame.word))
  if (hits.length === 0) return `"${frame.word}" is not in the voiceover of ${frame.scene}`
  if (frame.n === undefined && hits.length > 1) return `"${frame.word}" is said ${hits.length} times in ${frame.scene}; pick one with ${frame.scene}@${frame.word}#n`
  const hit = hits[(frame.n ?? 1) - 1]
  if (!hit) return `"${frame.word}" is said only ${hits.length} time(s) in ${frame.scene}`
  return Math.round((hit.start + scene.leadIn + frame.shift) * 1000) / 1000
}

/** The next free numbered path in dir: 001-name.png, 002-name.png, ... */
export const numbered = (existing: ReadonlyArray<string>, name: string): string => {
  const top = Math.max(0, ...existing.map((file) => Number.parseInt(file, 10)).filter(Number.isFinite))
  return `${String(top + 1).padStart(3, "0")}-${name.replace(/[^\w.@+-]+/gu, "_")}.png`
}

// ---------- bounds ----------

const Issue = Schema.Struct({
  kind: Schema.Literals(["frame", "subtitle"]),
  id: Schema.String,
  type: Schema.String,
  text: Schema.optional(Schema.String),
  t: Schema.Finite,
  seconds: Schema.Finite,
  rect: Schema.Tuple([Schema.Finite, Schema.Finite, Schema.Finite, Schema.Finite]),
})
const Issues = Schema.fromJsonString(Schema.Array(Issue))

/** One readable line per issue the engine found in a scene. */
export const describeIssues = (scene: string, issues: ReadonlyArray<typeof Issue.Type>): string[] =>
  issues.map(({ kind, id, type, text, t, seconds, rect: [x, y, w, h] }) => {
    const what = `${type}${id ? ` "${id}"` : " without an id"}${text !== undefined && text !== id ? ` (${JSON.stringify(text.length > 30 ? `${text.slice(0, 30)}…` : text)})` : ""}`
    const where = kind === "frame" ? "leaves the frame" : "is under the subtitle"
    return `  ! ${scene} ${t.toFixed(2)}s: ${what} ${where} for ${seconds.toFixed(2)}s, first at x ${x}..${x + w}, y ${y}..${y + h}`
  })

// ---------- sheets ----------

export interface Sheet {
  readonly columns: number
  // Width of one frame in the sheet, px.
  readonly width: number
}

const GAP = 16
const LABEL = 44
const BACKDROP = "0x18181a"

// ffmpeg drawtext reads \, ' and : as syntax, and % as an expansion.
const escapeText = (text: string) => text.replace(/[\\':%]/g, (c) => `\\${c}`)

/** The filter graph tiling `labels.length` stills of size width x height (in that order) into one image, [sheet]. */
export const sheetFilter = (labels: ReadonlyArray<string>, frame: { width: number; height: number }, sheet: Sheet): string => {
  const w = sheet.width
  const h = Math.round((frame.height * w) / frame.width / 2) * 2 + LABEL
  const font = join(fontsDir, "JetBrainsMono-SemiBold.ttf")
  const cells = labels.map(
    (label, i) =>
      `[${i}:v]scale=${w}:-2,pad=iw:${h}:0:0:color=${BACKDROP},` +
      `drawtext=fontfile='${font}':text='${escapeText(label)}':x=14:y=h-${LABEL}+(${LABEL}-th)/2:fontsize=22:fontcolor=0xe8e6e1[c${i}];`
  )
  const columns = Math.min(sheet.columns, labels.length)
  const layout = labels.map((_, i) => `${(i % columns) * (w + GAP)}_${Math.floor(i / columns) * (h + GAP)}`).join("|")
  const stack = labels.length === 1 ? "[c0]null" : `${labels.map((_, i) => `[c${i}]`).join("")}xstack=inputs=${labels.length}:layout=${layout}:fill=${BACKDROP}`
  return `${cells.join("")}${stack},pad=iw+${GAP * 2}:ih+${GAP * 2}:${GAP}:${GAP}:color=${BACKDROP}[sheet]`
}

const tile = (pngs: ReadonlyArray<{ png: string; label: string }>, frame: { width: number; height: number }, sheet: Sheet, out: string) =>
  run("sheet", "ffmpeg", [
    "-v", "error", "-y",
    ...pngs.flatMap(({ png }) => ["-i", png]),
    "-filter_complex", sheetFilter(pngs.map(({ label }) => label), frame, sheet),
    "-map", "[sheet]", "-frames:v", "1", out,
  ])

type Shot = { readonly scene: string; readonly t: number; readonly label: string }

type InspectServices = Engine | FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner
type InspectError = BuildError | ProcessError | ScriptError

// Renders each shot, prints the layout problems of the scenes they are in, and writes one image: the shot itself, or
// all of them tiled. `dir` is build/stills or build/inspect: frames go to its frames/, images to a numbered name.
const shoot = Effect.fnUntraced(function* (renderJson: string, folder: string, name: string, shots: ReadonlyArray<Shot>, sheet: Sheet, out: Option.Option<string>) {
  const fs = yield* FileSystem.FileSystem
  const engine = yield* Engine
  const { video } = yield* readVideo(renderJson)
  const fsError = (error: { readonly message: string }) => new BuildError({ message: error.message })
  yield* fs.makeDirectory(join(folder, "frames"), { recursive: true }).pipe(Effect.mapError(fsError))
  // Bounds come with the first shot of each scene.
  const firsts = new Set(shots.map((shot) => shots.find((s) => s.scene === shot.scene)))
  const rendered = yield* Effect.forEach(
    shots,
    (shot) => {
      const png = join(folder, "frames", `${shot.scene}-${shot.t}.png`)
      return engine.still(renderJson, `${shot.scene}:${shot.t}`, png, firsts.has(shot)).pipe(Effect.map((bounds) => ({ ...shot, png, bounds })))
    },
    { concurrency: 4 }
  )
  const warnings: string[] = []
  for (const shot of rendered) {
    if (!shot.bounds.trim()) continue
    const issues = yield* Schema.decodeEffect(Issues)(shot.bounds.trim()).pipe(Effect.mapError((error) => new BuildError({ message: `engine bounds: ${error.message}` })))
    warnings.push(...describeIssues(shot.scene, issues))
  }
  const existing = yield* fs.readDirectory(folder).pipe(Effect.mapError(fsError))
  const target = Option.getOrElse(out, () => join(folder, numbered(existing, name)))
  if (rendered.length === 1 && rendered[0]) yield* fs.copyFile(rendered[0].png, target).pipe(Effect.mapError(fsError))
  else yield* tile(rendered, video, sheet, target)
  if (warnings.length) yield* Console.log(warnings.join("\n"))
  yield* Console.log(target)
})

const sceneWords = Effect.fnUntraced(function* (dir: string, script: Script, id: string) {
  const scene = script.scenes.find((s) => s.id === id)
  if (!scene) return [] as ReadonlyArray<Word>
  const meta = join(voiceoverDir(dir), `${voiceoverKey(script, scene.voiceover.trim())}.json`)
  const text = yield* (yield* FileSystem.FileSystem).readFileString(meta).pipe(Effect.mapError(() => new BuildError({ message: `scene ${id}: no voiceover; run \`cmotion voiceover\` first` })))
  const decoded = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Struct({ words: Schema.Array(Schema.Struct({ text: Schema.String, start: Schema.Finite, end: Schema.Finite })) })))(text).pipe(
    Effect.mapError((error) => new BuildError({ message: `${meta}: ${error.message}` }))
  )
  return decoded.words
})

// Stills of the given frames: compiles only their scenes, writes one numbered PNG (tiled when there are several).
export const stills: (
  dir: string,
  imageModel: string,
  specs: ReadonlyArray<string>,
  sheet: Sheet,
  out: Option.Option<string>
) => Effect.Effect<void, InspectError, InspectServices> = Effect.fn("stills")(function* stills(
  dir: string,
  imageModel: string,
  specs: ReadonlyArray<string>,
  sheet: Sheet,
  out: Option.Option<string>
) {
  const frames: Array<{ spec: string; frame: Frame }> = []
  const bad: string[] = []
  for (const spec of specs) {
    const frame = parseFrame(spec)
    if (Option.isSome(frame)) frames.push({ spec, frame: frame.value })
    else bad.push(spec)
  }
  if (bad.length) return yield* new BuildError({ message: `not a frame: ${bad.join(", ")}; use scene, scene:2.5 or scene@word (#n for the nth time, +0.5 to shift)` })
  const ids = [...new Set(frames.map(({ frame }) => frame.scene))]
  const renderJson = yield* compile(dir, imageModel, { scenes: ids, out: join(stillsDir(dir), "render.json") })
  const { video } = yield* readVideo(renderJson)
  const script = yield* loadScript(dir)
  const shots: Shot[] = []
  for (const { spec, frame } of frames) {
    const scene = video.scenes.find((s) => s.id === frame.scene)
    if (!scene) return yield* new BuildError({ message: `no scene ${frame.scene}` })
    const t = frameTime(frame, { duration: scene.duration, words: yield* sceneWords(dir, script, scene.id), leadIn: script.lead_in }, video.fps)
    if (typeof t === "string") return yield* new BuildError({ message: t })
    shots.push({ scene: scene.id, t, label: spec === `${scene.id}:${t}` ? spec : `${spec}  ${t.toFixed(2)}s` })
  }
  yield* shoot(renderJson, stillsDir(dir), specs.join("_").slice(0, 60), shots, sheet, out)
})

// Every scene's settled last frame, tiled in order, with every scene's layout problems.
export const inspect: (dir: string, imageModel: string, sheet: Sheet, out: Option.Option<string>) => Effect.Effect<void, InspectError, InspectServices> = Effect.fn("inspect")(function* inspect(
  dir: string,
  imageModel: string,
  sheet: Sheet,
  out: Option.Option<string>
) {
  const renderJson = yield* compile(dir, imageModel)
  const { video } = yield* readVideo(renderJson)
  if (video.scenes.length === 0) return yield* new BuildError({ message: "no scenes to inspect" })
  const shots = video.scenes.map((scene, i) => {
    const t = inspectTime(scene.duration, video.fps)
    return { scene: scene.id, t, label: `${String(i + 1).padStart(2, "0")}  ${scene.id}  ${t.toFixed(1)}s` }
  })
  yield* shoot(renderJson, join(buildDir(dir), "inspect"), "inspect", shots, sheet, out)
})
