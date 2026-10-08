// Background music with Google Lyria 3 on OpenRouter, kept in videos/VIDEO/generated/music/<key>.{mp3,json} by prompt and model.
import { join } from "node:path"
import { Console, Context, Effect, FileSystem, Layer, Redacted, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import { type CredentialsError, Keyring } from "effect-lib/credentials"
import { GeminiKey, OpenRouterKey } from "./config.ts"
import { canonicalJson, sha } from "./key.ts"
import type { Music } from "./script.ts"

// Keep existing OpenRouter cache keys; Gemini generations have their own namespace.
export const musicKey = (music: Music): string =>
  sha(canonicalJson({ prompt: music.prompt.trim(), model: music.model, ...(music.provider === "gemini" ? { provider: music.provider } : {}) }))

export interface GeneratedMusic {
  readonly audio: Uint8Array
  readonly lyrics: string
}

export interface MusicProvider {
  generate(music: Music): Effect.Effect<GeneratedMusic, MusicError | CredentialsError>
}

export const musicFile = (dir: string, music: Music): string => join(dir, `${musicKey(music)}.mp3`)

export class MusicError extends Schema.TaggedError<MusicError>()("MusicError", {
  message: Schema.String,
}) {}

// One server-sent chunk: the lyrics arrive as text content, the MP3 as base64 audio data. Errors can come mid-stream.
const Chunk = Schema.Struct({
  choices: Schema.optional(
    Schema.Array(
      Schema.Struct({
        delta: Schema.optional(
          Schema.Struct({
            content: Schema.optional(Schema.NullOr(Schema.String)),
            audio: Schema.optional(Schema.Struct({ data: Schema.optional(Schema.String) })),
          })
        ),
      })
    )
  ),
  error: Schema.optional(Schema.Struct({ message: Schema.String })),
})
const decodeChunk = Schema.decodeUnknownEffect(Schema.fromJsonString(Chunk))

// The audio and lyrics of a whole OpenRouter event stream. Comment lines (": OPENROUTER PROCESSING") are skipped.
export const readStream: (body: string) => Effect.Effect<{ readonly audio: Uint8Array; readonly lyrics: string }, MusicError> = Effect.fn("readStream")(function* readStream(
  body: string
) {
  const events = body.split("\n").flatMap((line) => (line.startsWith("data: ") ? [line.slice(6).trim()] : []))
  let audio = ""
  let lyrics = ""
  for (const event of events.filter((data) => data !== "[DONE]")) {
    const chunk = yield* decodeChunk(event).pipe(Effect.mapError((error) => new MusicError({ message: `unexpected OpenRouter chunk: ${error.message}` })))
    if (chunk.error) return yield* new MusicError({ message: `OpenRouter music failed: ${chunk.error.message}` })
    const delta = chunk.choices?.[0]?.delta
    audio += delta?.audio?.data ?? ""
    lyrics += delta?.content ?? ""
  }
  if (audio === "") return yield* new MusicError({ message: "OpenRouter music failed: the response had no audio" })
  return { audio: Buffer.from(audio, "base64"), lyrics: lyrics.trim() }
})

export class OpenRouterMusic extends Context.Service<
  OpenRouterMusic,
  MusicProvider
>()("cmotion/music/OpenRouterMusic") {
  static readonly layer = Layer.effect(
    OpenRouterMusic,
    Effect.gen(function* () {
      const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk)
      const keyring = yield* Keyring

      // Audio output only comes streamed; the whole stream is read, then parsed.
      const generate: (music: Music) => Effect.Effect<{ readonly audio: Uint8Array; readonly lyrics: string }, MusicError | CredentialsError> = Effect.fn(
        "OpenRouterMusic.generate"
      )(function* (music: Music) {
        const key = yield* OpenRouterKey.resolve.pipe(Effect.provideService(Keyring, keyring))
        const body = yield* HttpClientRequest.post("https://openrouter.ai/api/v1/chat/completions").pipe(
          HttpClientRequest.bearerToken(Redacted.value(key)),
          HttpClientRequest.bodyJsonUnsafe({
            model: music.model,
            messages: [{ role: "user", content: music.prompt }],
            modalities: ["text", "audio"],
            audio: { format: "mp3" },
            stream: true,
          }),
          client.execute,
          Effect.flatMap((response) => response.text),
          Effect.mapError((error) => new MusicError({ message: `OpenRouter music failed: ${error.message}` }))
        )
        return yield* readStream(body)
      })

      return OpenRouterMusic.of({ generate })
    })
  ).pipe(Layer.provide(FetchHttpClient.layer))
}

const GeminiResponse = Schema.Struct({
  status: Schema.String,
  steps: Schema.Array(Schema.Struct({
    type: Schema.String,
    content: Schema.optional(Schema.Array(Schema.Struct({
      type: Schema.String,
      data: Schema.optional(Schema.String),
      text: Schema.optional(Schema.String),
      mime_type: Schema.optional(Schema.String),
    }))),
  })),
})
const decodeGemini = Schema.decodeUnknownEffect(GeminiResponse)

