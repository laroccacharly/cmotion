import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer, Option } from "effect"
import { SpeechToText, transcribe, transcriptFile, wordsFromScribe } from "../ts/transcribe.ts"

test("Scribe tokens become words: spacing and untimed tokens are dropped, audio events are bracketed", () => {
  const words = wordsFromScribe([
    { text: "Hey,", start: 0.1, end: 0.4, type: "word" },
    { text: " ", start: 0.4, end: 0.5, type: "spacing" },
    { text: "there", start: 0.5, end: 0.9, type: "word" },
    { text: "laughs", start: 1.0, end: 1.4, type: "audio_event" },
    { text: "mid", type: "word" },
    { text: "   ", start: 1.5, end: 1.6, type: "word" },
  ], false)
  expect(words).toEqual([
    { text: "Hey,", start: 0.1, end: 0.4 },
    { text: "there", start: 0.5, end: 0.9 },
    { text: "[laughs]", start: 1.0, end: 1.4 },
  ])
})

test("diarized words keep their speaker, and only when diarizing", () => {
  const scribe = [
    { text: "Hi", start: 0, end: 0.2, type: "word", speaker_id: "speaker_0" },
    { text: "yo", start: 0.3, end: 0.5, type: "word", speaker_id: "speaker_1" },
  ]
  expect(wordsFromScribe(scribe, true)).toEqual([
    { text: "Hi", start: 0, end: 0.2, speaker: "speaker_0" },
    { text: "yo", start: 0.3, end: 0.5, speaker: "speaker_1" },
  ])
  expect(wordsFromScribe(scribe, false)).toEqual([
    { text: "Hi", start: 0, end: 0.2 },
    { text: "yo", start: 0.3, end: 0.5 },
  ])
})

test("the transcript sits next to the audio, keeping the folder", () => {
  expect(transcriptFile("/tmp/clip.mp3")).toBe("/tmp/clip.json")
  expect(transcriptFile("take.m4a")).toBe("take.json")
  expect(transcriptFile("a.b/c.webm")).toBe("a.b/c.json")
})

test("transcribe reads the audio once and writes the words to the JSON", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cmotion-transcribe-"))
  const audio = join(dir, "take.mp3")
  writeFileSync(audio, "ID3 fake audio")
  let calls = 0
  const fake = Layer.succeed(SpeechToText)({
    transcribe: (bytes, name, options) =>
      Effect.sync(() => {
        calls++
        expect([Buffer.from(bytes).toString(), name, options]).toEqual(["ID3 fake audio", "take.mp3", { language: Option.some("en"), diarize: false, speakers: Option.none() }])
        return { text: "Hello there.", language: "en", duration: 1.2, words: [{ text: "Hello", start: 0.1, end: 0.4 }, { text: "there.", start: 0.4, end: 0.9 }] }
      }),
  })
  const out = join(dir, "take.json")
  await Effect.runPromise(transcribe(audio, out, { language: Option.some("en"), diarize: false, speakers: Option.none() }).pipe(Effect.provide(Layer.merge(fake, BunServices.layer))))
  expect(calls).toBe(1)
  expect(JSON.parse(readFileSync(out, "utf8"))).toEqual({
    text: "Hello there.",
    language: "en",
    duration: 1.2,
    words: [{ text: "Hello", start: 0.1, end: 0.4 }, { text: "there.", start: 0.4, end: 0.9 }],
  })
})

test("an existing transcript is kept unless forced, as it was paid for", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cmotion-transcribe-"))
  const audio = join(dir, "take.mp3")
  const out = join(dir, "take.json")
  writeFileSync(audio, "ID3 fake audio")
  writeFileSync(out, "{}")
  let calls = 0
  const fake = Layer.succeed(SpeechToText)({
    transcribe: () =>
      Effect.sync(() => {
        calls++
        return { text: "", language: "en", duration: 0, words: [] }
      }),
  })
  const run = (force: boolean) => Effect.runPromise(transcribe(audio, out, { language: Option.none(), diarize: false, speakers: Option.none() }, force).pipe(Effect.provide(Layer.merge(fake, BunServices.layer))))
  await run(false)
  expect([calls, readFileSync(out, "utf8")]).toEqual([0, "{}"])
  await run(true)
  expect(calls).toBe(1)
})
