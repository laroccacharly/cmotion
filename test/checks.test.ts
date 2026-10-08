// The mistakes cmotion refuses or reports instead of rendering wrong: type errors in scenes, unknown tween ids,
// malformed spans, flow settings without a layout, ambiguous cues, and nodes that leave the frame or sit under a subtitle.
import { afterAll, describe, expect, test } from "bun:test"
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Exit, Layer, Option } from "effect"
import { typecheck } from "../ts/build.ts"
import { checkScene } from "../ts/check.ts"
import { box, palette, SceneCtx, type Style, text } from "../ts/dsl.ts"
import { Engine } from "../ts/engine.ts"
import { frameTime, numbered, parseFrame } from "../ts/inspect.ts"
import { renderFile } from "../ts/layout.ts"

const words = ["Say", "now,", "then", "now."].map((t, i) => ({ text: t, start: i, end: i + 0.5 }))

describe("the DSL", () => {
  test("a word said twice needs which time", () => {
    const s = new SceneCtx("cue", 5, 0.5, words)
    expect(() => s.at("now")).toThrow(/said 2 times[\s\S]*1: "…Say now, then now\.…" at 1\.00s/u)
    expect(s.at("now", 2)).toBe(3.5)
    expect(s.at("then")).toBe(2.5)
    expect(() => s.at("never")).toThrow("not in the voiceover")
  })

  test("offsetX and offsetY tween the engine's x and y", () => {
    const s = new SceneCtx("a", 1, 0, [])
    s.tl.to("b", { offsetX: 10, offsetY: -4 }, 0)
    expect(s.tl.tweens.map((t) => [t.prop, t.to])).toEqual([["x", 10], ["y", -4]])
  })

  test("eases, fonts and colors are only the ones the engine knows", () => {
    const s = new SceneCtx("a", 1, 0, [])
    s.tl.to("b", { opacity: 1 }, 0, { ease: "expo.out" })
    s.tl.to("b", { opacity: 1 }, 0, { ease: "back.out(1.7)" })
    // @ts-expect-error the engine has no elastic ease
    s.tl.to("b", { opacity: 1 }, 0, { ease: "elastic.out" })
    // @ts-expect-error nor bounce
    s.tl.to("b", { opacity: 1 }, 0, { ease: "bounce.out" })
    text("a", { font: "mono-400i", color: "rgba(0, 0, 0, 0.5)" })
    // @ts-expect-error no such font
    text("a", { font: "inter-900" })
    // @ts-expect-error a color name, not CSS the compiler parses
    box({ fill: "red" })
    expect(palette({ ink: "#000" }).ink).toBe("#000")
  })

  test("text takes plain strings among its spans", () => {
    expect(text(["Written as ", { text: "code.", color: "#00f" }]).spans).toEqual([{ text: "Written as " }, { text: "code.", color: "#00f" }])
  })
})

describe("checkScene", () => {
  test("names an unknown tween id and the ids that exist", () => {
    const root = box({}, ...[0, 1, 2].map((i) => text("x", { id: `ln-${i}` })))
    expect(checkScene("code", root, [{ target: "ln-1" }, { target: "ln-3" }, { target: "ghost" }])).toEqual([
      'scene code: a tween targets "ln-3", which no node has; the ids are ln-0 to ln-2',
      'scene code: a tween targets "ghost", which no node has',
    ])
  })

  test("rejects spans without text, flow settings without a layout, and duplicate ids", () => {
    const bad = { ...text("x", { id: "t" }), spans: [{ text: "ok" }, "loose" as never] }
    // @ts-expect-error pad and gap need a layout
    const pill = box({ id: "pill", pad: [10, 20], gap: 4 })
    const root = box({}, bad, pill, box({ id: "pill" }), box({ id: "row", layout: "row", pad: 8 }))
    expect(checkScene("a", root, [])).toEqual([
      'scene a: text "t": span 1 is not { text: string, ... } (got "loose")',
      'scene a: box "pill" sets pad, gap but no layout; add layout: "row" or "column"',
      'scene a: two nodes have the id "pill"',
    ])
  })

  test("rejects x/y on a flow child unless it is abs, in the types and at compile", () => {
    const size = 230
    // @ts-expect-error a row ignores the cursor's y
    box({ layout: "row" }, text("cmotion"), box({ y: -size * 0.12 }))
    box({}, box({ y: -size * 0.12 }))
    // Zero, abs and a style typed only as Style get through the types.
    const loose: Style = { y: -10 }
    box({ layout: "column" }, text("a", { x: 0, anchor: [0, 0] }), box({ x: 4, abs: true }), box(loose))
    const root = box({ id: "mark", layout: "row" }, text("a", { id: "word", x: 0, y: 0 }), box(loose), box({ id: "badge", x: 4, abs: true }))
    expect(checkScene("a", root, [])).toEqual([
      'scene a: box "mark" > box 1 sets y inside the row "mark", which ignores them; use pad or gap, a tween\'s offsetX/offsetY, or abs: true',
    ])
  })
})

