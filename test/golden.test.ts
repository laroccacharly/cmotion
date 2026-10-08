// Golden test for the renderer: the fixture's hook scene (TypeScript and a generated voiceover) must render close to the
// committed hook.golden.mp4. Frames may differ by encoder noise and anti-aliasing, not by a missing, moved or recolored
// element: in every frame, at most MAX_CHANGED of the pixels may differ by more than THRESHOLD levels in any plane.
// SSIM is too forgiving for this: a missing 150px glyph keeps it above 0.999. The audio must match exactly.
// Run with CMOTION_UPDATE_GOLDEN=1 to accept a new output.
import { expect, test } from "bun:test"
import { copyFileSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { packageDir } from "../ts/config.ts"
import { Engine } from "../ts/engine.ts"
import { renderFile } from "../ts/layout.ts"
import { run } from "../ts/process.ts"

const fixture = join(import.meta.dir, "fixtures", "hook")
const golden = join(fixture, "hook.golden.mp4")
// Re-encoding at CRF 28 changes at most 0.007% of pixels by more than 32 levels; removing the "?" mark changes 0.16%.
const THRESHOLD = 32
const MAX_CHANGED = 0.0005

const renderHook = Effect.gen(function* () {
  const dir = mkdtempSync(join(tmpdir(), "cmotion-golden-"))
  const out = join(dir, "hook.mp4")
  // Writes the fixture's build/render.json, which git ignores.
  yield* run("compile", process.execPath, [join(packageDir, "ts", "compile.ts"), fixture])
  yield* (yield* Engine).render(renderFile(fixture), "hook", out, { preset: "veryfast", crf: 18 })
  return out
})

// Per frame, the share of pixels whose difference exceeds THRESHOLD in the Y, U or V plane (the largest of the three).
const changedPixels = (a: string, b: string) =>
  run("compare", "ffmpeg", [
    "-v", "error", "-i", a, "-i", b, "-lavfi",
    `[0:v][1:v]blend=all_mode=difference,lutyuv=${["y", "u", "v"].map((p) => `${p}='gt(val,${THRESHOLD})*255'`).join(":")},signalstats,metadata=print:file=-`,
    "-f", "null", "-",
  ]).pipe(
    Effect.map((stats) => {
      const frames: Array<number> = []
      let planes: Array<number> = []
      for (const [, key, value] of stats.matchAll(/lavfi\.signalstats\.([YUV]AVG)=([\d.]+)/g)) {
        planes.push(Number(value) / 255)
        if (key === "VAVG") {
          frames.push(Math.max(...planes))
          planes = []
        }
      }
      return frames
    })
  )

const audioSums = (file: string) => run("audio", "ffmpeg", ["-v", "error", "-i", file, "-map", "0:a", "-fflags", "+bitexact", "-f", "framemd5", "-"])
const frameCount = (file: string) =>
  run("frames", "ffprobe", ["-v", "error", "-count_frames", "-select_streams", "v", "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", file]).pipe(
    Effect.map((count) => Number(count.trim()))
  )

const check = Effect.gen(function* () {
  const out = yield* renderHook
  if (process.env["CMOTION_UPDATE_GOLDEN"]) copyFileSync(out, golden)
  return {
    out,
    frames: [yield* frameCount(golden), yield* frameCount(out)] as const,
    changed: yield* changedPixels(golden, out),
    audio: [yield* audioSums(golden), yield* audioSums(out)] as const,
  }
})

// The first run builds the engine (about 1.5s); a run takes a few seconds.
test(
  "the hook scene renders close to the golden video",
  async () => {
    const { out, frames, changed, audio } = await Effect.runPromise(check.pipe(Effect.provide(Engine.layer.pipe(Layer.provideMerge(BunServices.layer)))))
    expect(frames[1], `frame count of ${out} differs from hook.golden.mp4`).toBe(frames[0])
    const worst = changed.reduce((max, share, frame) => (share > changed[max]! ? frame : max), 0)
    expect(changed[worst]!, `frame ${worst} of ${out} differs from hook.golden.mp4 in ${(changed[worst]! * 100).toFixed(3)}% of its pixels`).toBeLessThanOrEqual(MAX_CHANGED)
    expect(audio[1], `audio of ${out} differs from hook.golden.mp4`).toBe(audio[0])
  },
  { timeout: 600_000 }
)
