// Speech to text with ElevenLabs Scribe: an audio file in, the text and its word timings out.
//
// The output is `{ text, language, duration, words }`, its words in the same `{ text, start, end }`
// shape as voiceover timings, plus `speaker` when diarizing.
import { basename, dirname, extname, join } from "node:path"
import { Console, Context, Effect, FileSystem, Layer, Option, Redacted, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { type CredentialsError, Keyring } from "effect-lib/credentials"
import { ElevenLabsKey } from "./config.ts"
import type { Word } from "./voiceover/index.ts"

export const SCRIBE_URL = "https://api.elevenlabs.io/v1/speech-to-text"
// Scribe v2 handles real recordings and audio events, and gives per-word timings.
export const SCRIBE_MODEL = "scribe_v2"

// One token of the Scribe response: real words, spacing and audio events like [laughs].
const ScribeWord = Schema.Struct({
  text: Schema.String,
  start: Schema.optional(Schema.Finite),
  end: Schema.optional(Schema.Finite),
  type: Schema.optional(Schema.String),
  speaker_id: Schema.optional(Schema.String),
})

const Scribe = Schema.Struct({
  text: Schema.String,
  language_code: Schema.optional(Schema.String),
  audio_duration_secs: Schema.optional(Schema.Finite),
  words: Schema.Array(ScribeWord),
})

// A voiceover word, labelled with its speaker when diarizing.
export interface TranscriptWord extends Word {
  readonly speaker?: string
}

// The Scribe response fields we keep.
export interface Transcript {
  readonly text: string
  readonly language: string
  readonly duration: number
  readonly words: ReadonlyArray<TranscriptWord>
}

// Spacing carries no word, so it is dropped; audio events stay as bracketed words, like a
// voiceover's [sigh]. Tokens the model could not time are dropped, so every word has a start.
export const wordsFromScribe: (words: ReadonlyArray<typeof ScribeWord.Type>, diarize: boolean) => ReadonlyArray<TranscriptWord> = (words, diarize) =>
  words.flatMap((word) => {
    if (word.type === "spacing" || word.start === undefined || word.end === undefined) return []
    const text = word.text.trim()
    if (text === "") return []
    const speaker = diarize && word.speaker_id !== undefined ? { speaker: word.speaker_id } : {}
    return [{ text: word.type === "audio_event" ? `[${text}]` : text, start: word.start, end: word.end, ...speaker }]
  })

export class TranscribeError extends Schema.TaggedError<TranscribeError>()("TranscribeError", {
  message: Schema.String,
}) {}

export interface TranscribeOptions {
  // Spoken language; Scribe detects it when unset.
  readonly language: Option.Option<string>
  // Label words with their speaker.
  readonly diarize: boolean
  // Expected speakers when diarizing; Scribe guesses when unset.
  readonly speakers: Option.Option<number>
}

export class SpeechToText extends Context.Service<
  SpeechToText,
  {
    transcribe(audio: Uint8Array, name: string, options: TranscribeOptions): Effect.Effect<Transcript, TranscribeError | CredentialsError>
  }
>()("cmotion/transcribe/SpeechToText") {
  static readonly layer = Layer.effect(
    SpeechToText,
    Effect.gen(function* () {
      const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk)
      const keyring = yield* Keyring

      const transcribe: (audio: Uint8Array, name: string, options: TranscribeOptions) => Effect.Effect<Transcript, TranscribeError | CredentialsError> = Effect.fn(
        "SpeechToText.transcribe"
      )(function* (audio: Uint8Array, name: string, options: TranscribeOptions) {
        const key = yield* ElevenLabsKey.resolve.pipe(Effect.provideService(Keyring, keyring))
        const form = new FormData()
        form.set("file", new File([audio as Uint8Array<ArrayBuffer>], name, { type: mimeType(name) }))
        form.set("model_id", SCRIBE_MODEL)
        form.set("timestamps_granularity", "word")
        if (Option.isSome(options.language)) form.set("language_code", options.language.value)
        if (options.diarize) {
          form.set("diarize", "true")
          if (Option.isSome(options.speakers)) form.set("num_speakers", String(options.speakers.value))
        }
        // Keep [laughs] and the like, as a voiceover's audio tags are kept.
        form.set("tag_audio_events", "true")
        const decoded = yield* HttpClientRequest.post(SCRIBE_URL).pipe(
          HttpClientRequest.setHeader("xi-api-key", Redacted.value(key)),
          HttpClientRequest.bodyFormData(form),
          client.execute,
          Effect.flatMap(HttpClientResponse.schemaBodyJson(Scribe)),
          Effect.mapError((error) => new TranscribeError({ message: `ElevenLabs Scribe failed: ${error.message}` }))
        )
        return {
          text: decoded.text,
          language: decoded.language_code ?? Option.getOrElse(options.language, () => ""),
          duration: decoded.audio_duration_secs ?? (decoded.words.at(-1)?.end ?? 0),
          words: wordsFromScribe(decoded.words, options.diarize),
        }
      })

      return SpeechToText.of({ transcribe })
    })
  ).pipe(Layer.provide(FetchHttpClient.layer))
}

// The content type of the upload, from the file's extension; Scribe also reads the bytes.
const mimeType = (name: string) =>
  ({
    ".mp3": "audio/mpeg",
    ".m4a": "audio/mp4",
    ".mp4": "video/mp4",
    ".wav": "audio/wav",
    ".ogg": "audio/ogg",
    ".opus": "audio/opus",
    ".flac": "audio/flac",
    ".webm": "audio/webm",
    ".aac": "audio/aac",
  })[extname(name).toLowerCase()] ?? "application/octet-stream"

// The JSON path next to the audio: clip.mp3 -> clip.json.
export const transcriptFile = (audio: string): string => join(dirname(audio), `${basename(audio, extname(audio))}.json`)

// Transcribes audio with ElevenLabs Scribe and writes the transcript to out. A transcript already
// at out is kept, as it was paid for, unless force is set.
export const transcribe: (
  audio: string,
  out: string,
  options: TranscribeOptions,
  force?: boolean
) => Effect.Effect<void, TranscribeError | CredentialsError, SpeechToText | FileSystem.FileSystem> = Effect.fn("transcribe")(function* transcribe(
  audio: string,
  out: string,
  options: TranscribeOptions,
  force = false
) {
  const fs = yield* FileSystem.FileSystem
  if (!force && (yield* fs.exists(out).pipe(Effect.orElseSucceed(() => false)))) {
    return yield* Console.log(`  transcribe: ${out} exists, cached (--force to redo)`)
  }
  const bytes = yield* fs
    .readFile(audio)
    .pipe(Effect.mapError((error) => new TranscribeError({ message: `could not read ${audio}: ${error.message}` })))
  const name = basename(audio)
  yield* Console.log(`  transcribe: ${name} (${(bytes.length / 1024 / 1024).toFixed(1)} MB) with ${SCRIBE_MODEL}`)
  const transcript = yield* (yield* SpeechToText).transcribe(bytes, name, options)
  yield* fs.makeDirectory(dirname(out), { recursive: true }).pipe(
    Effect.andThen(fs.writeFileString(out, `${JSON.stringify(transcript, null, 2)}\n`)),
    Effect.mapError((error) => new TranscribeError({ message: `could not write ${out}: ${error.message}` }))
  )
  yield* Console.log(`  saved: ${out} (${transcript.words.length} words, ${transcript.duration.toFixed(1)}s)`)
})
