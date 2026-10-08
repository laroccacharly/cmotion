# Benchmarks

All numbers are for the lint video: 8 scenes, 180.6s, 5419 frames at 1920x1080 and 30fps, on a 12-core machine,
encoded with x264 veryfast at CRF 18.

## Against HyperFrames

| | Time |
|---|---|
| HyperFrames: 8 scene renders at `draft` quality (x264 ultrafast, CRF 28) | 97.4s |
| HyperFrames: stitch | 10.4s |
| **HyperFrames total** | **107.9s** |
| **cmotion full build, first version** | **17.8s (about 6x faster)** |

The output has the same 5419 frames as the HyperFrames `motion.mp4`, its audio is in sync, and its mean SSIM is 0.966
(minimum 0.913).

## Current numbers

| | Time |
|---|---|
| Cold build: render and join | 15.6s (12.8s rendering, about 3s joining) |
| One pass, render and encode | 12.3s (11.1s with x264 ultrafast) |
| Drawing and GPU readback only, no encoding | 2.0s |
| Change one scene | 4.9s, most of it the join |
| Nothing changed | 0.0s |

## Profile

Measured before frame skipping, so drawing and readback ran on every frame. Fixed costs per build:

| Step | Time |
|---|---|
| CLI startup (`bun cmotion`) | 0.13s |
| Voiceover cache check (8 ffprobe calls) | ~0.3s |
| Engine build check (no-op once built) | 0.01s |
| TypeScript compile | 0.4s |
| Engine startup (GL context, shaders, glyph atlases) | ~0.3s |

The render thread's time per frame (the engine prints this after every run):

| Stage | Without encoding (`--null`) | While encoding |
|---|---|---|
| Tween evaluation | ~0 ms | ~0 ms |
| Draw calls (CPU side) | 0.06 ms | 0.10 ms |
| GPU work, readback and copy | 1.51 ms | 2.77 ms |
| Waiting for a free writer slot | none | 0.04 ms |
| **Throughput** | **639 fps (8.5s)** | **341 fps (15.9s)** |

The encoder alone, fed a pre-rendered stream:

| Encoder | Time for the whole video |
|---|---|
| x264 veryfast, CRF 18 | ~13s (~1m50s of CPU time) |
| x264 ultrafast | ~10.7s |
| VAAPI `h264_vaapi` on the Phoenix iGPU | ~15s (frees the CPU) |

What this shows:

- **The encoder is now the limit.** With frame skipping, drawing and readback take 2.0s of a 12.3s pass.
- **Readback slows down under load.** Encoding nearly doubles it (1.5 to 2.8 ms), because x264 on all 12 cores competes
  with the synchronous `glGetTexImage` and the copy after it for CPU and memory bandwidth.
- **Draw batching and SDF shader cost are not worth working on.** Draw calls take 0.1 ms per frame, and the shaders are
  a small part of the GPU and readback time.

## Done

- **Skip frames that don't change.** When no tween runs, the engine resends the last frame instead of drawing and
  reading back. It reuses 4174 of 5419 frames, which cut drawing and readback from 8.7s to 2.0s. The output is
  bit-identical, which a golden test checks on a fixture scene.
- **Cache unchanged scenes.** The build hashes each compiled scene with the engine binary and x264 settings, and
  re-renders only the scenes that changed, two engines at a time. The join copies the video and re-encodes only the
  audio: copied AAC carries each file's encoder padding, which drifted the voiceover 55 ms by the last scene.
- **Headless GL context.** The engine opens a surfaceless EGL context, so it runs on servers and in CI without a
  display. Replacing raylib with a small GL layer (`src/gl.c`) kept the output bit-identical.

## Directions

Roughly in order of expected gain for effort:

1. **Hardware or tuned encoding.** VAAPI here, NVENC elsewhere, leaves the CPU to the renderer, and exporting NV12
   frames that stay on the GPU (dmabuf into VAAPI) would remove the readback. For x264, tune `-threads` and
   `-x264-params` so it leaves a core to the render thread. `ultrafast` is not worth it: 10% faster for a file three
   times larger (33.4 MB against 10.9 MB).
2. **Asynchronous readback with PBOs.** Read frame N into a pixel buffer object while the GPU draws frame N+1, and map
   it a frame later. Reading straight into the writer slot also removes the 3 MB `malloc` and `memcpy` per frame.
3. **More scenes in parallel.** The build runs two engines at a time; more could use spare cores and GPU queues once
   encoding is lighter.
4. **Smaller fixed costs.** Caching voiceover durations in the voiceover cache JSON would remove the per-scene ffprobe
   calls, about 0.3s per build.
