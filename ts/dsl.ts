// Scene DSL for cmotion: build a node tree and a timeline in TypeScript, compile to video.json for the C renderer.
//
// A scene module default-exports `(s: SceneCtx) => Node`. Inside it, `s.at("word")` is the time the voiceover
// says that word, and `s.tl` / `s.pop` / `s.rise` / `s.show` mirror the GSAP helpers of motion/shared/scene.js.

export type Color = [number, number, number, number];
type Way = "in" | "out" | "inOut";
/** The eases the engine draws; anything else would silently become power1.out. back.out(n) overshoots by n. */
export type Ease = "none" | "linear" | `power${1 | 2 | 3 | 4}.${Way}` | `sine.${Way}` | `expo.${Way}` | "back.out" | `back.out(${number})`;
/** A CSS color the compiler parses: "#rgb", "#rrggbb", "rgb(r, g, b)" or "rgba(r, g, b, a)". */
export type Css = `#${string}` | `rgb(${string})` | `rgba(${string})`;
/** A theme's named colors, each checked as a CSS color: `export const C = palette({ ink: "#0d1117" })`. */
export const palette = <K extends string>(colors: Record<K, Css>): Readonly<Record<K, Css>> => colors;
/** The fonts the engine ships, in fonts/. */
export type Font = "inter-500" | "inter-600" | "inter-700" | "mono-400" | "mono-400i" | "mono-600";

/** Parses "#rgb", "#rrggbb" or "rgba(r, g, b, a)" into 0..1 floats. */
export function color(css: string): Color {
  const hex = css.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const s = hex[1]!;
    const h = s.length === 3 ? s.replace(/./g, (c) => c + c) : s;
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).concat(1) as Color;
  }
  const fn = css.match(/^rgba?\(([^)]+)\)$/);
  if (fn) {
    const [r = 0, g = 0, b = 0, a = 1] = fn[1]!.split(",").map((p) => parseFloat(p));
    return [r / 255, g / 255, b / 255, a];
  }
  throw new Error(`unsupported color ${css}`);
}

export type Span = { text: string; font?: Font; size?: number; color?: Css; tok?: string };

/** A shader uniform: a float, a vec2 to vec4, or a CSS color, which becomes a vec4 of 0..1 floats. */
export type Uniform = number | [number, number] | [number, number, number] | [number, number, number, number] | Css;

/** Visual properties a node starts with; the animatable ones can also be tweened. */
export type Style = {
  id?: string;
  /** Position in px from the parent's top left (absolute children). Tweens move a node with offsetX/offsetY. */
  x?: number; y?: number; w?: number; h?: number;
  relX?: number; relY?: number; anchor?: [number, number];
  abs?: boolean; pushEnd?: boolean;
  layout?: "row" | "column"; align?: "start" | "center" | "end"; justify?: "start" | "center" | "end";
  gap?: number; pad?: number | [number, number] | [number, number, number, number];
  radius?: number; borderWidth?: number; dash?: number; shadow?: boolean;
  bar?: { width: number; color: Css };
  fill?: Css; border?: Css; color?: Css;
  opacity?: number; scale?: number; gray?: number;
  /** Scene root only: the background radial gradient, center color then the color from 70% out. */
  background?: { inner: Css; outer: Css };
  /** Field nodes: the id of the box whose signed distance they draw, and the contour spacing in px. */
  shape?: string; spacing?: number;
  /** Image nodes: the id of one of the scene's images in the plan. */
  src?: string;
  /** Image nodes: rotation in degrees about the center. Nonzero rotation disables rounded image clipping;
   * the fill, border and children stay axis aligned. Use transparent image leaves for rotating artwork. */
  rotate?: number;
  /** Text nodes with `count`: the number shown, tweened with the `value` prop. */
  value?: number;
  /** Decimal precision is clamped to 0..6 by the renderer. */
  count?: { decimals?: number; prefix?: string; suffix?: string };
  /** Shader nodes: the GLSL that defines `vec4 effect(vec2 p)`, and its own uniforms with their starting values. */
  code?: string;
  uniforms?: Record<string, Uniform>;
  /** Set by the compiler on file images: a hash of the file, so the render cache notices when it changes. */
  srcHash?: string;
  // text
  font?: Font; size?: number; lineHeight?: number; letterSpacing?: number; textAlign?: "start" | "center" | "end";
};

