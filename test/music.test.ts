import { expect, test } from "bun:test"
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Exit, Layer, Schema } from "effect"
import { joinScenes } from "../ts/build.ts"
import { music, musicKey, MusicGeneration, GeminiMusic, OpenRouterMusic, readGemini, readStream } from "../ts/music.ts"
import { Script } from "../ts/script.ts"

const decodeScript = Schema.decodeUnknownSync(Script, { onExcessProperty: "error" })
const scene = { id: "hook", title: "Hook", voiceover: "Hi." }

const event = (delta: object) => `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`

test("music defaults to a quiet full Lyria 3 song and is optional", () => {
  expect(decodeScript({ title: "t", scenes: [scene] }).music).toBeUndefined()
  expect(decodeScript({ title: "t", music: { prompt: "lo-fi" }, scenes: [scene] }).music).toEqual({ provider: "openrouter", prompt: "lo-fi", model: "google/lyria-3-pro-preview", volume: 0.15 })
  expect(() => decodeScript({ title: "t", music: { prompt: "lo-fi", volume: 2 }, scenes: [scene] })).toThrow()
  expect(() => decodeScript({ title: "t", music: { prompt: "lo-fi", model: "suno" }, scenes: [scene] })).toThrow()
})

test("a music key covers the prompt and model, not the volume", () => {
  const m = { provider: "openrouter", prompt: "lo-fi", model: "google/lyria-3-clip-preview", volume: 0.15 } as const
  expect(musicKey(m)).toBe(musicKey({ ...m, prompt: " lo-fi ", volume: 0.5 }))
  expect(musicKey(m)).not.toBe(musicKey({ ...m, model: "google/lyria-3-pro-preview" }))
})

test("an OpenRouter stream gives the audio and lyrics, or its error", async () => {
  const mp3 = Buffer.from("ID3 fake mp3")
  const body =
    event({ content: "<instrumental>", role: "assistant" }) +
    ": OPENROUTER PROCESSING\n\n" +
    event({ content: "", audio: { data: mp3.subarray(0, 6).toString("base64") } }) +
    event({ audio: { data: mp3.subarray(6).toString("base64") } }) +
    "data: [DONE]\n\n"
  const generated = await Effect.runPromise(readStream(body))
  expect([Buffer.from(generated.audio).toString(), generated.lyrics]).toEqual(["ID3 fake mp3", "<instrumental>"])
  const failed = await Effect.runPromiseExit(readStream(`${event({ content: "x" })}data: ${JSON.stringify({ error: { message: "quota" } })}\n\n`))
  expect(Exit.isFailure(failed) && String(failed.cause)).toContain("quota")
  expect(Exit.isFailure(await Effect.runPromiseExit(readStream(event({ content: "no audio" }))))).toBe(true)
})

test("music is generated once, then read from the cache", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cmotion-music-"))
  let calls = 0
  const fake = Layer.succeed(MusicGeneration)({ generate: () => Effect.sync(() => (calls++, { audio: new Uint8Array([1, 2, 3]), lyrics: "<instrumental>" })) })
  const m = { provider: "openrouter", prompt: "lo-fi", model: "google/lyria-3-clip-preview", volume: 0.15 } as const
  await Effect.runPromise(Effect.all([music(m, dir), music(m, dir)]).pipe(Effect.provide(Layer.merge(fake, BunServices.layer))))
  expect(calls).toBe(1)
  const key = musicKey(m)
  expect(readdirSync(dir).sort()).toEqual([`${key}.json`, `${key}.mp3`])
  expect(JSON.parse(readFileSync(join(dir, `${key}.json`), "utf8"))).toMatchObject({ prompt: "lo-fi", lyrics: "<instrumental>", audio: `${key}.mp3` })
})

test("Gemini scripts default to Lyria 3.5 and reject mismatched provider models", () => {
  expect(decodeScript({ title: "t", scenes: [scene], music: { provider: "gemini", prompt: "piano" } }).music)
    .toEqual({ provider: "gemini", prompt: "piano", model: "lyria-3.5", volume: 0.15 })
  for (const music of [
    { provider: "gemini", model: "google/lyria-3-pro-preview", prompt: "piano" },
    { provider: "openrouter", model: "lyria-3.5", prompt: "piano" },
    { provider: "unknown", prompt: "piano" },
  ]) expect(() => decodeScript({ title: "t", scenes: [scene], music })).toThrow()
})

