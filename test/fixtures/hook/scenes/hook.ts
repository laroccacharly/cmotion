import { box, type SceneCtx, text } from "cmotion";
import { badge, C, centeredRow, code, file, lineIds, panel, scene } from "../theme";

export default (s: SceneCtx) => {
  const { tl, at, pop, rise } = s;
  const lines = code(
    `
    const sendEmail = Effect.fn("sendEmail")(function* (title, report) {
      const apiKey = yield* findSecret("EMAIL_API_KEY")
      yield* Effect.tryPromise(() =>
        new EmailClient({ apiKey }).send({ title, body: report })
      )
    })`,
    "c",
    32,
    { opacity: 0 },
  );
  const root = scene(
    centeredRow({ y: 150, gap: 28 }, badge("✓ typechecks", { id: "b-types", opacity: 0 }), badge("✓ tests pass", { id: "b-tests", opacity: 0 })),
    panel(
      { id: "panel", x: 230, y: 300, w: 1460, pad: [44, 56], opacity: 0 },
      file("send-email.ts"),
      lines.slice(0, 2),
      box(
        { id: "bad", layout: "column", w: 1348 },
        box({ id: "bad-bg", abs: true, x: -16, w: 1380, h: 3 * 56, radius: 10, fill: "rgba(248, 113, 113, 0.12)", bar: { width: 4, color: C.red }, opacity: 0 }),
        lines.slice(2, 5),
      ),
      lines.slice(5),
      text("?", { id: "mark", abs: true, relX: 1, x: -70, relY: 0.5, anchor: [1, 0.5], font: "inter-700", size: 150, color: C.red, opacity: 0 }),
    ),
    box(
      { id: "lint", x: 960, y: 880, anchor: [0.5, 0], layout: "row", align: "center", gap: 16, pad: [16, 30], radius: 12, fill: "#1d1416", border: C.red, borderWidth: 2, opacity: 0 },
      text("✗ lint", { font: "mono-600", size: 30, color: C.red }),
      text("ts-lint/effect-fn-return-type", { font: "mono-400", size: 30 }),
    ),
  );
  const all = lineIds("c", 0, 6), bad = lineIds("c", 2, 5);

  // "An agent wrote this function."
  rise("panel", at("An"));
  tl.fromTo(all, { opacity: 0, offsetX: -12 }, { opacity: 1, offsetX: 0 }, at("agent"), { duration: 0.35, ease: "power2.out", stagger: 0.22 });
  // "It typechecks," / "and the tests pass."
  pop("b-types", at("typechecks"));
  pop("b-tests", at("tests", 1));
  // "And yet it's sloppy."
  tl.to("bad-bg", { opacity: 1 }, at("sloppy"), { duration: 0.4 });
  tl.to(bad, { color: "#fca5a5" }, at("sloppy"), { duration: 0.4 });
  tl.to(all, { opacity: 0.35 }, at("sloppy"), { duration: 0.4 });
  tl.to(bad, { opacity: 1 }, at("sloppy"), { duration: 0.4 });
  // "Neither the tests nor the typechecker can see why."
  tl.to("b-tests", { opacity: 0.3, gray: 1 }, at("tests", 2), { duration: 0.4 });
  tl.to("b-types", { opacity: 0.3, gray: 1 }, at("typechecker"), { duration: 0.4 });
  pop("mark", at("see"), { ease: "back.out(2.5)" });
  // "...how a lint rule caught it."
  tl.to("mark", { opacity: 0, scale: 0.6 }, at("lint"), { duration: 0.3 });
  rise("lint", at("lint"));
  return root;
};
