import { describe, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer, Schema } from "effect"
import { imageKey } from "../ts/images.ts"
import { canonicalJson, sha } from "../ts/key.ts"
import { Script } from "../ts/script.ts"
import { ElevenLabs, voiceover, voiceoverKey, wordsFromAlignment } from "../ts/voiceover.ts"

const decodeScript = Schema.decodeUnknownSync(Script, { onExcessProperty: "error" })
const script = decodeScript({ title: "t", scenes: [{ id: "hook", title: "Hook", voiceover: "An agent wrote this function." }] })

describe("cache keys", () => {
  test("ignore key order and cover every value", () => {
    expect(sha(canonicalJson({ a: 1, b: { c: [1, { d: 2, e: 3 }] } }))).toBe(sha(canonicalJson({ b: { c: [1, { e: 3, d: 2 }] }, a: 1 })))
    expect(sha(canonicalJson({ a: 1, b: [1, 2] }))).not.toBe(sha(canonicalJson({ a: 1, b: [2, 1] })))
    expect(sha("same", new TextEncoder().encode("engine v1"))).not.toBe(sha("same", new TextEncoder().encode("engine v2")))
  })

  test("an image key covers the prompt, settings and model", () => {
    const image = { id: "a", prompt: "A café", size: "1536x864", quality: "high", transparent: true } as const
    expect(imageKey(image, "m")).toBe(imageKey({ ...image, id: "b" }, "m"))
    expect(imageKey(image, "m")).not.toBe(imageKey({ ...image, prompt: "A dog" }, "m"))
    expect(imageKey(image, "m")).not.toBe(imageKey({ ...image, transparent: false }, "m"))
    expect(imageKey(image, "m")).not.toBe(imageKey(image, "other"))
  })

  test("a voiceover key covers the text and the voice settings", () => {
    expect(voiceoverKey(script, "Hello.")).not.toBe(voiceoverKey(script, "Hello!"))
    expect(voiceoverKey(script, "Hello.")).not.toBe(voiceoverKey({ ...script, voice: "alice" }, "Hello."))
  })
})

describe("script", () => {
  test("fills in the defaults", () => {
    expect(script).toMatchObject({ voice: "george", model: "eleven_v4", lead_in: 0.4, tail: 0.6, subtitles: false })
    expect(script.scenes[0]).toMatchObject({ visual: "", images: [] })
  })

  test("rejects bad sizes, duplicate ids and unknown keys", () => {
    const scene = { id: "a", title: "A", voiceover: "Hi." }
    const image = (size: string) => ({ ...scene, images: [{ id: "x", prompt: "p", size }] })
    expect(() => decodeScript({ title: "t", scenes: [image("1000x864")] })).toThrow("divisible by 16")
    expect(() => decodeScript({ title: "t", scenes: [image("3840x864")] })).toThrow("aspect")
    expect(() => decodeScript({ title: "t", scenes: [scene, scene] })).toThrow("duplicate scene ids: a")
    expect(() => decodeScript({ title: "t", scenes: [{ ...scene, colour: "red" }] })).toThrow()
    expect(() => decodeScript({ title: "t", voice: "JBFqnCBsd6RMkjVDRZzb", scenes: [scene] })).toThrow()
  })

  test("an image is a prompt to generate or a file, not both", () => {
    const scene = (image: object) => ({ id: "a", title: "A", voiceover: "Hi.", images: [{ id: "x", ...image }] })
    expect(decodeScript({ title: "t", scenes: [scene({ file: "assets/x.png" })] }).scenes[0]?.images[0]).toEqual({ id: "x", file: "assets/x.png" })
    expect(() => decodeScript({ title: "t", scenes: [scene({ file: "assets/x.png", prompt: "p" })] })).toThrow()
    expect(() => decodeScript({ title: "t", scenes: [scene({})] })).toThrow()
  })
})

test("character timings group into words, audio tags included", () => {
  const characters = "[sigh] Hi, you.".split("")
  const alignment = {
    characters,
    character_start_times_seconds: characters.map((_, i) => i / 10),
    character_end_times_seconds: characters.map((_, i) => (i + 1) / 10),
  }
  expect(wordsFromAlignment(alignment)).toEqual([
    { text: "[sigh]", start: 0, end: 0.6 },
    { text: "Hi,", start: 0.7, end: 1 },
    { text: "you.", start: 1.1, end: 1.5 },
  ])
})

test("a voiceover is generated once, then read from the cache", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cmotion-voiceover-"))
  let calls = 0
  const fake = Layer.succeed(ElevenLabs)({
    speak: () => Effect.sync(() => (calls++, { audio: new Uint8Array([1, 2, 3]), words: [{ text: "An", start: 0, end: 0.2 }] })),
  })
  const scene = script.scenes[0]!
  const twice = Effect.all([voiceover(script, scene, dir), voiceover(script, scene, dir)]).pipe(Effect.provide(Layer.merge(fake, BunServices.layer)))
  await Effect.runPromise(twice)
  expect(calls).toBe(1)
  const key = voiceoverKey(script, scene.voiceover)
  expect(readdirSync(dir).sort()).toEqual([`${key}.json`, `${key}.mp3`])
  expect(JSON.parse(readFileSync(join(dir, `${key}.json`), "utf8"))).toMatchObject({ text: scene.voiceover, audio: `${key}.mp3` })
})
