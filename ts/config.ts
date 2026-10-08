// Where cmotion keeps things, its API keys and its config file.
import { readdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { Effect, type FileSystem, Option, Schema } from "effect"
import { make, secret } from "effect-lib/credentials"
import * as JsonStore from "effect-lib/json-store"
import pkg from "../package.json" with { type: "json" }
import { sha } from "./key.ts"

export const version = pkg.version
export const packageDir = join(import.meta.dir, "..")

const xdg = (name: string, fallback: string) => process.env[name] || join(homedir(), fallback)
// The engine is every .c and .h under src/, vendored libraries included, compiled with these flags.
export const engineFlags = ["-O2", "-std=c11", "-D_GNU_SOURCE", "-Wall", "-Wextra", "-Wno-unused-result"]
export const engineLibs = ["-lEGL", "-lOpenGL", "-lm", "-lpthread"]
export const engineSources = readdirSync(join(packageDir, "src"), { recursive: true, encoding: "utf8" })
  .filter((file) => /\.[ch]$/.test(file))
  .toSorted()
export const engineHash = sha(...engineFlags, ...engineLibs, ...engineSources.flatMap((file) => [file, readFileSync(join(packageDir, "src", file))]))
export const fontsDir = join(packageDir, "fonts")
// TypeScript's own compiler, to type-check a video's scenes before they compile.
export const tscBin = join(dirname(Bun.resolveSync("typescript/package.json", packageDir)), "bin", "tsc")

// Engine binaries are keyed by their sources, so releases that change only TypeScript reuse the built engine.
const cacheDir = join(xdg("XDG_CACHE_HOME", ".cache"), "cmotion")
export const engineDir = join(cacheDir, `engine-${engineHash}`)
export const configPath = join(xdg("XDG_CONFIG_HOME", ".config"), "cmotion", "config.json")

// Secrets come from the environment, falling back to the OS keyring (`cmotion login`).
export const ElevenLabsKey = secret("ELEVENLABS_API_KEY", { label: "ElevenLabs API key" })
export const OpenAIKey = secret("OPENAI_API_KEY", { label: "OpenAI API key" })
export const OpenRouterKey = secret("OPENROUTER_API_KEY", { label: "OpenRouter API key" })
export const GeminiKey = secret("GEMINI_API_KEY", { label: "Gemini API key" })
export const credentials = make([ElevenLabsKey, OpenAIKey, OpenRouterKey, GeminiKey])

const ConfigFile = Schema.Struct({
  // OpenAI Images model for scene images. Part of each image's cache key.
  imageModel: Schema.optional(Schema.String),
  // x264 settings for scene renders. Part of each scene's cache key.
  preset: Schema.optional(Schema.String),
  crf: Schema.optional(Schema.Int),
  // Engines rendering at once: x264 already uses every core, two overlap one's startup and tail with the other's encode.
  jobs: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  // Images generated at once.
  imageJobs: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
})

export interface Config {
  readonly imageModel: string
  readonly preset: string
  readonly crf: number
  readonly jobs: number
  readonly imageJobs: number
}

export class ConfigError extends Schema.TaggedError<ConfigError>()("ConfigError", {
  message: Schema.String,
}) {}

const store = JsonStore.make(configPath, ConfigFile)

export const loadConfig: Effect.Effect<Config, ConfigError, FileSystem.FileSystem> = Effect.gen(function* () {
  const file: typeof ConfigFile.Type = Option.getOrElse(yield* store.load.pipe(Effect.mapError((error) => new ConfigError({ message: error.message }))), () => ({}))
  return {
    imageModel: file.imageModel ?? "gpt-image-2.5-sunburst",
    preset: file.preset ?? "veryfast",
    crf: file.crf ?? 18,
    jobs: file.jobs ?? 2,
    imageJobs: file.imageJobs ?? 4,
  } satisfies Config
}).pipe(Effect.withSpan("loadConfig"))