test("Gemini parses interleaved audio and text and rejects missing or unsupported audio", async () => {
  const audio = { type: "audio", mime_type: "audio/mpeg", data: Buffer.from("ID3 fake mp3").toString("base64") }
  const response = (content: Array<Schema.Json>, status = "completed") => ({ status, steps: [{ type: "model_output", content }] })
  const generated = await Effect.runPromise(readGemini(response([audio, { type: "text", text: " instrumental " }])))
  expect(Buffer.from(generated.audio).toString()).toBe("ID3 fake mp3")
  expect(generated.lyrics).toBe("instrumental")
  for (const body of [
    {}, response([]), response([audio], "failed"),
    response([{ ...audio, mime_type: "audio/wav" }]), response([{ ...audio, data: "" }]),
  ]) expect(Exit.isFailure(await Effect.runPromiseExit(readGemini(body)))).toBe(true)
})

test("MusicGeneration routes to the selected provider without generating with the other", async () => {
  const calls: Array<string> = []
  const fake = (provider: string) => ({ generate: () => Effect.sync(() => {
    calls.push(provider)
    return { audio: new Uint8Array([1]), lyrics: provider }
  }) })
  const routing = MusicGeneration.layer.pipe(Layer.provide(Layer.merge(Layer.succeed(OpenRouterMusic)(fake("openrouter")), Layer.succeed(GeminiMusic)(fake("gemini")))))
  await Effect.runPromise(Effect.gen(function* () {
    const service = yield* MusicGeneration
    yield* service.generate({ provider: "gemini", prompt: "piano", model: "lyria-3.5", volume: 0.15 })
    yield* service.generate({ provider: "openrouter", prompt: "piano", model: "google/lyria-3-pro-preview", volume: 0.15 })
  }).pipe(Effect.provide(routing)))
  expect(calls).toEqual(["gemini", "openrouter"])
})

const ffmpeg = (...args: Array<string>) => {
  const run = Bun.spawnSync(["ffmpeg", "-v", "error", "-y", ...args])
  if (run.exitCode !== 0) throw new Error(run.stderr.toString())
}
const probe = (file: string, entries: string) =>
  Bun.spawnSync(["ffprobe", "-v", "error", "-show_entries", entries, "-of", "csv=p=0", file]).stdout.toString().trim()

test("the joined video carries the music to its end, a short track repeated, under the voiceover", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cmotion-mix-"))
  const ids = ["a", "b"]
  for (const id of ids) {
    ffmpeg("-f", "lavfi", "-i", "color=black:s=64x36:r=30:d=4", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-t", "4", "-c:v", "libx264", "-c:a", "aac", "-shortest", join(dir, `${id}.mp4`))
  }
  // A three-second tune, so it has to repeat to cover the eight-second video.
  ffmpeg("-f", "lavfi", "-i", "sine=f=440:r=44100:d=3", join(dir, "music.mp3"))
  const renderJson = join(dir, "render.json")
  writeFileSync(renderJson, JSON.stringify({ width: 64, height: 36, fps: 30, scenes: ids.map((id) => ({ id, duration: 4 })) }))
  const join_ = (out: string, background?: { file: string; volume: number; key: string }) =>
    joinScenes(renderJson, dir, ["k1", "k2"], join(dir, out), join(dir, `${out}.key`), background).pipe(Effect.provide(BunServices.layer), Effect.runPromise)

  await join_("plain.mp4")
  await join_("music.mp4", { file: join(dir, "music.mp3"), volume: 0.5, key: "m" })
  expect(readFileSync(join(dir, "plain.mp4.key"), "utf8")).not.toBe(readFileSync(join(dir, "music.mp4.key"), "utf8"))
  expect(Number(probe(join(dir, "music.mp4"), "format=duration"))).toBeCloseTo(8, 1)
  // Mean volume of each half second between the fade in and the fade out: silent without music, audible all through with it.
  const loud = (file: string, at: number) => {
    const run = Bun.spawnSync(["ffmpeg", "-ss", String(at), "-t", "0.5", "-i", join(dir, file), "-af", "volumedetect", "-f", "null", "-"])
    return Number(/mean_volume: (-?[\d.]+|-inf) dB/u.exec(run.stderr.toString())?.[1] ?? "-inf")
  }
  const windows = [1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5]
  expect(Math.max(...windows.map((at) => loud("plain.mp4", at)))).toBeLessThan(-80)
  expect(Math.min(...windows.map((at) => loud("music.mp4", at)))).toBeGreaterThan(-40)
})
