// Mistakes in a compiled scene that would otherwise render wrong without a word: tweens on ids that don't exist,
// spans without text, boxes with flow settings but no layout, flow children positioned by x/y, and shader uniforms
// GLSL can't name. Returns one message per problem.
import type { Node } from "./dsl";

const FLOW = ["pad", "gap", "align", "justify"] as const;
const PLACE = ["x", "y", "relX", "relY", "anchor"] as const;

export function checkScene(id: string, root: Node, tweens: ReadonlyArray<{ target: string }>): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  const walk = (n: Node, path: string) => {
    const here = n.style.id ? `"${n.style.id}"` : path;
    if (n.style.id) {
      if (ids.has(n.style.id)) errors.push(`two nodes have the id "${n.style.id}"`);
      ids.add(n.style.id);
    }
    // A shader's uniforms are targets of their own, "<id>.<name>".
    for (const name of Object.keys(n.style.uniforms ?? {})) {
      if (!/^[A-Za-z_]\w*$/u.test(name) || name.startsWith("gl_")) errors.push(`shader ${here}: uniform "${name}" is not a GLSL name`);
      ids.add(`${n.style.id}.${name}`);
    }
    // A box without layout places its children by their x/y and doesn't measure them, so these do nothing.
    if ((n.type === "box" || n.type === "shader") && !n.style.layout) {
      const flow = FLOW.filter((k) => n.style[k] !== undefined);
      if (flow.length) errors.push(`box ${here} sets ${flow.join(", ")} but no layout; add layout: "row" or "column"`);
    }
    // A row or column places its children itself, so their own position does nothing unless they are abs. Zero is
    // what the flow does anyway, so helpers that take a position can pass 0.
    if (n.style.layout)
      n.children.forEach((k, i) => {
        const place = PLACE.filter((p) => [k.style[p]].flat().some((v) => v !== undefined && v !== 0));
        if (place.length && !k.style.abs)
          errors.push(
            `${k.type} ${k.style.id ? `"${k.style.id}"` : `${here} > ${k.type} ${i}`} sets ${place.join(", ")} inside the ${n.style.layout} ${here}, which ignores them; use pad or gap, a tween's offsetX/offsetY, or abs: true`
          );
      });
    n.spans?.forEach((span, i) => {
      if (typeof span !== "object" || span === null || typeof span.text !== "string")
        errors.push(`text ${here}: span ${i} is not { text: string, ... } (got ${JSON.stringify(span)})`);
      else if (span.tok) ids.add(span.tok);
    });
    n.children.forEach((k, i) => walk(k, `${here} > ${k.type} ${i}`));
  };
  walk(root, "root");
  const unknown = [...new Set(tweens.map((t) => t.target).filter((t) => !ids.has(t)))];
  for (const target of unknown) {
    const prefix = target.replace(/\d+$/u, "");
    const near = prefix !== target ? [...ids].filter((i) => i.startsWith(prefix) && /^\d+$/u.test(i.slice(prefix.length))) : [];
    const nums = near.map((i) => Number(i.slice(prefix.length))).toSorted((a, b) => a - b);
    const hint = nums.length ? `; the ids are ${prefix}${nums[0]} to ${prefix}${nums.at(-1)}` : "";
    errors.push(`a tween targets "${target}", which no node has${hint}`);
  }
  return errors.map((e) => `scene ${id}: ${e}`);
}