export type Node = { type: "box" | "text" | "field" | "image" | "shader"; style: Style; spans?: Span[]; children: Node[] };

/**
 * A node given its own position (a non-zero x, y, relX, relY or anchor) without `abs: true`. Only in the types: a row
 * or column places its children itself and ignores their position, so it refuses these.
 */
export type Placed = Node & { readonly placed: "a row or column ignores x, y, relX, relY and anchor: use pad, gap, offsetX/offsetY or abs: true" };
/** What a row or column takes as children. */
export type FlowChild = Node & { readonly placed?: never };

type PlaceKey = "x" | "y" | "relX" | "relY" | "anchor";
// The position keys a style surely sets to something other than zero.
type Moves<S> = { [K in PlaceKey & keyof S]-?: undefined extends S[K] ? never : S[K] extends 0 | readonly [0, 0] ? never : K }[PlaceKey & keyof S];
/** The node type a style makes: Placed when it positions a node a flow would ignore. */
export type NodeOf<S> = S extends { abs: true } ? Node : [Moves<S>] extends [never] ? Node : Placed;

type Children<S> = S extends { layout: "row" | "column" } ? (FlowChild | FlowChild[])[] : (Node | Node[])[];

// Without a layout a box places its children by their x/y, so the flow settings would do nothing. A style that may
// have a layout (a spread of a Style) is left to the compile check.
type FlowKey = "pad" | "gap" | "align" | "justify";
type NeedsLayout = { readonly "pad, gap, align and justify need layout: row or column": true };
type FlowSettings<S> = "layout" extends keyof S ? unknown : { [K in FlowKey & keyof S]: NeedsLayout };

export const box = <const S extends Style>(style: S & FlowSettings<S>, ...children: Children<S>): NodeOf<S> =>
  ({ type: "box", style, children: children.flat() }) as Node as NodeOf<S>;

/**
 * The signed distance field of the box `shape`, drawn over this node's own box: `fill` inside, `border` outside,
 * contours every `spacing` px and a white line on the edge. It follows the shape's animated w, h, radius, x and y.
 */
export const field = (style: Style & { shape: string }): Node => ({ type: "field", style, children: [] });

/**
 * One of the scene's generated images (`images` in the plan), by id. Without w and h it shows at its pixel size,
 * shrunk to fit the frame; with one of them the other keeps the image's aspect; with both it is cropped to fill the
 * box, like CSS object-fit: cover. `radius` rounds its corners; opacity, scale, gray, x, y, w and h animate.
 */
export const image = <const S extends Style = {}>(src: string, style?: S): NodeOf<S> =>
  ({ type: "image", style: { ...style, src }, children: [] }) as Node as NodeOf<S>;

/**
 * A box whose children draw into a layer that `code`, a GLSL fragment, turns into what the box shows. The code defines
 * `vec4 effect(vec2 p)`: the premultiplied color at p, in px from the box's top left. It can read
 * - `source(p)`: the children's premultiplied color at p, which may lie outside the box
 * - `iResolution` (vec2, the box size), `iTime` (scene seconds; reading it redraws every frame)
 * - each of `uniforms` by its name, a float, vecN or a color as a vec4. Tween them with `{ uniforms: { name: v } }`.
 * The effect covers the box only, so size it to hold what it spills, like a glow. Compiler errors give lines of code.
 */
export const shader = <const S extends Style & { id: string }>(code: string, style: S & FlowSettings<S>, ...children: Children<S>): NodeOf<S> =>
  ({ type: "shader", style: { ...style, code }, children: children.flat() }) as Node as NodeOf<S>;

/** A single line of text: a string, or pieces where a plain string is a span in the node's own style. */
export const text = <const S extends Style = {}>(content: string | (string | Span)[], style?: S): NodeOf<S> =>
  ({
    type: "text",
    style: style ?? {},
    spans: typeof content === "string" ? [{ text: content }] : content.map((piece) => (typeof piece === "string" ? { text: piece } : piece)),
    children: [],
  }) as Node as NodeOf<S>;

