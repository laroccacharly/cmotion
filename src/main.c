// cmotion CLI: render a compiled video.json to an mp4 (through an ffmpeg pipe) or to still PNGs.
#include <libgen.h>
#include <math.h>
#include <pthread.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#include "cmotion.h"
#include "gl.h"
#include "stb_image_write.h"

static void usage(void) {
  fprintf(stderr,
          "usage: cmotion VIDEO.json -o OUT.mp4 [options]\n"
          "  -o PATH           output mp4 (or png with --still)\n"
          "  -s, --scene ID    only this scene (repeatable)\n"
          "  --still ID:SEC    write one frame of scene ID at SEC seconds as a PNG to -o\n"
          "  --bounds          with --still: also print, as JSON on stdout, nodes of the scene that leave the frame\n"
          "                    or sit under a showing subtitle, sampled every 0.25s\n"
          "  --preset NAME     x264 preset (default veryfast)\n"
          "  --crf N           x264 CRF (default 18)\n"
          "  --null            render and read back every frame, but encode nothing (benchmark)\n"
          "  --fonts DIR       font directory (default: fonts next to the binary's folder)\n");
  exit(2);
}

static double now(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return ts.tv_sec + ts.tv_nsec / 1e9;
}

// Single-quoted for the shell.
static void shq(char *out, size_t cap, const char *s) {
  size_t n = 0;
  out[n++] = '\'';
  for (; *s && n + 5 < cap; s++) {
    if (*s == '\'') { memcpy(out + n, "'\\''", 4); n += 4; }
    else out[n++] = *s;
  }
  out[n++] = '\'';
  out[n] = 0;
}

// Whole frames per scene, rounded up like HyperFrames; the scene's audio is cut to exactly this length.
static int scene_frames(const Scene *s, int fps) { return (int)ceilf(s->duration * fps - 1e-3f); }

static FILE *open_encoder(const Video *v, Scene **sel, int nsel, const char *out, const char *preset, const char *crf) {
  size_t cap = 65536;
  char *cmd = malloc(cap), q[2048];
  // Frames arrive as I420 already converted on the GPU (BT.709, limited range).
  int n = snprintf(cmd, cap,
                   "ffmpeg -v error -y -f rawvideo -pix_fmt yuv420p -color_range tv -colorspace bt709 -color_primaries bt709 "
                   "-color_trc bt709 -s %dx%d -r %d -i -",
                   v->width, v->height, v->fps);
  for (int i = 0; i < nsel; i++) {
    shq(q, sizeof q, sel[i]->audio);
    n += sel[i]->audio[0] ? snprintf(cmd + n, cap - n, " -i %s", q)
                          : snprintf(cmd + n, cap - n, " -f lavfi -t 0.1 -i anullsrc=r=48000:cl=stereo");
  }
  // Each scene's voiceover starts at its lead-in and is padded or cut to the scene length, then all are joined.
  n += snprintf(cmd + n, cap - n, " -filter_complex '");
  for (int i = 0; i < nsel; i++)
    n += snprintf(cmd + n, cap - n, "[%d:a]aformat=sample_rates=48000:channel_layouts=stereo,adelay=%d:all=1,apad,atrim=0:%.4f[a%d];",
                  i + 1, (int)(sel[i]->audio_start * 1000 + 0.5f), (double)scene_frames(sel[i], v->fps) / v->fps, i);
  for (int i = 0; i < nsel; i++) n += snprintf(cmd + n, cap - n, "[a%d]", i);
  shq(q, sizeof q, out);
  n += snprintf(cmd + n, cap - n,
                "concat=n=%d:v=0:a=1[a]' -map 0:v -map '[a]' -c:v libx264 -preset %s -crf %s -pix_fmt yuv420p -colorspace bt709 "
                "-color_primaries bt709 -color_trc bt709 -color_range tv "
                "-c:a aac -b:a 192k -movflags +faststart %s",
                nsel, preset, crf, q);
  FILE *f = popen(cmd, "w");
  if (!f) fprintf(stderr, "cannot start: %s\n", cmd);
  free(cmd);
  return f;
}

// Reads the frame back top-down as rgb.
static void read_frame(Fbo f, unsigned char *rgb) {
  unsigned char *px = malloc((size_t)f.w * f.h * 4);
  gl_read(f, px);
  for (int y = 0; y < f.h; y++)
    for (int x = 0; x < f.w; x++) memcpy(rgb + ((size_t)y * f.w + x) * 3, px + ((size_t)(f.h - 1 - y) * f.w + x) * 4, 3);
  free(px);
}

