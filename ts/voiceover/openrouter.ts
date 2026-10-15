// OpenRouter text to speech with Fish Audio's Drama 3. It returns audio only, so the words come from transcribing it
// with ElevenLabs Scribe, which needs an ElevenLabs key as well as the OpenRouter one.
import { Context, Effect, Layer, Option, Redacted } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import { type CredentialsError, Keyring } from "effect-lib/credentials"
import { OpenRouterKey } from "../config.ts"
import { SpeechToText } from "../transcribe.ts"
import { type OpenRouterScript, type Spoken, type VoiceProvider, VoiceoverError } from "./provider.ts"

// Fish Audio voices for OpenRouter's fish-audio/drama-3, by the name a script uses for them.
// The English voices of the "Fish Official" account, listed from GET https://api.fish.audio/model?author_id=d8b0991f96b44e489422ca2ddf0bd31d.
export const FishVoices = {
  abel: "8634617958764b539e0cdd5eb6c7723e", // male, American: warm
  adrian: "bf322df2096a46f18c579d0baa36f41d", // male, middle-aged: deep, measured narrator
  briony: "10b2254869cf4340bdb801928e2fc88e", // female, British: enthusiastic storyteller
  callum: "264f4b16b61a4d63b00c5959ed55dbb9", // male, British: calm educator
  chloe: "b121b91872f54f04ba9f6da08b8b6253", // female, Australian: brisk, professional
  delia: "c70cfb98867a4bfb9ae20d2401257b92", // female, American: confident
  ethan: "536d3a5e000945adb7038665781a4aca", // male, middle-aged: calm, clear explainer
  freya: "8abfa9ebd4c24a3399b68c3cdac8c7b5", // female, British: brisk, professional
  grant: "e041d483a7b54d96a6b91676468b304b", // male, American: polished
  hannah: "9a9cf47702da476aa4629e2506d4a857", // female, middle-aged: confident, clear
  harper: "c250136a9ec74cc0b799be54664a83f2", // female, American: brisk, professional
  hollis: "f1c025d3f1ce4018a26b47948c1e172b", // male, American: warm narrator
  imogen: "97658b3f0c3b48c99384bcd50851db3d", // female, British: clear, informative
  jack: "a92fb82d739d428a80d4645c5cf91e38", // male, Australian: brisk, professional
  jordan: "79d0bd3e4e5444b18f7b6d89b5927bf1", // male, old: measured motivational speaker
  laura: "e3cd384158934cc9a01029cd7d278634", // female, middle-aged: warm, deep narrator
  marion: "15259c52cf5d41c28ea4394080e5e593", // female, American: calm
  mason: "02e950ce577d4f008a2dfb4782789a3a", // male, American: brisk, professional
  oliver: "8d8aec63a56c460cb7def795bdf754fa", // male, British: brisk, professional
  reagan: "824e22ab26494b0b807afd3b3b709d89", // female, American: natural narrator
  richard: "fbc1029c018041d4b17f2c1e57222dff", // male, British: storyteller
  rupert: "f83f2e43d24b4bccb3bd3a63a950aa93", // male, British: composed
  sarah: "933563129e564b19a115bedd57b7406a", // female, young: soft, conversational
  sawyer: "fa4c9eb3dccc4806b382b40d61c6b10a", // male, American: natural narrator
  selene: "b347db033a6549378b48d00acb0d06cd", // female, middle-aged: calm, meditative
  sheila: "f3a2b90078d54a65af4b95f63bc7798e", // female, American, young
  sloane: "3f6a61eb4d084459b75c67d93810b61f", // female, American: warm narrator
} as const

export type FishVoice = keyof typeof FishVoices
export const fishVoiceNames = Object.keys(FishVoices) as ReadonlyArray<FishVoice>

export class OpenRouterSpeech extends Context.Service<OpenRouterSpeech, VoiceProvider<OpenRouterScript>>()("cmotion/voiceover/OpenRouterSpeech") {
  static readonly layer = Layer.effect(
    OpenRouterSpeech,
    Effect.gen(function* () {
      const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk)
      const keyring = yield* Keyring
      const speechToText = yield* SpeechToText

      const speak: (text: string, script: OpenRouterScript) => Effect.Effect<Spoken, VoiceoverError | CredentialsError> = Effect.fn("OpenRouterSpeech.speak")(
        function* (text: string, script: OpenRouterScript) {
          const key = yield* OpenRouterKey.resolve.pipe(Effect.provideService(Keyring, keyring))
          const audio = yield* HttpClientRequest.post("https://openrouter.ai/api/v1/audio/speech").pipe(
            HttpClientRequest.bearerToken(Redacted.value(key)),
            HttpClientRequest.bodyJsonUnsafe({
              model: script.model,
              input: text,
              voice: FishVoices[script.voice],
              response_format: script.output_format,
            }),
            client.execute,
            Effect.flatMap((response) => response.arrayBuffer),
            Effect.map((buffer) => new Uint8Array(buffer)),
            Effect.mapError((error) => new VoiceoverError({ message: `OpenRouter voiceover failed: ${error.message}` }))
          )
          const transcript = yield* speechToText
            .transcribe(audio, `voiceover.${script.output_format}`, { language: Option.none(), diarize: false, speakers: Option.none() })
            .pipe(Effect.catchTag("TranscribeError", (error) => new VoiceoverError({ message: `OpenRouter voiceover transcription failed: ${error.message}` })))
          return { audio, words: transcript.words }
        }
      )

      return OpenRouterSpeech.of({ speak })
    })
  ).pipe(Layer.provide(FetchHttpClient.layer))
}