/**
 * A number that animates: tween its `value` prop and it shows prefix + value + suffix, with `decimals` digits and
 * thousands separators, in the text style given (font, size, color). Its laid-out width is that of `sample`, so pass
 * the widest value when it is centered or end-aligned in a row.
 */
export const counter = <const S extends Style = {}>(
  value: number,
  count: { decimals?: number; prefix?: string; suffix?: string },
  style?: S,
  sample = `${count.prefix ?? ""}${value.toFixed(count.decimals ?? 0)}${count.suffix ?? ""}`,
): NodeOf<S> => ({ type: "text", style: { ...style, value, count }, spans: [{ text: sample }], children: [] }) as Node as NodeOf<S>;

// ---------- timeline ----------

/** Tweenable properties, by their cmotion names. Colors are CSS strings. */
export type Props = {
  opacity?: number; scale?: number; gray?: number;
  /** Moves the node by this many px from where its layout put it (its style x/y). Not a position: 0 is home. */
  offsetX?: number; offsetY?: number;
  color?: Css; fill?: Css; border?: Css; fg?: Css; bg?: Css;
  /** Box size, drawn from the box's anchor point (top left by default); children keep their layout. */
  w?: number; h?: number; radius?: number;
  /** Field contour spacing, px. */
  spacing?: number;
  /** The number of a `counter` text node. */
  value?: number;
  /** Image rotation in degrees. */
  rotate?: number;
  /** A shader node's own uniforms, by name. */
  uniforms?: Record<string, Uniform>;
};
export type TweenOpts = { duration?: number; ease?: Ease; stagger?: number };

type Value = number | number[];
type Tween = { target: string; prop: string; from?: Value; to: Value; start: number; dur: number; ease?: Ease };

const value = (v: Uniform): Value => (typeof v === "string" ? color(v) : typeof v === "number" ? v : [...v]);

// The engine's names for props the DSL names differently.
const ENGINE_PROP: Record<string, string> = { offsetX: "x", offsetY: "y" };

export class Timeline {
  tweens: Tween[] = [];

  private add(targets: string | string[], from: Props | null, to: Props, t: number, o: TweenOpts) {
    const list = Array.isArray(targets) ? targets : [targets];
    list.forEach((target, i) => {
      const push = (target: string, prop: string, v: Uniform, f: Uniform | undefined) =>
        this.tweens.push({
          target, prop, to: value(v), start: t + i * (o.stagger ?? 0), dur: o.duration ?? 0.5, ease: o.ease,
          ...(f !== undefined ? { from: value(f) } : {}),
        });
      for (const [key, v] of Object.entries(to)) {
        if (v === undefined) continue;
        // Each uniform is the value of its own target, "<shader id>.<name>".
        if (key === "uniforms")
          for (const [name, u] of Object.entries(v as Record<string, Uniform>)) push(`${target}.${name}`, "value", u, from?.uniforms?.[name]);
        else push(target, ENGINE_PROP[key] ?? key, v as Uniform, from?.[key as keyof Props] as Uniform | undefined);
      }
    });
    return this;
  }

  to(targets: string | string[], props: Props, t: number, o: TweenOpts = {}) { return this.add(targets, null, props, t, o); }
  fromTo(targets: string | string[], from: Props, to: Props, t: number, o: TweenOpts = {}) { return this.add(targets, from, to, t, o); }
  set(targets: string | string[], props: Props, t: number) { return this.add(targets, null, props, t, { duration: 0 }); }
}

export type Word = { text: string; start: number; end: number };