// Frames go to ffmpeg from a writer thread, so drawing the next frame overlaps encoding the last one.
#define SLOTS 4
typedef struct {
  FILE *out;
  size_t size;
  unsigned char *buf[SLOTS];
  int head, tail, count;  // filled slots: [tail, head)
  bool done, failed;
  pthread_mutex_t mu;
  pthread_cond_t cv;
} Writer;

static void *writer_main(void *arg) {
  Writer *w = arg;
  for (;;) {
    pthread_mutex_lock(&w->mu);
    while (!w->count && !w->done) pthread_cond_wait(&w->cv, &w->mu);
    if (!w->count && w->done) {
      pthread_mutex_unlock(&w->mu);
      return NULL;
    }
    unsigned char *buf = w->buf[w->tail];
    pthread_mutex_unlock(&w->mu);
    bool ok = fwrite(buf, 1, w->size, w->out) == w->size;
    pthread_mutex_lock(&w->mu);
    w->failed |= !ok;
    w->tail = (w->tail + 1) % SLOTS;
    w->count--;
    pthread_cond_broadcast(&w->cv);
    pthread_mutex_unlock(&w->mu);
  }
}

// The next free slot to fill, waiting while the writer is behind.
static unsigned char *writer_slot(Writer *w) {
  pthread_mutex_lock(&w->mu);
  while (w->count == SLOTS) pthread_cond_wait(&w->cv, &w->mu);
  unsigned char *buf = w->buf[w->head];
  pthread_mutex_unlock(&w->mu);
  return buf;
}

static bool writer_push(Writer *w) {
  pthread_mutex_lock(&w->mu);
  w->head = (w->head + 1) % SLOTS;
  w->count++;
  bool failed = w->failed;
  pthread_cond_broadcast(&w->cv);
  pthread_mutex_unlock(&w->mu);
  return !failed;
}

