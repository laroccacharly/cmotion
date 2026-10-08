// Voiceovers with ElevenLabs, kept in videos/VIDEO/generated/voiceover/<key>.{mp3,json} by text, voice, model and format.
import { join } from "node:path"
import { Console, Context, Effect, FileSystem, Layer, Redacted, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { type CredentialsError, Keyring } from "effect-lib/credentials"
import { ElevenLabsKey } from "./config.ts"
import { canonicalJson, sha } from "./key.ts"
import type { Scene, Script } from "./script.ts"
import { Voices } from "./voices.ts"

export interface Word {
  readonly text: string
  readonly start: number
  readonly end: number
}

const Alignment = Schema.Struct({
  characters: Schema.Array(Schema.String),
  character_start_times_seconds: Schema.Array(Schema.Finite),
  character_end_times_seconds: Schema.Array(Schema.Finite),
})

const Speech = Schema.Struct({ audio_base64: Schema.String, alignment: Alignment })

// Groups character timings into words. Audio tags like [sigh] count as words.
export const wordsFromAlignment = (alignment: typeof Alignment.Type): ReadonlyArray<Word> => {
  const words: Array<{ text: string; start: number; end: number }> = []
  let current = false
  alignment.characters.forEach((char, i) => {
    const start = alignment.character_start_times_seconds[i] ?? 0
    const end = alignment.character_end_times_seconds[i] ?? start
    const last = words.at(-1)
    if (/^\s$/u.test(char)) current = false
    else if (current && last) {
      last.text += char
      last.end = end
    } else {
      words.push({ text: char, start, end })
      current = true
    }
  })
  return words
}

const extension = (format: string) => ({ mp3: ".mp3", wav: ".wav", opus: ".opus" })[format.split("_")[0] ?? ""] ?? ".raw"

// Keyed by the voice ID, not its name, so renaming a voice keeps its cached voiceovers.
export const voiceoverKey = (script: Script, text: string): string => sha(canonicalJson({ text, voice: Voices[script.voice], model: script.model, format: script.output_format }))

export class VoiceoverError extends Schema.TaggedError<VoiceoverError>()("VoiceoverError", {
  message: Schema.String,
}) {}

export class ElevenLabs extends Context.Service<
  ElevenLabs,
  {
    speak(text: string, script: Script): Effect.Effect<{ readonly audio: Uint8Array; readonly words: ReadonlyArray<Word> }, VoiceoverError | CredentialsError>
  }
>()("cmotion/voiceover/ElevenLabs") {
  static readonly layer = Layer.effect(
    ElevenLabs,
    Effect.gen(function* () {
      const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk)
      const keyring = yield* Keyring

      const speak: (text: string, script: Script) => Effect.Effect<{ readonly audio: Uint8Array; readonly words: ReadonlyArray<Word> }, VoiceoverError | CredentialsError> = Effect.fn("ElevenLabs.speak")(function* (text: string, script: Script) {
        const key = yield* ElevenLabsKey.resolve.pipe(Effect.provideService(Keyring, keyring))
        const speech = yield* HttpClientRequest.post(`https://api.elevenlabs.io/v1/text-to-speech/${Voices[script.voice]}/with-timestamps`).pipe(
          HttpClientRequest.setHeader("xi-api-key", Redacted.value(key)),
          HttpClientRequest.setUrlParams({ output_format: script.output_format }),
          // v4 only takes stability and similarity; style, speed and SSML are not supported.
          HttpClientRequest.bodyJsonUnsafe({ text, model_id: script.model }),
          client.execute,
          Effect.flatMap(HttpClientResponse.schemaBodyJson(Speech)),
          Effect.mapError((error) => new VoiceoverError({ message: `ElevenLabs voiceover failed: ${error.message}` }))
        )
        return { audio: Buffer.from(speech.audio_base64, "base64"), words: wordsFromAlignment(speech.alignment) }
      })

      return ElevenLabs.of({ speak })
    })
  ).pipe(Layer.provide(FetchHttpClient.layer))
}

// The scene's voiceover in dir, generated only when this exact text is new.
export const voiceover: (
  script: Script,
  scene: Scene,
  dir: string
) => Effect.Effect<void, VoiceoverError | CredentialsError, ElevenLabs | FileSystem.FileSystem> = Effect.fn("voiceover")(function* voiceover(
  script: Script,
  scene: Scene,
  dir: string
) {
  const fs = yield* FileSystem.FileSystem
  const text = scene.voiceover.trim()
  const key = voiceoverKey(script, text)
  const audio = join(dir, `${key}${extension(script.output_format)}`)
  const timestamps = join(dir, `${key}.json`)
  const cached = (yield* fs.exists(audio).pipe(Effect.orElseSucceed(() => false))) && (yield* fs.exists(timestamps).pipe(Effect.orElseSucceed(() => false)))
  if (cached) return yield* Console.log(`  voice ${scene.id}: cached`)
  yield* Console.log(`  voice ${scene.id}: generating ${text.length} characters with ${script.model}`)
  const speech = yield* (yield* ElevenLabs).speak(text, script)
  const meta = { text, model: script.model, voice: Voices[script.voice], audio: `${key}${extension(script.output_format)}`, words: speech.words }
  yield* fs.makeDirectory(dir, { recursive: true }).pipe(
    Effect.andThen(fs.writeFile(audio, speech.audio)),
    Effect.andThen(fs.writeFileString(timestamps, JSON.stringify(meta, null, 2))),
    Effect.mapError((error) => new VoiceoverError({ message: `could not write the voiceover: ${error.message}` }))
  )
})
