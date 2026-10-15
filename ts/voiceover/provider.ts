// What every voiceover provider implements: speak a script's text, return the audio and the timing of each word.
import { type Effect, Schema } from "effect"
import type { CredentialsError } from "effect-lib/credentials"
import type { Script } from "../script.ts"

export interface Word {
  readonly text: string
  readonly start: number
  readonly end: number
}

export interface Spoken {
  readonly audio: Uint8Array
  readonly words: ReadonlyArray<Word>
}

// The script narrowed to each provider, so its voice and model fields are the provider's.
export type ElevenLabsScript = Extract<Script, { provider: "elevenlabs" }>
export type OpenRouterScript = Extract<Script, { provider: "openrouter" }>

export interface VoiceProvider<S extends Script = Script> {
  speak(text: string, script: S): Effect.Effect<Spoken, VoiceoverError | CredentialsError>
}

export class VoiceoverError extends Schema.TaggedError<VoiceoverError>()("VoiceoverError", {
  message: Schema.String,
}) {}
