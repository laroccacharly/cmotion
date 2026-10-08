# cmotion

A C renderer for motion videos: an alternative to HyperFrames for simple scenes made of code, text and basic animation.

- **Script:** `videos/VIDEO/script.json` lists the scenes and their voiceovers. Each scene is TypeScript
  (`videos/VIDEO/scenes/<id>.ts`), written with the DSL in `ts/dsl.ts`.
  `ts/compile.ts` turns `at("word")` cues into seconds (from the cached voiceover timings), syntax-highlights code,
  and writes `videos/VIDEO/build/render.json`.
- **Engine:** `src/` (C11 and OpenGL 3.3 in a headless EGL context, with cJSON and stb vendored in `src/vendor/`). It lays out a small tree of boxes and single-line text
  (row, column or absolute), evaluates GSAP-style tweens and eases (position, scale, colors, box size and corner
  radius), and draws with OpenGL: SDF shaders for rounded panels, borders, dashes and shadows, glyph atlases for
  text, field nodes that show another box's distance field, and optional subtitles from the voiceover. It converts each frame to YUV 4:2:0 on the GPU and
  hands it to ffmpeg (libx264 plus the voiceover) on a writer thread.
- **Checks:** before compiling, the scenes and theme are type-checked against the DSL (`build/tsconfig.json`). The types
  only take the eases the engine draws, its fonts, CSS colors (a theme's colors go through `palette`), flow settings on a
  box with a layout, and children without their own position in a row or column. Compile then
  fails on tweens of ids no node has, spans without text, flow settings (pad, gap, align, justify) on a box without a
  layout, a non-zero x, y, relX, relY or anchor on a row or column child (the flow ignores them unless it is `abs`; the
  types refuse these too, as `Placed` nodes), and a cue word said more than once without saying which time.
- **Pipeline:** `ts/cli.ts` (Effect) generates new voiceovers with ElevenLabs and images with OpenAI, builds the engine
  with `cc` on first use into `~/.cache/cmotion/engine-<hash of src/>/` (about 1.5s; the fonts ship in `fonts/`), compiles
  the script, renders each scene to `videos/VIDEO/build/scenes/<id>.mp4`, and joins them into `videos/VIDEO/script.mp4`.
  Voiceovers and images are kept in `videos/VIDEO/generated/`.
  A scene is re-rendered only when its compiled JSON, the engine binary or the x264 settings change.

## Demo

[![cmotion demo](https://img.youtube.com/vi/ZH9IOFH1m04/maxresdefault.jpg)](https://youtu.be/ZH9IOFH1m04)

## Requirements

- [bun](https://bun.sh), and `ffmpeg` and `ffprobe` on the PATH
- To build the engine: a C compiler and the OpenGL and EGL development headers. It needs a GPU driver with EGL (Mesa or NVIDIA), not a display server
- `ELEVENLABS_API_KEY` and `OPENAI_API_KEY`, in the environment or the OS keyring

## Installation

```sh
bun add github:laroccacharly/cmotion#v0.1.0
```

## Benchmark: the lint video (8 scenes, 180.6s, 1920x1080 at 30fps, 12-core machine)

| | Time |
|---|---|
| HyperFrames, 8 scene renders at `draft` quality (x264 ultrafast, CRF 28) | 97.4s |
| HyperFrames stitch (x264 veryfast, CRF 18) | 10.4s |
| **HyperFrames total** | **107.9s** |
| cmotion: TypeScript compile | 0.3s |
| cmotion: render and encode the final video (x264 veryfast, CRF 18) | 15.3s |
| **Full build end to end** | **17.8s (about 6x faster)** |
| cmotion: drawing and GPU readback only, no encoding | 8.7s (621 fps) |

Compared with the HyperFrames `motion.mp4`, the output has the same 5419 frames, its audio is in sync, and its mean
SSIM is 0.966 (minimum 0.913).

## Where the time goes

A full build of the lint video takes 17.8s end to end:

| Step | Time |
|---|---|
| CLI startup (`bun cmotion`) | 0.13s |
| Voiceover cache check (8 ffprobe calls) | ~0.3s |
| Engine build check (no-op once built) | 0.01s |
| TypeScript compile (`bun ts/compile.ts`) | 0.4s |
| Engine startup (GL context, shaders, glyph atlases) | ~0.3s |
| **Render and encode (5419 frames)** | **15.3–15.9s** |

Inside render and encode, the render thread's time per frame (the engine prints this after every run):

| Stage | Without encoding (`--null`) | While encoding |
|---|---|---|
| Tween evaluation | ~0 ms | ~0 ms |
| Draw calls (CPU side) | 0.06 ms | 0.10 ms |
| GPU work, readback and copy | 1.51 ms | 2.77 ms |
| Waiting for a free writer slot | none | 0.04 ms |
| **Throughput** | **639 fps (8.5s)** | **341 fps (15.9s)** |

What the numbers show:

- **The render thread is the bottleneck, not the encoder queue.** It almost never waits on ffmpeg.
- **Readback gets slower under load.** Encoding nearly doubles readback time (1.5 to 2.8 ms). x264 uses all 12 cores, so the synchronous `glGetTexImage` and the copy that follows compete with it for CPU and memory bandwidth.
- **The encoder alone is about as fast as the renderer.**

  | Encoder (fed a pre-rendered stream) | Time for the whole video |
  |---|---|
  | x264 veryfast, CRF 18 | ~13s (~1m50s of CPU time) |
  | x264 ultrafast | ~10.7s |
  | VAAPI `h264_vaapi` on the Phoenix iGPU | ~15s (frees the CPU) |

  So once the renderer gets faster, the encoder will be the limit.
- **Most frames don't change.** 77% of frames (4176 of 5419) are identical to the one before: no tween is running.

## Optimization directions

Roughly in order of expected gain for effort:

1. **Skip frames that don't change. Done.** When no tween runs between two frames, the engine resends the last frame's bytes instead of drawing and reading back. On the lint video it reuses 4174 of 5419 frames. Drawing and readback drop from 8.7s to 2.0s, and render plus encode from 15.3s to 11.8s, which now mostly waits on ffmpeg: the encoder is the limit. The output is bit-identical (a golden test checks this on a fixture scene).
2. **Asynchronous readback with PBOs.** Read frame N into a pixel buffer object while the GPU draws frame N+1, and map it a frame later. This takes the GPU wait off the render thread. Reading straight into the writer slot also removes the 3 MB `malloc` and `memcpy` per frame. It mostly attacks the 1.5–2.8 ms readback.
3. **Cheaper or offloaded encoding.**
   - **Hardware encoder:** VAAPI on this machine, NVENC elsewhere. It leaves the CPU free for the renderer. Feeding NV12 frames that stay on the GPU (a dmabuf/EGL export into VAAPI) would avoid the readback entirely.
   - **x264 trade-offs:** tuning `-threads` and `-x264-params` so x264 leaves a core for the render thread. `ultrafast` is not worth it: with frame skipping, the engine renders and encodes the lint video in 11.1s with `ultrafast` against 12.3s with `veryfast` (about 1.3s, 10%), and the file is three times larger (33.4 MB against 10.9 MB).
4. **Render scenes in parallel.** Scenes are independent: run N engine processes, each encoding its own scenes, then join them with ffmpeg's concat demuxer and `-c copy`, which doesn't re-encode. This splits the work across cores and GPU queues. The cost is a few small files to stitch.
5. **Cache unchanged scenes. Done.** The build hashes each compiled scene with the engine binary and x264 settings, and re-renders only the scenes that changed, two engines at a time. The join copies the video and re-encodes only the audio, since copied AAC carries each file's encoder padding and drifted the voiceover 55 ms by the last lint scene. On the lint video: a cold build renders and joins in 15.6s (12.8s rendering, about 3s joining, against 12.3s for one pass), an unchanged build takes 0.0s, and changing one scene takes 4.9s, most of it the join.
6. **Headless GL context. Done.** The engine opens a surfaceless EGL context instead of a hidden X11 window, so it runs on servers and in CI without a display. Replacing raylib with a small GL layer (`src/gl.c`) kept the output bit-identical.
7. **Smaller fixed costs.** The per-scene ffprobe calls could be cut by caching durations in the voiceover cache JSON. That's worth ~0.3s per build, which matters once rendering itself takes seconds.

Draw batching and SDF shader cost are not worth working on: draw calls take 0.1 ms per frame, and the shaders take a small part of the 1.5 ms GPU and readback time.

## Feature directions

Ideas taken from [fframes](https://github.com/dmtrKovalenko/fframes), a Rust video framework where a video is a function from frame to SVG tree. Rendering the Claude Haiku 5.5 announcement with both showed where cmotion falls short. cmotion's speed comes from its declarative timeline: it can skip frames where no tween runs and cache unchanged scenes. So the additions below extend the vocabulary of nodes and tweens and keep that model.

Roughly in order of expected gain for effort:

1. **Number tweens on text.** A `count` property on text nodes, for example `{ to: 75, suffix: "%", decimals: 0 }`, so the engine formats the text from the tweened value. Today a bar can grow but its number only appears; data scenes need counters.
2. **Rotation.** A `rotate` property on boxes and images, applied in the node transform. It enables dials, spinners and accent shapes, none of which can be built today.
3. **`strip` and `inspect` commands. Mostly done:** `inspect` tiles each scene's settled end into one labelled image, and `still` takes several frames (by seconds or by spoken word) and tiles them, which covers `strip`. Both print the layout problems the engine finds by sampling each scene every 0.25s: painted nodes that leave the frame or sit under a showing subtitle for half a second or more (images by their opaque pixels). Still to do: overlapping siblings and text wider than its box.
4. **Spring ease.** A `spring(mass, stiffness, damping)` ease, computed in closed form. Settling motion looks better than `back.out`, and it takes a few lines of C.
5. **Wrapping and fitting text.** Multi-line text within a width, rows that wrap (`wrap: true`) for lists of chips, and text that shrinks to fit or ends with an ellipsis.
6. **Strokes and arcs.** Lines, rings and arc progress in the existing SDF shader. That covers charts, gauges and dials without a general path renderer.

Some of the gap is in the scenes, not the engine: layouts on a grid with left alignment, one large number per scene, and fewer centered stacks of title and chips. That belongs in themes and agent guidance, and shared components such as bar charts or stat blocks can be written in TypeScript on top of the DSL.

Not worth taking from fframes: SVG as the scene format or general SVG paths, per-frame code (it would break frame skipping and the scene cache), shaders, a browser editor, several render backends, and cross-fades between scenes (they would break the `-c copy` join).