/** Lowercase and drop punctuation, so cue "sloppy" matches the spoken "sloppy.". */
export const normalize = (w: string) => w.toLowerCase().replace(/[’]/g, "'").replace(/[^\p{L}\p{N}_']/gu, "");

export class SceneCtx {
  tl = new Timeline();
  constructor(readonly id: string, readonly duration: number, readonly leadIn: number, readonly words: Word[]) {}

  /**
   * When the voiceover says `cue`, in scene seconds. A word said more than once needs `n`, which time (from 1), so a
   * cue never lands on the wrong occurrence by default.
   */
  at = (cue: string, n?: number): number => {
    const hits = this.words.flatMap((w, i) => (normalize(w.text) === normalize(cue) ? [i] : []));
    const where = (i: number) => `"…${this.words.slice(Math.max(0, i - 2), i + 3).map((w) => w.text).join(" ")}…" at ${this.words[i]!.start.toFixed(2)}s`;
    if (hits.length === 0) throw new Error(`scene ${this.id}: cue "${cue}" is not in the voiceover`);
    if (n === undefined && hits.length > 1)
      throw new Error(`scene ${this.id}: cue "${cue}" is said ${hits.length} times; pass which one, s.at("${cue}", n):\n${hits.map((i, k) => `  ${k + 1}: ${where(i)}`).join("\n")}`);
    const hit = hits[(n ?? 1) - 1];
    if (hit === undefined) throw new Error(`scene ${this.id}: cue "${cue}" #${n} is not in the voiceover; it is said ${hits.length} time(s)`);
    return this.words[hit]!.start + this.leadIn;
  };

  pop = (t: string | string[], at: number, o: TweenOpts = {}) =>
    this.tl.fromTo(t, { opacity: 0, offsetY: 20, scale: 0.92 }, { opacity: 1, offsetY: 0, scale: 1 }, at, { duration: 0.5, ease: "back.out(2)", ...o });
  rise = (t: string | string[], at: number, o: TweenOpts = {}) =>
    this.tl.fromTo(t, { opacity: 0, offsetY: 30 }, { opacity: 1, offsetY: 0 }, at, { duration: 0.6, ease: "power3.out", ...o });
  show = (t: string | string[], at: number, o: TweenOpts = {}) => this.tl.to(t, { opacity: 1 }, at, { duration: 0.4, ...o });
}

export type SceneFn = (s: SceneCtx) => Node;

// ---------- code ----------

export type CodeClass = "kw" | "fn" | "str" | "p" | "ty" | "cm" | null;

const KW = new Set(["const", "function*", "yield*", "new", "readonly", "return", "=>"]);

/** Splits one line of TypeScript into classed pieces (the same rules as Scene.code in motion/shared/scene.js). */
export function highlight(src: string): { text: string; cls: CodeClass }[] {
  const out: { text: string; cls: CodeClass }[] = [];
  const re = /(\/\/.*$)|("[^"]*")|(function\*|yield\*|=>|[A-Za-z_$][\w$.]*)|([^\w\s"]+)/g;
  let last = 0;
  for (let m; (m = re.exec(src)); ) {
    if (m.index > last) out.push({ text: src.slice(last, m.index), cls: null });
    last = m.index + m[0].length;
    const [all, cm, str, word = "", punct] = m;
    if (cm) out.push({ text: cm, cls: "cm" });
    else if (str) out.push({ text: str, cls: "str" });
    else if (punct) out.push({ text: punct, cls: "p" });
    else if (KW.has(word)) out.push({ text: word, cls: "kw" });
    else {
      const parts = word.split(".");
      const tail = parts.pop()!;
      if (parts.length) out.push({ text: parts.join(".") + ".", cls: null });
      const next = src[m.index + all.length];
      out.push({ text: tail, cls: next === "(" ? "fn" : /^[A-Z]/.test(tail) ? "ty" : null });
    }
  }
  if (last < src.length) out.push({ text: src.slice(last), cls: null });
  return out;
}

/**
 * Lines of highlighted code, dedented. `⟦id|text⟧` marks a token the timeline can target (props fg and bg).
 * `paint` maps a class to span styling, so each video keeps its own palette.
 */
export function codeLines(src: string, paint: (cls: CodeClass) => Partial<Span>): Span[][] {
  const lines = src.replace(/^\n/, "").replace(/\s+$/, "").split("\n");
  const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => l.match(/^ */)![0].length));
  return lines.map((line) =>
    line
      .slice(indent)
      .split(/(⟦[^⟧]+⟧)/)
      .flatMap((part) => {
        const m = part.match(/^⟦([\w-]+)\|(.+)⟧$/);
        const pieces = highlight(m ? m[2]! : part).map((p) => ({ text: p.text, ...paint(p.cls), ...(m ? { tok: m[1] } : {}) }));
        return pieces.filter((p) => p.text.length);
      }),
  );
}
