// Compiles a video folder's scenes/<id>.ts into build/render.json for the cmotion renderer.
//
// Usage: bun cmotion/ts/compile.ts VIDEO_DIR [IMAGE_MODEL] [--scene ID]... [--out PATH]
// With --scene, only those scenes compile (for stills), to --out (default build/render.json).
// Voiceover text, lead-in and tail come from VIDEO_DIR/script.json. Word timings and audio come from the
// voiceovers that `cmotion voiceover` writes (generated/voiceover/<key>.{mp3,json}), found by the same voiceoverKey.
// Scene images come from what `cmotion images` writes (generated/images/<key>.{png,json}),
// matched by prompt and settings, or from a PNG the script names with `file`, relative to VIDEO_DIR.
// With "subtitles": true in the script, each scene also gets its voiceover as timed subtitle lines.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { color, type Node, SceneCtx, type SceneFn, type Word } from "./dsl";
import { imageDir as generatedImages, renderFile, sceneFile, scriptFile, voiceoverDir } from "./layout";
import { Schema } from "effect";
import { type Scene as ScriptScene, Script } from "./script";
import { voiceoverKey } from "./voiceover";
import { sha } from "./key";
import { checkScene } from "./check";

const positional: string[] = [];
const only: string[] = [];
let outArg: string | undefined;
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i]!;
  if (a === "--scene") only.push(process.argv[++i] ?? "");
  else if (a === "--out") outArg = process.argv[++i];
  else positional.push(a);
}
const [dirArg, imageModel] = positional;
if (!dirArg) {
  console.error("usage: bun cmotion/ts/compile.ts VIDEO_DIR [IMAGE_MODEL] [--scene ID]... [--out PATH]");
  process.exit(2);
}
const dir = resolve(dirArg);
const voiceDir = voiceoverDir(dir);
const imageDir = generatedImages(dir);
const out = outArg ? resolve(outArg) : renderFile(dir);

const script = Schema.decodeSync(Schema.fromJsonString(Script), { onExcessProperty: "error" })(readFileSync(scriptFile(dir), "utf8"));
const leadIn = script.lead_in;
const tail = script.tail;

/** Every <key>.json in dir, with its key. */
function metas(dir: string) {
  return existsSync(dir)
    ? readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => ({ key: f.slice(0, -5), meta: JSON.parse(readFileSync(join(dir, f), "utf8")) }))
    : [];
}

