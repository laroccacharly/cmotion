// Voiceovers with ElevenLabs or OpenRouter, kept in videos/VIDEO/generated/voiceover/<key>.{mp3,json} by text, voice, model and format.
import { join } from "node:path"
import { Console, Context, Effect, FileSystem, Layer } from "effect"
import type { CredentialsError } from "effect-lib/credentials"
import { canonicalJson, sha } from "../key.ts"
import type { Scene, Script } from "../script.ts"
import { ElevenLabs, Voices } from "./elevenlabs.ts"
import { FishVoices, OpenRouterSpeech } from "./openrouter.ts"
import { type VoiceProvider, VoiceoverError } from "./provider.ts"

export { ElevenLabs, wordsFromAlignment } from "./elevenlabs.ts"
export { OpenRouterSpeech } from "./openrouter.ts"
export type { Spoken, VoiceProvider, Word } from "./provider.ts"
export { VoiceoverError } from "./provider.ts"

const extension = (format: string) => ({ mp3: ".mp3", wav: ".wav", opus: ".opus" })[format.split("_")[0] ?? ""] ?? ".raw"

// ElevenLabs voices by their id, not their name, so renaming a voice keeps its cached voiceovers.
const voiceId = (script: Script): string => (script.provider === "elevenlabs" ? Voices[script.voice] : FishVoices[script.voice])

// Keep existing ElevenLabs cache keys; OpenRouter generations have their own namespace.
export const voiceoverKey = (script: Script, text: string): string =>
  sha(
    canonicalJson({
      text,
      voice: voiceId(script),
      model: script.model,
      format: script.output_format,
      ...(script.provider === "openrouter" ? { provider: script.provider } : {}),
    })
  )

// Consumers depend only on this service; provider keys are resolved lazily on generation.
export class Voiceover extends Context.Service<Voiceover, VoiceProvider>()("cmotion/voiceover/Voiceover") {
  static readonly layer = Layer.effect(
    Voiceover,
    Effect.gen(function* () {
      const elevenlabs = yield* ElevenLabs
      const openrouter = yield* OpenRouterSpeech
      return Voiceover.of({
        speak: (text, script) => (script.provider === "elevenlabs" ? elevenlabs.speak(text, script) : openrouter.speak(text, script)),
      })
    })
  )
  static readonly live = Voiceover.layer.pipe(Layer.provide(Layer.merge(ElevenLabs.layer, OpenRouterSpeech.layer)))
}

// The scene's voiceover in dir, generated only when this exact text is new.
export const voiceover: (
  script: Script,
  scene: Scene,
  dir: string
) => Effect.Effect<void, VoiceoverError | CredentialsError, Voiceover | FileSystem.FileSystem> = Effect.fn("voiceover")(function* voiceover(
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
  const speech = yield* (yield* Voiceover).speak(text, script)
  const meta = { provider: script.provider, text, model: script.model, voice: voiceId(script), audio: `${key}${extension(script.output_format)}`, words: speech.words }
  yield* fs.makeDirectory(dir, { recursive: true }).pipe(
    Effect.andThen(fs.writeFile(audio, speech.audio)),
    Effect.andThen(fs.writeFileString(timestamps, JSON.stringify(meta, null, 2))),
    Effect.mapError((error) => new VoiceoverError({ message: `could not write the voiceover: ${error.message}` }))
  )
})