describe("still frames", () => {
  test("parse scene, scene:seconds and scene@word with #n and a shift", () => {
    expect(parseFrame("intro")).toEqual(Option.some({ scene: "intro", kind: "end" }))
    expect(parseFrame("cue:2.5")).toEqual(Option.some({ scene: "cue", kind: "seconds", seconds: 2.5 }))
    expect(parseFrame("cue@now#2+0.5")).toEqual(Option.some({ scene: "cue", kind: "word", word: "now", n: 2, shift: 0.5 }))
    expect(parseFrame("cue@then-0.2")).toEqual(Option.some({ scene: "cue", kind: "word", word: "then", shift: -0.2 }))
    expect(parseFrame("cue:soon")).toEqual(Option.none())
  })

  test("resolve a word like s.at, and the end before the fade-out", () => {
    const scene = { duration: 5, words, leadIn: 0.5 }
    const time = (spec: string) => frameTime(Option.getOrThrow(parseFrame(spec)), scene, 30)
    expect(time("cue@now#2+0.5")).toBe(4)
    expect(time("cue@now")).toMatch("said 2 times")
    expect(time("cue")).toBeCloseTo(4.5, 5)
  })

  test("get a new number each time", () => {
    expect(numbered([], "cue@now#2")).toBe("001-cue@now_2.png")
    expect(numbered(["frames", "render.json", "009-a.png", "010-b.png"], "intro")).toBe("011-intro.png")
  })
})

describe("on the fixture", () => {
  const fixture = join(import.meta.dir, "fixtures", "hook")
  // Inside the package, so the scenes still resolve "cmotion".
  const dir = mkdtempSync(join(import.meta.dir, "fixtures", ".checks-"))
  cpSync(fixture, dir, { recursive: true })
  const scene = join(dir, "scenes", "hook.ts")
  const source = readFileSync(scene, "utf8")
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  const layer = Layer.provideMerge(Engine.layer, BunServices.layer)
  const withLine = (line: string) => writeFileSync(scene, source.replace("  return ", `  ${line}\n  return `))

  test("the type check rejects a tween on x", async () => {
    withLine('tl.to("panel", { x: 40 }, 0);')
    expect(Exit.isFailure(await Effect.runPromiseExit(typecheck(dir).pipe(Effect.provide(layer))))).toBe(true)
    writeFileSync(scene, source)
    expect(Exit.isSuccess(await Effect.runPromiseExit(typecheck(dir).pipe(Effect.provide(layer))))).toBe(true)
  })

  test("compile lists an unknown tween id", () => {
    withLine('tl.to("ghost", { opacity: 1 }, 0);')
    const compiled = Bun.spawnSync([process.execPath, join(import.meta.dir, "..", "ts", "compile.ts"), dir])
    writeFileSync(scene, source)
    expect(compiled.exitCode).toBe(1)
    expect(compiled.stderr.toString()).toContain('scene hook: a tween targets "ghost", which no node has')
  })

  test("the engine reports a node pushed out of the frame for long enough, and not a clean scene", async () => {
    expect(Bun.spawnSync([process.execPath, join(import.meta.dir, "..", "ts", "compile.ts"), dir]).exitCode).toBe(0)
    const still = (json: string) =>
      Effect.runPromise(Effect.gen(function* () {
        return yield* (yield* Engine).still(json, "hook:1", join(dir, "build", "still.png"), true)
      }).pipe(Effect.provide(layer)))
    expect(JSON.parse(await still(renderFile(dir)))).toEqual([])
    const video = JSON.parse(readFileSync(renderFile(dir), "utf8"))
    video.scenes[0].tweens.push({ target: "panel", prop: "x", to: 3000, start: 1, dur: 0 })
    const pushed = join(dir, "build", "pushed.json")
    writeFileSync(pushed, JSON.stringify(video))
    const issues = JSON.parse(await still(pushed))
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({ kind: "frame", id: "panel", t: 1 })
  })
})