/** The scene's voiceover for the script's voice, model and format: the file voiceover.ts wrote under this key. */
function voice(scene: ScriptScene): { audio: string; words: Word[]; duration: number } {
  const meta = join(voiceDir, `${voiceoverKey(script, scene.voiceover.trim())}.json`);
  if (!existsSync(meta)) throw new Error(`scene ${scene.id}: no voiceover; run \`cmotion voiceover\` first`);
  const hit: { audio: string; words: Word[] } = JSON.parse(readFileSync(meta, "utf8"));
  const audio = join(voiceDir, hit.audio);
  const probe = Bun.spawnSync(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", audio]);
  return { audio, words: hit.words, duration: parseFloat(probe.stdout.toString()) };
}

const W = 1920, H = 1080;

const images = metas(imageDir);

/** The PNG of a script image, generated or a file, and its pixel size. The defaults and fields match imageSpec in images.ts. */
function generatedImage(scene: ScriptScene, id: string): { path: string; w: number; h: number; hash?: string } {
  const spec = scene.images?.find((i) => i.id === id);
  if (!spec) throw new Error(`scene ${scene.id}: no image "${id}" in the script`);
  if ("file" in spec) return pngSize(scene, id, resolve(dir, spec.file), true);
  const want = { prompt: spec.prompt.trim(), size: spec.size ?? "1536x864", quality: spec.quality ?? "high", transparent: spec.transparent ?? false };
  const hit = images.find((c) => (!imageModel || c.meta.model === imageModel) && Object.entries(want).every(([k, v]) => c.meta[k] === v));
  if (!hit) throw new Error(`scene ${scene.id}: image "${id}" is not generated; run \`cmotion images\` first`);
  return pngSize(scene, id, join(imageDir, `${hit.key}.png`));
}

/** A PNG's path and pixel size. `hashed` adds a hash of its bytes, for files that can change under the same path. */
function pngSize(scene: ScriptScene, id: string, path: string, hashed = false): { path: string; w: number; h: number; hash?: string } {
  if (!existsSync(path)) throw new Error(`scene ${scene.id}: image "${id}" has no file at ${path}`);
  const png = readFileSync(path);
  if (png.toString("latin1", 1, 4) !== "PNG") throw new Error(`scene ${scene.id}: image "${id}" at ${path} is not a PNG`);
  return { path, w: png.readUInt32BE(16), h: png.readUInt32BE(20), ...(hashed ? { hash: sha(png) } : {}) };
}

/** Image nodes get their file and a display size: missing sides follow the image's aspect, fit inside the frame. */
function resolveImages(n: Node, scene: ScriptScene) {
  if (n.type === "image") {
    const img = generatedImage(scene, n.style.src!);
    const { w, h } = n.style;
    if (w === undefined && h === undefined) {
      const k = Math.min(1, W / img.w, H / img.h);
      n.style.w = Math.round(img.w * k);
      n.style.h = Math.round(img.h * k);
    } else if (w === undefined) n.style.w = Math.round((h! * img.w) / img.h);
    else if (h === undefined) n.style.h = Math.round((w * img.h) / img.w);
    n.style.src = img.path;
    // Scene renders are cached by their compiled JSON, so a file image carries its hash to re-render when it changes.
    if (img.hash) n.style.srcHash = img.hash;
  }
  n.children.forEach((k) => resolveImages(k, scene));
}

type Cue = { text: string; start: number; end: number };

/**
 * Groups voiceover words into subtitle lines, in scene seconds. Phrases end at a sentence end, at a pause, or at a
 * comma or colon; a phrase longer than MAX_CHARS is split into lines of about even length.
 */
const MAX_CHARS = 48;
const chars = (ws: Word[]) => ws.reduce((n, w) => n + w.text.length, 0) + ws.length - 1;

function subtitles(words: Word[], offset: number): Cue[] {
  const phrases: Word[][] = [[]];
  words.forEach((w, i) => {
    const phrase = phrases.at(-1)!;
    phrase.push(w);
    const next = words[i + 1];
    const end = /[.?!]["”’]?$/.test(w.text) || (chars(phrase) >= 16 && /[,:;]$/.test(w.text));
    if (next && (end || next.start - w.end > 0.6)) phrases.push([]);
  });
  const lines = phrases.flatMap((phrase) => {
    const target = chars(phrase) / Math.ceil(chars(phrase) / MAX_CHARS);
    const out: Word[][] = [[]];
    for (const w of phrase) {
      const line = out.at(-1)!;
      if (line.length && chars([...line, w]) > target + 4) out.push([w]);
      else line.push(w);
    }
    return out;
  });
  const round = (t: number) => Math.round(t * 1000) / 1000;
  // Each line stays up until the next one starts, or 0.4s past its last word when a pause follows.
  return lines.map((l, i) => {
    const next = lines[i + 1]?.[0]?.start ?? Infinity;
    const end = Math.min(next, l.at(-1)!.end + 0.4);
    return { text: l.map((w) => w.text).join(" "), start: round(l[0]!.start + offset), end: round(end + offset) };
  });
}

const pad4 = (p: number | number[] | undefined) =>
  p === undefined ? undefined : typeof p === "number" ? [p, p, p, p] : p.length === 2 ? [p[0], p[1], p[0], p[1]] : p;

function serialize(n: Node): unknown {
  const { pad, fill, border, bar, background: _, ...rest } = n.style;
  return {
    type: n.type,
    ...rest,
    ...(rest.color ? { color: color(rest.color) } : {}),
    ...(pad !== undefined ? { pad: pad4(pad) } : {}),
    ...(fill ? { fill: color(fill) } : {}),
    ...(border ? { border: color(border) } : {}),
    ...(bar ? { bar: { width: bar.width, color: color(bar.color) } } : {}),
    ...(n.spans ? { spans: n.spans.map((s) => ({ ...s, ...(s.color ? { color: color(s.color) } : {}) })) } : {}),
    children: n.children.map(serialize),
  };
}

const missing = only.filter((id) => !script.scenes.some((scene) => scene.id === id));
if (missing.length) throw new Error(`no scene ${missing.join(", ")} in the script`);
const scenes = [];
const problems: string[] = [];
for (const scene of script.scenes.filter((scene) => only.length === 0 || only.includes(scene.id))) {
  const file = sceneFile(dir, scene.id);
  if (!existsSync(file)) throw new Error(`scene ${scene.id}: no visuals at ${file}`);
  const v = voice(scene);
  const duration = Math.round((leadIn + v.duration + tail) * 1000) / 1000;
  const ctx = new SceneCtx(scene.id, duration, leadIn, v.words);
  const build: SceneFn = (await import(file)).default;
  let root: Node;
  try {
    root = build(ctx);
  } catch (error) {
    // A scene's own mistake, like a cue the voiceover doesn't say: report it with the rest and move on.
    problems.push(error instanceof Error ? error.message : String(error));
    continue;
  }
  root.style.id = "scene";
  resolveImages(root, scene);
  // Every scene fades out over its last 0.4s, like Scene.make().
  ctx.tl.to("scene", { opacity: 0 }, duration - 0.4, { duration: 0.4 });
  problems.push(...checkScene(scene.id, root, ctx.tl.tweens));
  const bg = root.style.background;
  const background = bg ? { background: { inner: color(bg.inner), outer: color(bg.outer) } } : {};
  const subs = script.subtitles ? { subtitles: subtitles(v.words, leadIn) } : {};
  scenes.push({ id: scene.id, duration, audio: v.audio, audioStart: leadIn, ...background, root: serialize(root), tweens: ctx.tl.tweens, ...subs });
}

if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ width: W, height: H, fps: 30, scenes }));
const total = scenes.reduce((a, s) => a + s.duration, 0);
console.log(`${scenes.length} scenes, ${total.toFixed(1)}s → ${out}`);
