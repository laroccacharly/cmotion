// cmotion: renders a compiled motion video (video.json) to frames, then pipes them to ffmpeg.
//
// The scene graph is a tree of boxes, single-line text nodes and images. Layout is a tiny flexbox
// (row / column / absolute). Animations are tweens on named targets (nodes or code tokens),
// already resolved to seconds by the TypeScript compiler.
#pragma once
#include <stdbool.h>
#include <stdio.h>

#include "gl.h"

typedef struct { float r, g, b, a; } Col;

enum { LAYOUT_NONE, LAYOUT_ROW, LAYOUT_COLUMN };
enum { ALIGN_START, ALIGN_CENTER, ALIGN_END };

// Animatable properties. Every target carries all of them; most stay at their base value.
enum {
  P_OPACITY, P_X, P_Y, P_SCALE, P_GRAY, // transform and filter
  P_COLOR,                              // inherited text color (alpha 0 = inherit)
  P_FILL, P_BORDER,                     // box paint
  P_FG, P_BG,                           // code token override color and highlight
  P_W, P_H, P_RADIUS,                   // drawn box size (base: the laid-out size) and corner radius
  P_SPACING,                            // field contour spacing
  P_VALUE,                              // the number a count text node shows
  P_ROTATE,                             // image rotation in degrees, about the center
  P_COUNT
};

typedef struct { float v[4]; } Val;

typedef struct {
  char id[64];
  Val base[P_COUNT];
  Val cur[P_COUNT];
} Target;

typedef struct {
  char *text;
  int font;     // index into the font table
  float size;   // CSS px
  Col color;    // alpha 0 = inherit from the node
  int tok;      // target index of the code token this span belongs to, or -1
  float width;  // measured advance
} Span;

typedef struct Node Node;
struct Node {
  int target;         // index into targets
  bool is_text;
  bool is_field;      // draws the signed distance field of `shape`, colored by fill (inside) and border (outside)
  Node *shape;
  bool is_image;      // draws the PNG at `src`, cropped to fill its box (object-fit: cover)
  char *src;
  unsigned int tex; int tex_w, tex_h;  // GL texture, premultiplied alpha with mipmaps; loaded by scene_images_load
  int opaque[4];      // the texture's visible pixels (alpha > 16): x0, y0, x1, y1, for layout checks
  // layout input
  float x, y, w, h;   // x/y are offsets for absolute children; w/h < 0 means auto
  float rel_x, rel_y;     // absolute children: extra offset as a fraction of the parent size (CSS left: 50%)
  float anchor_x, anchor_y;  // fraction of the node's own size to shift back (GSAP xPercent: -50 is 0.5)
  bool abs;           // absolute child inside a row/column parent
  bool push_end;      // margin-left: auto inside a row
  int layout, align, justify;
  float gap, pad[4];  // pad: top right bottom left
  // box paint
  float radius, border_width, dash, bar_width;
  Col bar_color;
  bool shadow;
  // text
  Span *spans; int nspans;
  bool is_count;      // shows P_VALUE as prefix + number + suffix instead of its spans
  int decimals;
  char *prefix, *suffix;
  int font; float size, line_height, letter_spacing; int text_align;
  // children
  Node *kids; int nkids;
  // layout output: border box in scene coordinates
  float ax, ay, aw, ah;
};

typedef struct {
  int target, prop;
  bool has_from;
  Val from, to;
  float start, dur;
  int ease; float ease_arg;
  int order;         // position in the JSON, to keep ties in authoring order
  Val resolved_from; // value at start, computed once at layout
} Tween;

// A subtitle line, shown from start to end (scene seconds).
typedef struct {
  char *text;
  float start, end;
  float width;  // measured advance
} Cue;

typedef struct {
  char id[64];
  float duration, audio_start;
  char audio[1024];
  Col bg_inner, bg_outer;  // background radial gradient: center color, and the color from 70% out
  Node root;
  Target *targets; int ntargets;
  Tween *tweens; int ntweens;
  Cue *subs; int nsubs;
  int sub;  // the cue showing at the last scene_eval time, or -1
} Scene;

// Subtitle look: white text on a dark rounded plate, centered near the bottom.
#define SUB_FONT "inter-600"
#define SUB_SIZE 42.0f

typedef struct {
  int width, height, fps;
  Scene *scenes; int nscenes;
} Video;

// scene.c
bool video_load(Video *v, const char *path, char *err, int errlen);
void scene_layout(Scene *s);
void scene_eval(Scene *s, float t);
bool scene_still(const Scene *s, float t1, float t2);  // the scene looks the same at t2 as at t1 (t1 < t2)

// font.c
#define MAX_FONTS 8
int font_index(const char *name);          // registers a font name like "inter-600"
void font_need(int font, float size, const char *text);
bool fonts_load(const char *dir, char *err, int errlen);
float font_advance(int font, float size, const char *text, float letter_spacing);
float font_ascent(int font, float size);   // hhea, in px
float font_content_height(int font, float size);
void font_draw(int font, float size, const char *text, float x, float baseline, float scale, float letter_spacing, Col c);

// render.c
void render_init(int w, int h);
void render_scene(Scene *s);
// JSON array of layout issues found sampling the scene every `step` seconds (render.c).
char *render_bounds(Scene *s, float step);
bool scene_images_load(Scene *s, char *err, int errlen);  // needs the GL context
void render_yuv(Fbo frame, Fbo target);  // frame -> I420 bytes in a (w/4) x (h*3/2) target

// shared helpers
static inline Col col_mul_alpha(Col c, float a) { c.a *= a; return c; }
