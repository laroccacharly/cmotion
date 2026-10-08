// The script, videos/VIDEO/script.json: every scene with its voiceover, images and timing.
import { Effect, FileSystem, Schema } from "effect"
import { scriptFile } from "./layout.ts"
import { voiceNames } from "./voices.ts"

const Id = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]*$/u, { message: "lowercase letters, digits and dashes" }))

// WIDTHxHEIGHT: both divisible by 16, aspect between 1:3 and 3:1, at most 3840x2160.
const sizeIssue = (size: string) => {
  const match = /^(\d+)x(\d+)$/u.exec(size)
  if (!match) return `size ${size} is not WIDTHxHEIGHT`
  const w = Number(match[1])
  const h = Number(match[2])
  if (w <= 0 || h <= 0 || w % 16 || h % 16) return `size ${size}: width and height must be divisible by 16`
  if (Math.max(w, h) > 3 * Math.min(w, h)) return `size ${size}: aspect must be between 1:3 and 3:1`
  if (Math.max(w, h) > 3840 || Math.min(w, h) > 2160) return `size ${size}: at most 3840x2160`
  return true
}

const uniqueIds = (what: string) =>
  Schema.makeFilter((items: ReadonlyArray<{ readonly id: string }>) => {
    const ids = items.map((item) => item.id)
    const duplicates = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))].sort()
    return duplicates.length === 0 || `duplicate ${what} ids: ${duplicates.join(", ")}`
  })

// An image generated with OpenAI Images for one scene, cached by its prompt and settings.
export const GeneratedImage = Schema.Struct({
  id: Id,
  prompt: Schema.NonEmptyString,
  size: Schema.String.check(Schema.makeFilter(sizeIssue)).pipe(Schema.withDecodingDefaultKey(Effect.succeed("1536x864"))),
  quality: Schema.Literals(["auto", "low", "medium", "high"]).pipe(Schema.withDecodingDefaultKey(Effect.succeed("high"))),
  transparent: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
})
export type GeneratedImage = typeof GeneratedImage.Type

// An image file you supply, like a photo found on the web, by its path relative to the video folder. Never generated.
export const FileImage = Schema.Struct({ id: Id, file: Schema.NonEmptyString })
export type FileImage = typeof FileImage.Type

export const SceneImage = Schema.Union([GeneratedImage, FileImage])
export type SceneImage = typeof SceneImage.Type

// One self-contained cut: its own voiceover, visuals and timing.
export const Scene = Schema.Struct({
  id: Id,
  title: Schema.String,
  visual: Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed(""))),
  voiceover: Schema.NonEmptyString,
  images: Schema.Array(SceneImage).check(uniqueIds("image")).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
})
export type Scene = typeof Scene.Type

// Background music under the whole video, ducked under the voiceover.
const musicFields = {
  prompt: Schema.NonEmptyString,
  // Gain of the music under the voiceover, from 0 to 1.
  volume: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })).pipe(Schema.withDecodingDefaultKey(Effect.succeed(0.15))),
}
export const Music = Schema.Union([
  Schema.Struct({
    ...musicFields,
    provider: Schema.Literal("openrouter").pipe(Schema.withDecodingDefaultKey(Effect.succeed("openrouter" as const))),
    model: Schema.Literals(["google/lyria-3-pro-preview", "google/lyria-3-clip-preview"]).pipe(
      Schema.withDecodingDefaultKey(Effect.succeed("google/lyria-3-pro-preview" as const))
    ),
  }),
  Schema.Struct({
    ...musicFields,
    provider: Schema.Literal("gemini"),
    model: Schema.Literals(["lyria-3.5", "lyria-3-clip-preview"]).pipe(Schema.withDecodingDefaultKey(Effect.succeed("lyria-3.5" as const))),
  }),
])
export type Music = typeof Music.Type

export const Script = Schema.Struct({
  title: Schema.String,
  // The ElevenLabs voice for every scene, by name (see voices.ts).
  voice: Schema.Literals(voiceNames).pipe(Schema.withDecodingDefaultKey(Effect.succeed("george" as const))),
  model: Schema.Literals(["eleven_v4", "eleven_v4_turbo"]).pipe(Schema.withDecodingDefaultKey(Effect.succeed("eleven_v4"))),
  output_format: Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed("mp3_44100_128"))),
  // Seconds of picture before the voiceover starts and after it ends.
  lead_in: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)).pipe(Schema.withDecodingDefaultKey(Effect.succeed(0.4))),
  tail: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)).pipe(Schema.withDecodingDefaultKey(Effect.succeed(0.6))),
  // Burn the voiceover in as subtitles.
  subtitles: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
  music: Schema.optional(Music),
  scenes: Schema.Array(Scene).check(Schema.isMinLength(1), uniqueIds("scene")),
})
export type Script = typeof Script.Type

export class ScriptError extends Schema.TaggedError<ScriptError>()("ScriptError", {
  message: Schema.String,
}) {}

const decodeScript = Schema.decodeUnknownEffect(Schema.fromJsonString(Script), { onExcessProperty: "error" })

export const loadScript: (dir: string) => Effect.Effect<Script, ScriptError, FileSystem.FileSystem> = Effect.fn("loadScript")(function* loadScript(dir: string) {
  const path = scriptFile(dir)
  const fs = yield* FileSystem.FileSystem
  const text = yield* fs.readFileString(path).pipe(Effect.mapError(() => new ScriptError({ message: `No script at ${path}` })))
  return yield* decodeScript(text).pipe(Effect.mapError((error) => new ScriptError({ message: `Invalid script ${path}:\n${error.message}` })))
})

// The scenes with these ids, in script order; all of them when none are given.
export const selectScenes: (script: Script, ids: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<Scene>, ScriptError> = Effect.fn("selectScenes")(function* selectScenes(
  script: Script,
  ids: ReadonlyArray<string>
) {
  if (ids.length === 0) return script.scenes
  const unknown = ids.filter((id) => !script.scenes.some((scene) => scene.id === id)).sort()
  if (unknown.length > 0) return yield* new ScriptError({ message: `Unknown scene ids: ${unknown.join(", ")}` })
  return script.scenes.filter((scene) => ids.includes(scene.id))
})