int main(int argc, char **argv) {
  const char *in = NULL, *out = NULL, *still = NULL, *fonts = NULL, *preset = "veryfast", *crf = "18";
  const char *only[64];
  int nonly = 0;
  bool null_out = false, bounds = false;
  for (int i = 1; i < argc; i++) {
    const char *a = argv[i];
    bool more = i + 1 < argc;
    if (!strcmp(a, "-o") && more) out = argv[++i];
    else if ((!strcmp(a, "-s") || !strcmp(a, "--scene")) && more && nonly < 64) only[nonly++] = argv[++i];
    else if (!strcmp(a, "--still") && more) still = argv[++i];
    else if (!strcmp(a, "--preset") && more) preset = argv[++i];
    else if (!strcmp(a, "--crf") && more) crf = argv[++i];
    else if (!strcmp(a, "--fonts") && more) fonts = argv[++i];
    else if (!strcmp(a, "--null")) null_out = true;
    else if (!strcmp(a, "--bounds")) bounds = true;
    else if (a[0] == '-') usage();
    else in = a;
  }
  if (!in || (!out && !null_out)) usage();

  char err[512], exe[1024], font_dir[1100];
  Video v;
  if (!video_load(&v, in, err, sizeof err)) {
    fprintf(stderr, "cmotion: %s\n", err);
    return 1;
  }
  if (!fonts) {
    ssize_t len = readlink("/proc/self/exe", exe, sizeof exe - 1);
    exe[len > 0 ? len : 0] = 0;
    snprintf(font_dir, sizeof font_dir, "%s/../fonts", dirname(exe));
    fonts = font_dir;
  }

  // Selected scenes, in plan order.
  Scene *sel[256];
  int nsel = 0;
  float still_t = 0;
  if (still) {
    char id[128];
    const char *colon = strrchr(still, ':');
    if (!colon) usage();
    snprintf(id, sizeof id, "%.*s", (int)(colon - still), still);
    still_t = strtof(colon + 1, NULL);
    only[0] = strdup(id);
    nonly = 1;
  }
  for (int i = 0; i < v.nscenes && nsel < 256; i++) {
    bool want = nonly == 0;
    for (int j = 0; j < nonly; j++) want |= !strcmp(only[j], v.scenes[i].id);
    if (want) sel[nsel++] = &v.scenes[i];
  }
  if (!nsel) {
    fprintf(stderr, "cmotion: no scene matches\n");
    return 1;
  }

  if (!gl_init(err, sizeof err)) {
    fprintf(stderr, "cmotion: %s\n", err);
    return 1;
  }
  Fbo rt = gl_fbo(v.width, v.height);
  if (!fonts_load(fonts, err, sizeof err)) {
    fprintf(stderr, "cmotion: %s\n", err);
    return 1;
  }
  render_init(v.width, v.height);
  for (int i = 0; i < nsel; i++) {
    if (!scene_images_load(sel[i], err, sizeof err)) {
      fprintf(stderr, "cmotion: %s\n", err);
      return 1;
    }
    scene_layout(sel[i]);
  }

  if (still) {
    unsigned char *rgb = malloc((size_t)v.width * v.height * 3);
    scene_eval(sel[0], still_t);
    gl_begin(rt);
    render_scene(sel[0]);
    read_frame(rt, rgb);
    bool ok = stbi_write_png(out, v.width, v.height, 3, rgb, v.width * 3);
    if (bounds) {
      char *json = render_bounds(sel[0], 0.25f);
      printf("%s\n", json);
      free(json);
    }
    gl_close();
    return ok ? 0 : 1;
  }

  FILE *enc = null_out ? NULL : open_encoder(&v, sel, nsel, out, preset, crf);
  if (!null_out && !enc) return 1;
  Fbo yuv = gl_fbo(v.width / 4, v.height * 3 / 2);
  Writer w = {.out = enc, .size = (size_t)v.width * v.height * 3 / 2};
  for (int i = 0; i < SLOTS; i++) w.buf[i] = malloc(w.size);
  pthread_mutex_init(&w.mu, NULL);
  pthread_cond_init(&w.cv, NULL);
  pthread_t writer;
  if (enc) pthread_create(&writer, NULL, writer_main, &w);

  // Per-stage wall time on the render thread. GPU work is asynchronous, so "readback" includes waiting for the GPU.
  double t0 = now(), wait_s = 0, eval_s = 0, draw_s = 0, read_s = 0;
  long frames = 0, reused = 0;
  unsigned char *last = NULL;  // the previous frame's bytes
  for (int i = 0; i < nsel; i++) {
    Scene *s = sel[i];
    int n = scene_frames(s, v.fps);
    for (int f = 0; f < n; f++) {
      double a = now();
      unsigned char *slot = enc ? writer_slot(&w) : w.buf[0];
      double b = now(), c = b, d = b, e = b;
      // No tween runs since the last frame: resend its bytes instead of drawing and reading back.
      if (f > 0 && scene_still(s, (float)(f - 1) / v.fps, (float)f / v.fps)) {
        if (slot != last) memcpy(slot, last, w.size);
        reused++;
      } else {
        scene_eval(s, (float)f / v.fps);
        c = now();
        gl_begin(rt);
        render_scene(s);
        render_yuv(rt, yuv);
        d = now();
        gl_read(yuv, slot);  // exactly w.size bytes: (w / 4) x (h * 3 / 2) RGBA texels
        e = now();
      }
      last = slot;
      wait_s += b - a;
      eval_s += c - b;
      draw_s += d - c;
      read_s += e - d;
      if (enc && !writer_push(&w)) {
        fprintf(stderr, "cmotion: ffmpeg stopped accepting frames\n");
        return 1;
      }
      frames++;
    }
    fprintf(stderr, "  scene %s: %d frames\n", s->id, n);
  }
  if (enc) {
    pthread_mutex_lock(&w.mu);
    w.done = true;
    pthread_cond_broadcast(&w.cv);
    pthread_mutex_unlock(&w.mu);
    pthread_join(writer, NULL);
  }
  int status = enc ? pclose(enc) : 0;
  double total = now() - t0, ms = 1000.0 / frames;
  fprintf(stderr, "cmotion: %ld frames (%.1fs of video, %ld unchanged and reused) in %.2fs (%.0f fps)\n", frames, (double)frames / v.fps,
          reused, total, frames / total);
  fprintf(stderr, "  tweens %.2fs (%.2f ms/frame), draw calls %.2fs (%.2f), GPU + readback %.2fs (%.2f), waiting on ffmpeg %.2fs (%.2f)\n",
          eval_s, eval_s * ms, draw_s, draw_s * ms, read_s, read_s * ms, wait_s, wait_s * ms);
  gl_close();
  return status == 0 ? 0 : 1;
}
