// ElevenLabs text to speech: the audio and its character timings in one response.
import { Context, Effect, Layer, Redacted, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { type CredentialsError, Keyring } from "effect-lib/credentials"
import { ElevenLabsKey } from "../config.ts"
import { type ElevenLabsScript, type Spoken, type VoiceProvider, VoiceoverError, type Word } from "./provider.ts"

// ElevenLabs default voices, by the name a script uses for them. Every library voice works with eleven_v4.
// Listed from GET /v2/voices?voice_type=default. ElevenLabs retires these defaults on December 31, 2026.
export const Voices = {
  adam: "pNInz6obpgDQGcFmaJgB", // male, American: dominant, firm
  alice: "Xb7hH8MSUJpSbSDYk0k2", // female, British: clear, engaging educator
  bella: "hpp4J3VqNfWAUOO0d1Us", // female, American: professional, bright, warm
  bill: "pqHfZKP75CvOlQylNhV4", // male, American, old: wise, mature, balanced
  brian: "nPczCjzI2devNBz1zQrb", // male, American: deep, resonant, comforting
  callum: "N2lVS1w4EtoT3dr4eOWO", // male, American: husky trickster
  charlie: "IKne3meq5aSn9XLyUdCD", // male, Australian: deep, confident, energetic
  chris: "iP95p4xoKVk53GoZ742B", // male, American: charming, down-to-earth
  daniel: "onwK4e9ZLuTAKqWW03F9", // male, British: steady broadcaster
  eric: "cjVigY5qzO86Huf0OWal", // male, American: smooth, trustworthy
  george: "JBFqnCBsd6RMkjVDRZzb", // male, British: warm, captivating storyteller
  harry: "SOYHLrjzK2X1ezoPC6cr", // male, American: fierce warrior
  jessica: "cgSgspJ2msm6clMCkdW9", // female, American: playful, bright, warm
  laura: "FGY2WhTYpPnrIDTdsKH5", // female, American: enthusiast, quirky
  liam: "TX3LPaxmHKxFdv7VOQHJ", // male, American: energetic social media creator
  lily: "pFZP5JQG7iQjIQuC4Bku", // female, British: velvety actress
  matilda: "XrExE9yKIg1WjnnlVkGX", // female, American: knowledgeable, professional
  river: "SAz9YHcvj6GT2YYXdXww", // neutral, American: relaxed, informative
  roger: "CwhRBWXzGAHq8TQ4Fs17", // male, American: laid-back, casual, resonant
  sarah: "EXAVITQu4vr4xnSDxMaL", // female, American: mature, reassuring, confident
  will: "bIHbv24MWmeRgasZH58o", // male, American: relaxed optimist
} as const

export type Voice = keyof typeof Voices
export const voiceNames = Object.keys(Voices) as ReadonlyArray<Voice>

// The ElevenLabs with-timestamps response.
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

export class ElevenLabs extends Context.Service<ElevenLabs, VoiceProvider<ElevenLabsScript>>()("cmotion/voiceover/ElevenLabs") {
  static readonly layer = Layer.effect(
    ElevenLabs,
    Effect.gen(function* () {
      const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk)
      const keyring = yield* Keyring

      const speak: (text: string, script: ElevenLabsScript) => Effect.Effect<Spoken, VoiceoverError | CredentialsError> = Effect.fn("ElevenLabs.speak")(
        function* (text: string, script: ElevenLabsScript) {
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
        }
      )

      return ElevenLabs.of({ speak })
    })
  ).pipe(Layer.provide(FetchHttpClient.layer))
}
