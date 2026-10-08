// A scene image keeps its aspect ratio and orientation: a 64x32 PNG, red | green over blue | white, drawn 400 px wide.
import { expect, test } from "bun:test"
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { deflateSync } from "node:zlib"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { packageDir } from "../ts/config.ts"
import { Engine } from "../ts/engine.ts"
import { imageDir, renderFile, voiceoverDir } from "../ts/layout.ts"
import { run } from "../ts/process.ts"

type Rgb = readonly [number, number, number]

// A minimal RGB PNG.
const png = (rows: ReadonlyArray<ReadonlyArray<Rgb>>): Buffer => {
  const chunk = (kind: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(kind), data])
    const head = Buffer.alloc(4)
    head.writeUInt32BE(data.length)
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(Bun.hash.crc32(body))
    return Buffer.concat([head, body, crc])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(rows[0]?.length ?? 0, 0)
  header.writeUInt32BE(rows.length, 4)
  header.set([8, 2, 0, 0, 0], 8)
  const raw = Buffer.concat(rows.map((row) => Buffer.from([0, ...row.flat()])))
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))])
}

const pixel = (image: string, x: number, y: number): Array<number> => {
  const crop = Bun.spawnSync(["ffmpeg", "-v", "error", "-i", image, "-vf", `crop=1:1:${x}:${y}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"])
  return [...crop.stdout]
}

test("a scene image keeps its aspect and orientation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cmotion-image-"))
  const red: Rgb = [255, 0, 0], green: Rgb = [0, 255, 0], blue: Rgb = [0, 0, 255], white: Rgb = [255, 255, 255]
  const top = [...Array<Rgb>(32).fill(red), ...Array<Rgb>(32).fill(green)]
  const bottom = [...Array<Rgb>(32).fill(blue), ...Array<Rgb>(32).fill(white)]
  const images = imageDir(dir)
  mkdirSync(images, { recursive: true })
  writeFileSync(join(images, "k.png"), png([...Array(16).fill(top), ...Array(16).fill(bottom)]))
  const meta = { prompt: "four quadrants", size: "64x32", quality: "high", transparent: false, model: "m", image: "k.png" }
  writeFileSync(join(images, "k.json"), JSON.stringify(meta))

  const fixture = join(import.meta.dir, "fixtures", "hook")
  cpSync(voiceoverDir(fixture), voiceoverDir(dir), { recursive: true })
  mkdirSync(join(dir, "scenes"))
  const script = JSON.parse(readFileSync(join(fixture, "script.json"), "utf8"))
  mkdirSync(join(dir, "assets"))
  writeFileSync(join(dir, "assets", "quads.png"), readFileSync(join(images, "k.png")))
  script.scenes[0].images = [{ id: "quads", prompt: "four quadrants", size: "64x32" }, { id: "photo", file: "assets/quads.png" }]
  writeFileSync(join(dir, "script.json"), JSON.stringify(script))
  writeFileSync(
    join(dir, "scenes", "hook.ts"),
    `import { box, image } from "${join(packageDir, "ts", "dsl.ts")}";\n` +
      'export default () => box({ x: 0, y: 0, w: 1920, h: 1080 }, image("quads", { x: 100, y: 100, w: 400 }), image("photo", { x: 600, y: 100, h: 100 }), image("photo", { id: "rotated", x: 800, y: 200, w: 400, rotate: 90 }));\n'
  )

  const renderJson = renderFile(dir)
  const still = join(dir, "still.png")
  const render = Effect.gen(function* () {
    yield* run("compile", process.execPath, [join(packageDir, "ts", "compile.ts"), dir])
    yield* (yield* Engine).still(renderJson, "hook:1", still)
  })
  await Effect.runPromise(render.pipe(Effect.provide(Engine.layer.pipe(Layer.provideMerge(BunServices.layer)))))

  const [node, file] = JSON.parse(readFileSync(renderJson, "utf8")).scenes[0].root.children
  expect([node.w, node.h, node.src]).toEqual([400, 200, join(images, "k.png")])
  expect(node).not.toHaveProperty("srcHash")
  expect([file.w, file.h, file.src]).toEqual([200, 100, join(dir, "assets", "quads.png")])
  expect(file.srcHash).toMatch(/^[0-9a-f]{16}$/)
  const quadrants: Array<[number, number, Rgb]> = [[150, 150, red], [450, 150, green], [150, 250, blue], [450, 250, white],
    // Clockwise quarter turn: the wide image now extends above and below its original box.
    [950, 150, blue], [1050, 150, red], [950, 450, white], [1050, 450, green]]
  for (const [x, y, want] of quadrants) {
    const got = pixel(still, x, y)
    expect(got.every((c, i) => Math.abs(c - (want[i] ?? 0)) <= 2), `pixel ${x},${y} is ${got.join(",")}, want ${want.join(",")}`).toBe(true)
  }
}, 600_000)
