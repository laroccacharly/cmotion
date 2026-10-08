// The lint video's look for cmotion: the same tokens and components as ../theme.css.
import { palette, box, type CodeClass, codeLines, type Node, type Span, type Style, text } from "cmotion";

export const C = palette({
  panel: "#16181d",
  text: "#e6e4dc",
  dim: "#a1a3aa",
  green: "#4ade80",
  red: "#f87171",
  kw: "#c4a7e7",
  fn: "#8ab4f8",
  str: "#a6d189",
  punct: "#8f9198",
  ty: "#7fd1b9",
  cm: "#7c7f87",
});

export const W = 1920;

/** A toggled code token: `tl.set(id, BAD, t)`. */
export const BAD = { fg: C.red, bg: "rgba(248, 113, 113, 0.16)" };
export const GOOD = { fg: C.green, bg: "rgba(74, 222, 128, 0.14)" };

const paint = (cls: CodeClass): Partial<Span> =>
  cls === "cm" ? { color: C.cm, font: "mono-400i" } : cls === "p" ? { color: C.punct } : cls ? { color: C[cls] } : {};

/** `.ln` lines: 32px/1.75 JetBrains Mono, one text node per line with ids `${prefix}-ln0`, `-ln1`, ... */
export function code(src: string, prefix: string, size = 32, style: Style = {}): Node[] {
  return codeLines(src, paint).map((spans, i) =>
    text(spans.length ? spans : [{ text: " " }], { id: `${prefix}-ln${i}`, font: "mono-400", size, lineHeight: size * 1.75, ...style }),
  );
}

export const lineIds = (prefix: string, from: number, to: number) =>
  Array.from({ length: to - from }, (_, i) => `${prefix}-ln${from + i}`);

/** `.panel`: rounded, bordered card with a soft drop shadow, content in a column. */
export const panel = (style: Style, ...children: (Node | Node[])[]) =>
  box({ layout: "column", fill: C.panel, border: "rgba(255, 255, 255, 0.07)", borderWidth: 1, radius: 18, shadow: true, ...style }, ...children);

/** `.file`: the dim file name above code, with its 22px bottom margin. */
export const file = (name: string) => text(name, { font: "inter-500", size: 22, color: C.dim, h: 22 * 1.21 + 22 });

/** `.badge` (green) or `.badge.red`. */
export function badge(label: string | Span[], style: Style & { red?: boolean } = {}): Node {
  const { red, font = "inter-600", size = 36, ...rest } = style;
  return box(
    {
      layout: "row", align: "center", pad: [14, 30], radius: 999, borderWidth: 2,
      color: red ? C.red : C.green,
      fill: red ? "rgba(248, 113, 113, 0.1)" : "rgba(74, 222, 128, 0.1)",
      border: red ? "rgba(248, 113, 113, 0.6)" : "rgba(74, 222, 128, 0.45)",
      ...rest,
    },
    text(label, { font, size }),
  );
}

/** `.title`: centered 56px bold headline across the frame. */
export const title = (label: string, style: Style) =>
  text(label, { x: 0, w: W, textAlign: "center", font: "inter-700", size: 56, letterSpacing: -1, ...style });

/** A full-width row whose children are centered, like `display: flex; justify-content: center`. */
export const centeredRow = (style: Style, ...children: Node[]) =>
  box({ x: 0, w: W, layout: "row", justify: "center", align: "center", ...style }, ...children);

/** The scene root: 1920x1080, children positioned absolutely. */
export const scene = (...children: (Node | Node[])[]) => box({ x: 0, y: 0, w: W, h: 1080, color: C.text }, ...children);