export const readGemini: (body: Schema.Json) => Effect.Effect<GeneratedMusic, MusicError> = Effect.fn("readGemini")(function* (body: Schema.Json) {
  const response = yield* decodeGemini(body).pipe(Effect.mapError((error) => new MusicError({ message: `unexpected Gemini response: ${error.message}` })))
  if (response.status !== "completed") return yield* new MusicError({ message: `Gemini music did not complete: ${response.status}` })
  const blocks = response.steps.filter((step) => step.type === "model_output").flatMap((step) => step.content ?? [])
  const audio = blocks.filter((block) => block.type === "audio" && block.data)
  if (audio.length !== 1) return yield* new MusicError({ message: "Gemini music failed: expected one audio block" })
  const block = audio[0]!
  if (block.mime_type !== "audio/mpeg" && block.mime_type !== "audio/mp3") return yield* new MusicError({ message: `unexpected Gemini audio format: ${block.mime_type}` })
  const bytes = Buffer.from(block.data!, "base64")
  if (bytes.length === 0) return yield* new MusicError({ message: "Gemini music failed: empty audio" })
  return { audio: bytes, lyrics: blocks.filter((block) => block.type === "text").map((block) => block.text ?? "").join("\n").trim() }
})

export class GeminiMusic extends Context.Service<GeminiMusic, MusicProvider>()("cmotion/music/GeminiMusic") {
  static readonly layer = Layer.effect(GeminiMusic, Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const keyring = yield* Keyring
    const generate: (music: Music) => Effect.Effect<GeneratedMusic, MusicError | CredentialsError> = Effect.fn("GeminiMusic.generate")(function* (music: Music) {
      const key = yield* GeminiKey.resolve.pipe(Effect.provideService(Keyring, keyring))
      const body = yield* HttpClientRequest.post("https://generativelanguage.googleapis.com/v1beta/interactions").pipe(
        HttpClientRequest.setHeader("x-goog-api-key", Redacted.value(key)),
        HttpClientRequest.bodyJsonUnsafe({ model: music.model, input: music.prompt.trim() }),
        client.execute,
        Effect.flatMap((response) => Effect.gen(function* () {
          const body = yield* response.json
          if (response.status < 200 || response.status >= 300) {
            return yield* new MusicError({ message: `Gemini music failed (HTTP ${response.status}): ${JSON.stringify(body)}` })
          }
          return body
        })),
        Effect.mapError((error) => new MusicError({ message: `Gemini music failed: ${error.message}` }))
      )
      return yield* readGemini(body)
    })
    return GeminiMusic.of({ generate })
  })).pipe(Layer.provide(FetchHttpClient.layer))
}

// Consumers depend only on this service; provider keys are resolved lazily on generation.
export class MusicGeneration extends Context.Service<MusicGeneration, MusicProvider>()("cmotion/music/MusicGeneration") {
  static readonly layer = Layer.effect(MusicGeneration, Effect.gen(function* () {
    const openrouter = yield* OpenRouterMusic
    const gemini = yield* GeminiMusic
    return MusicGeneration.of({
      generate: (music) => (music.provider === "gemini" ? gemini : openrouter).generate(music),
    })
  }))
  static readonly live = MusicGeneration.layer.pipe(Layer.provide(Layer.merge(OpenRouterMusic.layer, GeminiMusic.layer)))
}

// The script's music in dir, generated only when its provider, prompt and model are new.
export const music: (music: Music, dir: string) => Effect.Effect<void, MusicError | CredentialsError, MusicGeneration | FileSystem.FileSystem> = Effect.fn("music")(
  function* music(music: Music, dir: string) {
    const fs = yield* FileSystem.FileSystem
    const key = musicKey(music)
    const audio = musicFile(dir, music)
    const meta = join(dir, `${key}.json`)
    const cached = (yield* fs.exists(audio).pipe(Effect.orElseSucceed(() => false))) && (yield* fs.exists(meta).pipe(Effect.orElseSucceed(() => false)))
    if (cached) return yield* Console.log("  music: cached")
    yield* Console.log(`  music: generating with ${music.model}`)
    const generated = yield* (yield* MusicGeneration).generate(music)
    yield* fs.makeDirectory(dir, { recursive: true }).pipe(
      Effect.andThen(fs.writeFile(audio, generated.audio)),
      Effect.andThen(fs.writeFileString(meta, JSON.stringify({ provider: music.provider, prompt: music.prompt.trim(), model: music.model, lyrics: generated.lyrics, audio: `${key}.mp3` }, null, 2))),
      Effect.mapError((error) => new MusicError({ message: `could not write the music: ${error.message}` }))
    )
  }
)
