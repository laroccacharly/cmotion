// Counters must draw the same glyphs and alignment as ordinary text, at the beginning, middle and end of a tween.
import { expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { counter, type Style, Timeline } from "../ts/dsl.ts"
import { Engine } from "../ts/engine.ts"

const crop = (file: string, x: number): Buffer => {
  const result = Bun.spawnSync(["ffmpeg", "-v", "error", "-i", file, "-vf", `crop=400:80:${x}:40`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"])
  expect(result.exitCode).toBe(0)
  return Buffer.from(result.stdout)
}

test("a counter formats and aligns its tweened value like static text", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cmotion-counter-"))
  const style = { id: "number", x: 20, y: 40, w: 400, font: "mono-600", size: 32, textAlign: "end" } satisfies Style
  const node = counter(0, { prefix: "$", suffix: "%", decimals: 2 }, style, "$1,234.50%")
  const tl = new Timeline().to("number", { value: 1234.5 }, 0, { duration: 1, ease: "none" })
  const samples = [[0, "$0.00%"], [0.5, "$617.25%"], [1, "$1,234.50%"]] as const
  const scenes = samples.map(([at, want], i) => ({
    id: `sample-${i}`, duration: 2,
    background: { inner: [0, 0, 0, 1], outer: [0, 0, 0, 1] },
    root: { type: "box", w: 960, h: 192, color: [1, 1, 1, 1], children: [
      { type: node.type, ...node.style, spans: node.spans, children: [] },
      { type: "text", ...style, id: "reference", x: 500, spans: [{ text: want }], children: [] },
    ] },
    tweens: tl.tweens,
    at,
  }))
  const json = join(dir, "render.json")
  writeFileSync(json, JSON.stringify({ width: 960, height: 192, fps: 30, scenes }))
  await Effect.runPromise(Effect.gen(function* () {
    const engine = yield* Engine
    for (const scene of scenes) {
      const file = join(dir, `${scene.id}.png`)
      yield* engine.still(json, `${scene.id}:${scene.at}`, file)
      const rendered = crop(file, 20)
      expect(rendered.equals(crop(file, 500))).toBe(true)
      expect(rendered.some((byte) => byte > 128)).toBe(true)
    }
  }).pipe(Effect.provide(Engine.layer.pipe(Layer.provideMerge(BunServices.layer)))))
}, 30_000)
