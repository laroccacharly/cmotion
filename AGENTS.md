# cmotion

cmotion makes narrated motion videos from a script: each scene has a voiceover and a TypeScript file that draws it,
timed to the words being spoken. It is used from other repos as a GitHub dependency.

- Learn the CLI from `bun cmotion --help` and `bun cmotion <command> --help`. That help is the source of truth for
  flags and defaults.
- API keys (`ELEVENLABS_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `GEMINI_API_KEY`) come from the environment,
  then the OS keyring (`bun cmotion login`).

## A video folder

Each video lives in `videos/VIDEO/`, under the project root (`--root`, default `.`):

```
videos/VIDEO/
  script.json      the scenes, with each one's id, title, visual and exact voiceover, plus voice, subtitles and music
  theme.ts         the look: palette, background and shared components, imported by scenes as `../theme`
  scenes/<id>.ts   one file per scene, written with the DSL (`import type { SceneCtx } from "cmotion"`)
  script.mp4       the joined video
  generated/       voiceovers, images and music: paid or slow to make, keep them
  build/           compiled JSON, scene renders, stills and inspect sheets: safe to delete
```

## Workflow

1. **Script.** Write `script.json` first. It is the single source of truth for each scene's `id` and `voiceover`. A
   scene can list `images` to generate (`prompt`, `size`, `quality`, `transparent`) or take from a `file`. Add
   `"music": { "prompt": ... }` for background music.
2. **Voiceovers.** `bun cmotion voiceover VIDEO` generates them with ElevenLabs. The word timings it caches are what
   scenes are timed to, so write scenes after this step.
3. **Theme and scenes.** Put colors (through `palette`), the background and reusable pieces in `theme.ts`. Each scene
   exports a function from `SceneCtx` to a node tree and adds tweens to `s.tl`.
4. **Check frames.** `bun cmotion still VIDEO <frame>...` renders frames without a full render: `<id>` (the settled
   end), `<id>:<seconds>` or `<id>@<word>` (`cue@now#2+0.5`). Several frames come back tiled in one image.
5. **Build.** `bun cmotion build VIDEO` generates what is missing (voiceovers, images, music), renders the scenes that
   changed and joins `script.mp4`. Run it after every edit: every step is cached. Use `-s <id>` to iterate on one scene.
6. **Review.** `bun cmotion inspect VIDEO` tiles every scene's settled end into one image. Run it after each build.
   `still` and `inspect` print the path of a new PNG and the layout problems they find (nodes leaving the frame or
   under a subtitle). Fix every one.

## Writing scenes

- Time animations to spoken words with `s.at("word")`, not seconds. A word said more than once needs `s.at("word", n)`.
  Offsets like `s.at("word") + 0.3` are fine.
- Use the helpers on `SceneCtx` (`pop`, `rise`, `show`) and `s.tl.to` / `s.tl.fromTo` with GSAP-style eases.
- Lay out anything sized by its text (chips, pills, labels side by side) in a `layout: "row"` or `"column"` box. Never
  compute x positions from estimated text widths. Row and column children take no x, y or anchor: use `pad`, `gap`,
  `offsetX`/`offsetY`, or `abs: true`.
- Use `counter` for numbers that count up, and `codeLines` for syntax-highlighted code.
- For effects (distortion, color, glow), wrap nodes in a `shader`: its GLSL defines `vec4 effect(vec2 p)` and reads
  the children with `source(p)`. Tween its uniforms with `s.tl.to(id, { uniforms: { name: v } }, t)`.
- The build type-checks scenes against the DSL, then rejects tweens of unknown ids, flow settings on a box without a
  layout, and ambiguous cue words. Read the error: it says what to change.

## Developing cmotion

- `src/` is the C engine (OpenGL in a headless EGL context, encoding with ffmpeg). `ts/` is the DSL (`ts/dsl.ts`), the
  compiler from scenes to render JSON (`ts/compile.ts`) and the CLI (`ts/cli.ts`, Effect).
- The engine builds itself on first use into `~/.cache/cmotion/engine-<hash of src/>/`, so changing `src/` rebuilds it
  on the next run.
- Run `bun lint` and `bun test` after a change. The golden test checks that renders stay bit-identical.
- Consumers pick up changes after a push and `bun remove cmotion && bun add github:laroccacharly/cmotion` in their repo.
- Benchmarks, profiling and optimization directions are in `docs/bench.md`.
