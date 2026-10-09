// Draws a laid-out scene with OpenGL: an SDF shader for boxes (fill, border, dashes, soft shadow)
// and the background gradient, atlas quads for text, and mipmapped textures for images.
#include <math.h>
#include <stdlib.h>
#include <string.h>

#include "cJSON.h"
#include "cmotion.h"
#include "gl.h"
#include "stb_image.h"

static const char *BOX_FS =
    "#version 330\n"
    "out vec4 finalColor;\n"
    "uniform vec4 uRect; uniform float uRadius; uniform vec4 uFill; uniform vec4 uBorder; uniform float uBorderW;\n"
    "uniform float uDash; uniform vec4 uShadow; uniform vec3 uShadowGeom; uniform vec4 uBar; uniform float uBarW;\n"
    "uniform float uFbH;\n"
    "float sdRound(vec2 p, vec2 b, float r) { vec2 q = abs(p) - b + r; return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r; }\n"
    "float erf_(float x) { float s = sign(x), a = abs(x); float t = 1.0 / (1.0 + 0.3275911 * a);\n"
    "  return s * (1.0 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * exp(-a * a)); }\n"
    "vec4 pm(vec4 c) { return vec4(c.rgb * c.a, c.a); }\n"
    "vec4 over(vec4 top, vec4 bot) { return top + bot * (1.0 - top.a); }\n"
    "void main() {\n"
    "  vec2 p = vec2(gl_FragCoord.x, uFbH - gl_FragCoord.y);\n"
    "  vec2 hb = uRect.zw * 0.5; vec2 c = uRect.xy + hb;\n"
    "  float r = min(uRadius, min(hb.x, hb.y));\n"
    "  float d = sdRound(p - c, hb, r);\n"
    "  vec4 acc = vec4(0.0);\n"
    "  if (uShadow.a > 0.0) {\n"
    "    float ds = sdRound(p - c - uShadowGeom.xy, hb, r);\n"
    "    float a = uShadow.a * 0.5 * (1.0 - erf_(ds / (uShadowGeom.z * 1.41421)));\n"
    "    a *= clamp(d + 0.5, 0.0, 1.0);\n"  // like CSS, no shadow under the box itself
    "    acc = vec4(uShadow.rgb * a, a);\n"
    "  }\n"
    "  float inside = clamp(0.5 - d, 0.0, 1.0);\n"
    "  vec4 fill = (uBarW > 0.0 && p.x < uRect.x + uBarW) ? uBar : uFill;\n"
    "  acc = over(pm(fill) * inside, acc);\n"
    "  if (uBorderW > 0.0 && uBorder.a > 0.0) {\n"
    "    float cov = inside - clamp(0.5 - (d + uBorderW), 0.0, 1.0);\n"
    "    if (uDash > 0.0) {\n"
    "      vec2 q = abs(p - c) - hb;\n"
    "      float t = q.y > q.x ? p.x - uRect.x : p.y - uRect.y;\n"
    "      cov *= step(mod(t, 2.0 * uDash), uDash);\n"
    "    }\n"
    "    acc = over(pm(uBorder) * cov, acc);\n"
    "  }\n"
    "  if (acc.a <= 0.0) discard;\n"
    "  finalColor = vec4(acc.rgb / acc.a, acc.a);\n"
    "}\n";

// The signed distance to a rounded box, as a heat map: fill color inside, border color outside, darker near the
// edge, a contour every uSpacing px and a white line where the distance is zero. Clipped to the field's own box.
static const char *FIELD_FS =
    "#version 330\n"
    "out vec4 finalColor;\n"
    "uniform vec4 uRect; uniform float uRectR; uniform vec4 uShape; uniform float uRadius;\n"
    "uniform vec4 uIn; uniform vec4 uOut; uniform float uSpacing; uniform float uOpacity; uniform float uFbH;\n"
    "float sdRound(vec2 p, vec2 b, float r) { vec2 q = abs(p) - b + r; return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r; }\n"
    "void main() {\n"
    "  vec2 p = vec2(gl_FragCoord.x, uFbH - gl_FragCoord.y);\n"
    "  float clip = clamp(0.5 - sdRound(p - uRect.xy - uRect.zw * 0.5, uRect.zw * 0.5, uRectR), 0.0, 1.0);\n"
    "  vec2 hb = uShape.zw * 0.5;\n"
    "  float d = sdRound(p - uShape.xy - hb, hb, min(uRadius, min(hb.x, hb.y)));\n"
    "  vec3 col = d < 0.0 ? uIn.rgb : uOut.rgb;\n"
    "  col *= 0.45 + 0.55 * (1.0 - exp(-abs(d) / (uSpacing * 2.0)));\n"
    "  col *= 0.8 + 0.2 * cos(6.2831853 * d / uSpacing);\n"
    "  col = mix(col, vec3(1.0), 1.0 - smoothstep(1.0, 3.0, abs(d)));\n"
    "  if (clip * uOpacity <= 0.0) discard;\n"
    "  finalColor = vec4(col, clip * uOpacity);\n"
    "}\n";

// An image texture (premultiplied alpha) clipped to a rounded rect, with the node's grayscale and opacity.
static const char *IMG_FS =
    "#version 330\n"
    "in vec2 fragTexCoord; out vec4 finalColor;\n"
    "uniform sampler2D texture0; uniform vec4 uRect; uniform float uRadius; uniform float uOpacity; uniform float uGray;\n"
    "uniform float uFbH;\n"
    "float sdRound(vec2 p, vec2 b, float r) { vec2 q = abs(p) - b + r; return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r; }\n"
    "void main() {\n"
    "  vec2 p = vec2(gl_FragCoord.x, uFbH - gl_FragCoord.y);\n"
    "  vec2 hb = uRect.zw * 0.5;\n"
    "  float cov = clamp(0.5 - sdRound(p - uRect.xy - hb, hb, min(uRadius, min(hb.x, hb.y))), 0.0, 1.0) * uOpacity;\n"
    "  vec4 c = texture(texture0, fragTexCoord);\n"
    "  c.rgb = mix(c.rgb, vec3(dot(c.rgb, vec3(0.2126, 0.7152, 0.0722))), uGray);\n"
    "  if (c.a * cov <= 0.0) discard;\n"
    "  finalColor = c * cov;\n"
    "}\n";

// radial-gradient(ellipse at 50% 40%, uInner 0%, uOuter 70%), dithered against banding. Colors are 0..255.
static const char *BG_FS =
    "#version 330\n"
    "out vec4 finalColor;\n"
    "uniform vec2 uSize; uniform float uOpacity; uniform vec3 uInner, uOuter;\n"
    "void main() {\n"
    "  vec2 p = vec2(gl_FragCoord.x, uSize.y - gl_FragCoord.y);\n"
    "  vec2 c = vec2(uSize.x * 0.5, uSize.y * 0.4);\n"
    // farthest-corner ellipse: the farthest-side aspect ratio, scaled through the corner (CSS Images 3)
    "  vec2 far = vec2(max(c.x, uSize.x - c.x), max(c.y, uSize.y - c.y));\n"
    "  float t = clamp(length((p - c) / (far * 1.41421356)) / 0.7, 0.0, 1.0);\n"
    "  vec3 col = mix(uInner, uOuter, t) / 255.0;\n"
    "  float n = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);\n"
    "  col += (n - 0.5) / 255.0;\n"
    "  finalColor = vec4(col, uOpacity);\n"
    "}\n";

// Packs the frame into I420 bytes (BT.709, limited range), four bytes per RGBA texel, in the order ffmpeg's
// rawvideo yuv420p expects. Rows come out bottom-up in GL, which is exactly the order a readback returns them.
static const char *YUV_FS =
    "#version 330\n"
    "out vec4 finalColor;\n"
    "uniform sampler2D texture0; uniform ivec2 uSize;\n"
    "vec3 rgb(int x, int y) { return texelFetch(texture0, ivec2(x, uSize.y - 1 - y), 0).rgb; }\n"
    "float byteAt(int b) {\n"
    "  int w = uSize.x, h = uSize.y, ysize = w * h, csize = ysize / 4;\n"
    "  if (b < ysize) {\n"
    "    vec3 c = rgb(b % w, b / w);\n"
    "    return (16.0 + 219.0 * dot(c, vec3(0.2126, 0.7152, 0.0722))) / 255.0;\n"
    "  }\n"
    "  bool isU = b < ysize + csize;\n"
    "  int i = b - ysize - (isU ? 0 : csize), cx = (i % (w / 2)) * 2, cy = (i / (w / 2)) * 2;\n"
    "  vec3 c = (rgb(cx, cy) + rgb(cx + 1, cy) + rgb(cx, cy + 1) + rgb(cx + 1, cy + 1)) * 0.25;\n"
    "  float v = isU ? dot(c, vec3(-0.1146, -0.3854, 0.5)) : dot(c, vec3(0.5, -0.4542, -0.0458));\n"
    "  return (128.0 + 224.0 * v) / 255.0;\n"
    "}\n"
    "void main() {\n"
    "  int b = (int(gl_FragCoord.y) * (uSize.x / 4) + int(gl_FragCoord.x)) * 4;\n"
    "  finalColor = vec4(byteAt(b), byteAt(b + 1), byteAt(b + 2), byteAt(b + 3));\n"
    "}\n";

// What a shader node's code is wrapped in. The code defines `vec4 effect(vec2 p)`: the premultiplied color at p, in px
// from the top left of the node's box (iResolution is its size). `source(p)` reads the node's children drawn into a
// layer, premultiplied, anywhere in the frame. The node's own uniforms are declared before the code.
static const char *SHADER_HEAD =
    "#version 330\n"
    "out vec4 finalColor;\n"
    "uniform sampler2D iChannel0; uniform vec4 uRect; uniform vec2 iResolution; uniform float iTime, uOpacity, uFbH;\n"
    "vec4 source(vec2 p) {\n"
    "  vec2 s = uRect.xy + p * uRect.zw / iResolution;\n"
    "  return texture(iChannel0, vec2(s.x, uFbH - s.y) / vec2(textureSize(iChannel0, 0)));\n"
    "}\n"
    "vec4 effect(vec2 p);\n"
    "void main() {\n"
    "  vec2 s = vec2(gl_FragCoord.x, uFbH - gl_FragCoord.y);\n"
    "  finalColor = effect((s - uRect.xy) * iResolution / uRect.zw) * uOpacity;\n"
    "}\n";
static const char *SHADER_BUILTINS[6] = {"iChannel0", "uRect", "iResolution", "iTime", "uOpacity", "uFbH"};

// One layer per level of nested shader nodes, made when first needed.
#define MAX_LAYERS 4
static Fbo layers[MAX_LAYERS];
static int depth;

static GLuint box_shader, bg_shader, yuv_shader, field_shader, img_shader;
static int u_i_rect, u_i_radius, u_i_opacity, u_i_gray, u_i_fbh;
static int u_f_rect, u_f_rect_r, u_f_shape, u_f_radius, u_f_in, u_f_out, u_f_spacing, u_f_opacity, u_f_fbh;
static int u_yuv_size;
static int u_rect, u_radius, u_fill, u_border, u_border_w, u_dash, u_shadow, u_shadow_geom, u_bar, u_bar_w, u_fbh;
static int u_bg_size, u_bg_opacity, u_bg_inner, u_bg_outer;
static float fb_w, fb_h;
static const Rgba8 WHITE = {255, 255, 255, 255};

typedef struct { float x, y, width, height; } Rectangle;

// A rect for a shader that samples nothing, like raylib's DrawRectangleRec.
static void shader_rect(Rectangle r) { gl_rect(gl_white(), 1, 1, 0, 0, 1, 1, r.x, r.y, r.width, r.height, WHITE); }

void render_init(int w, int h) {
  fb_w = (float)w;
  fb_h = (float)h;
  box_shader = gl_shader(BOX_FS);
  u_rect = glGetUniformLocation(box_shader, "uRect");
  u_radius = glGetUniformLocation(box_shader, "uRadius");
  u_fill = glGetUniformLocation(box_shader, "uFill");
  u_border = glGetUniformLocation(box_shader, "uBorder");
  u_border_w = glGetUniformLocation(box_shader, "uBorderW");
  u_dash = glGetUniformLocation(box_shader, "uDash");
  u_shadow = glGetUniformLocation(box_shader, "uShadow");
  u_shadow_geom = glGetUniformLocation(box_shader, "uShadowGeom");
  u_bar = glGetUniformLocation(box_shader, "uBar");
  u_bar_w = glGetUniformLocation(box_shader, "uBarW");
  u_fbh = glGetUniformLocation(box_shader, "uFbH");
  bg_shader = gl_shader(BG_FS);
  u_bg_size = glGetUniformLocation(bg_shader, "uSize");
  u_bg_opacity = glGetUniformLocation(bg_shader, "uOpacity");
  u_bg_inner = glGetUniformLocation(bg_shader, "uInner");
  u_bg_outer = glGetUniformLocation(bg_shader, "uOuter");
  field_shader = gl_shader(FIELD_FS);
  u_f_rect = glGetUniformLocation(field_shader, "uRect");
  u_f_rect_r = glGetUniformLocation(field_shader, "uRectR");
  u_f_shape = glGetUniformLocation(field_shader, "uShape");
  u_f_radius = glGetUniformLocation(field_shader, "uRadius");
  u_f_in = glGetUniformLocation(field_shader, "uIn");
  u_f_out = glGetUniformLocation(field_shader, "uOut");
  u_f_spacing = glGetUniformLocation(field_shader, "uSpacing");
  u_f_opacity = glGetUniformLocation(field_shader, "uOpacity");
  u_f_fbh = glGetUniformLocation(field_shader, "uFbH");
  img_shader = gl_shader(IMG_FS);
  u_i_rect = glGetUniformLocation(img_shader, "uRect");
  u_i_radius = glGetUniformLocation(img_shader, "uRadius");
  u_i_opacity = glGetUniformLocation(img_shader, "uOpacity");
  u_i_gray = glGetUniformLocation(img_shader, "uGray");
  u_i_fbh = glGetUniformLocation(img_shader, "uFbH");
  yuv_shader = gl_shader(YUV_FS);
  u_yuv_size = glGetUniformLocation(yuv_shader, "uSize");
}

// The node's code wrapped in SHADER_HEAD, with its uniforms declared, compiled, and its uniforms located.
static bool shader_load(Node *n, const char *scene, char *err, int errlen) {
  static const char *TYPES[4] = {"float", "vec2", "vec3", "vec4"};
  size_t cap = strlen(SHADER_HEAD) + strlen(n->code) + (size_t)n->nuniforms * 96 + 64, len = 0;
  char *fs = malloc(cap);
  len += snprintf(fs + len, cap - len, "%s", SHADER_HEAD);
  for (int i = 0; i < n->nuniforms; i++) len += snprintf(fs + len, cap - len, "uniform %s %s;\n", TYPES[n->uniforms[i].size - 1], n->uniforms[i].name);
  // Compiler errors then count lines from the start of the node's code.
  snprintf(fs + len, cap - len, "#line 1\n%s\n", n->code);
  char log[1024];
  n->program = gl_program(fs, log, sizeof log);
  free(fs);
  if (!n->program) {
    snprintf(err, errlen, "scene %s: shader does not compile:\n%s", scene, log);
    return false;
  }
  for (int i = 0; i < 6; i++) n->locs[i] = glGetUniformLocation(n->program, SHADER_BUILTINS[i]);
  for (int i = 0; i < n->nuniforms; i++) n->uniforms[i].loc = glGetUniformLocation(n->program, n->uniforms[i].name);
  return true;
}

static bool gpu_load(Node *n, const char *scene, char *err, int errlen) {
  if (n->is_shader && !shader_load(n, scene, err, errlen)) return false;
  if (n->is_image) {
    int w, h, comp;
    unsigned char *px = stbi_load(n->src, &w, &h, &comp, 4);
    if (!px) {
      snprintf(err, errlen, "scene %s: cannot load image %s", scene, n->src);
      return false;
    }
    // Premultiplied, so filtering and mipmaps don't bleed the color of transparent pixels into the edges.
    int x0 = w, y0 = h, x1 = 0, y1 = 0;
    for (unsigned char *p = px; p < px + (size_t)w * h * 4; p += 4) {
      if (p[3] > 16) {
        int i = (int)((p - px) / 4), x = i % w, y = i / w;
        if (x < x0) x0 = x;
        if (x + 1 > x1) x1 = x + 1;
        if (y < y0) y0 = y;
        if (y + 1 > y1) y1 = y + 1;
      }
      if (p[3] == 0) {
        p[0] = p[1] = p[2] = 0;
      } else if (p[3] < 255) {
        float a = (float)p[3] / 255.0f;
        for (int i = 0; i < 3; i++) p[i] = (unsigned char)((float)p[i] * a);
      }
    }
    n->tex = gl_texture(w, h, px, true);
    n->tex_w = w;
    n->tex_h = h;
    if (x1 > x0) {
      n->opaque[0] = x0, n->opaque[1] = y0, n->opaque[2] = x1, n->opaque[3] = y1;
    }
    stbi_image_free(px);
  }
  for (int i = 0; i < n->nkids; i++)
    if (!gpu_load(&n->kids[i], scene, err, errlen)) return false;
  return true;
}

bool scene_gpu_load(Scene *s, char *err, int errlen) { return gpu_load(&s->root, s->id, err, errlen); }

void render_yuv(Fbo frame, Fbo target) {
  int size[2] = {frame.w, frame.h};
  gl_begin(target);
  gl_blend(BLEND_OFF);  // the bytes go straight into the target, alpha included
  gl_use(yuv_shader);
  gl_uniform2i(u_yuv_size, size);
  gl_rect(frame.tex, frame.w, frame.h, 0, 0, (float)target.w, (float)target.h, 0, 0, (float)target.w, (float)target.h, WHITE);
  gl_flush();
  gl_blend(BLEND_ALPHA);
}

// Uniform scale plus translation: screen = s * p + t.
typedef struct { float s, tx, ty; } Xf;

typedef struct {
  Xf xf;
  float opacity, gray;
  Col color;  // inherited text color
} Ctx;

static Col col_of(Val v) { return (Col){v.v[0], v.v[1], v.v[2], v.v[3]}; }

// CSS filter: grayscale(amount)
static Col grayed(Col c, float amount) {
  if (amount <= 0) return c;
  float l = 0.2126f * c.r + 0.7152f * c.g + 0.0722f * c.b;
  return (Col){c.r + (l - c.r) * amount, c.g + (l - c.g) * amount, c.b + (l - c.b) * amount, c.a};
}

typedef struct {
  float x, y, w, h, radius;
  Col fill, border, bar;
  float border_w, dash, bar_w;
  bool shadow;
  float shadow_alpha, shadow_dy, shadow_sigma;
} BoxPaint;

static void draw_box(const BoxPaint *b) {
  float pad = 2;
  if (b->shadow) pad = b->shadow_sigma * 3 + fabsf(b->shadow_dy);
  gl_use(box_shader);
  float rect[4] = {b->x, b->y, b->w, b->h};
  float fill[4] = {b->fill.r, b->fill.g, b->fill.b, b->fill.a};
  float border[4] = {b->border.r, b->border.g, b->border.b, b->border.a};
  float bar[4] = {b->bar.r, b->bar.g, b->bar.b, b->bar.a};
  float shadow[4] = {0, 0, 0, b->shadow ? b->shadow_alpha : 0};
  float geom[3] = {0, b->shadow_dy, b->shadow_sigma > 0 ? b->shadow_sigma : 1};
  gl_uniform4f(u_rect, rect);
  gl_uniform1f(u_radius, b->radius);
  gl_uniform4f(u_fill, fill);
  gl_uniform4f(u_border, border);
  gl_uniform1f(u_border_w, b->border_w);
  gl_uniform1f(u_dash, b->dash);
  gl_uniform4f(u_shadow, shadow);
  gl_uniform3f(u_shadow_geom, geom);
  gl_uniform4f(u_bar, bar);
  gl_uniform1f(u_bar_w, b->bar_w);
  gl_uniform1f(u_fbh, fb_h);
  shader_rect((Rectangle){b->x - pad, b->y - pad, b->w + 2 * pad, b->h + 2 * pad});
  gl_flush();  // draws while these uniforms are still set
}

// A box's drawn rectangle: its animated size, kept at the anchor point of its laid-out box (top left by default).
static Rectangle box_rect(const Scene *s, const Node *n) {
  const Target *t = &s->targets[n->target];
  float w = t->cur[P_W].v[0], h = t->cur[P_H].v[0];
  return (Rectangle){n->ax + n->anchor_x * (n->aw - w), n->ay + n->anchor_y * (n->ah - h), w, h};
}

// The field node's own box, filled with the distance field of its shape node. The shape is read in the same
// coordinates as the field (they share a parent), with its animated size, radius and x/y offset.
static void draw_field(const Scene *s, const Node *n, const Ctx *c) {
  const Target *t = &s->targets[n->target], *st = &s->targets[n->shape->target];
  Rectangle sh = box_rect(s, n->shape);
  float k = c->xf.s;
  float rect[4] = {k * n->ax + c->xf.tx, k * n->ay + c->xf.ty, k * n->aw, k * n->ah}, rect_r = k * t->cur[P_RADIUS].v[0];
  float shape[4] = {k * (sh.x + st->cur[P_X].v[0]) + c->xf.tx, k * (sh.y + st->cur[P_Y].v[0]) + c->xf.ty, k * sh.width, k * sh.height};
  float radius = k * st->cur[P_RADIUS].v[0], spacing = k * t->cur[P_SPACING].v[0];
  Col in = grayed(col_of(t->cur[P_FILL]), c->gray), out = grayed(col_of(t->cur[P_BORDER]), c->gray);
  float vin[4] = {in.r, in.g, in.b, in.a}, vout[4] = {out.r, out.g, out.b, out.a};
  gl_use(field_shader);
  gl_uniform4f(u_f_rect, rect);
  gl_uniform1f(u_f_rect_r, rect_r);
  gl_uniform4f(u_f_shape, shape);
  gl_uniform1f(u_f_radius, radius);
  gl_uniform4f(u_f_in, vin);
  gl_uniform4f(u_f_out, vout);
  gl_uniform1f(u_f_spacing, spacing);
  gl_uniform1f(u_f_opacity, c->opacity);
  gl_uniform1f(u_f_fbh, fb_h);
  shader_rect((Rectangle){rect[0], rect[1], rect[2], rect[3]});
  gl_flush();
}

// The texture scaled to cover the rect (screen coordinates) and centered, cropping what overflows.
static void draw_image(const Node *n, Rectangle r, float radius, float rotate, const Ctx *c) {
  float tw = (float)n->tex_w, th = (float)n->tex_h;
  Rectangle src = {0, 0, tw, th};
  if (tw * r.height > th * r.width) {
    src.width = th * r.width / r.height;
    src.x = (tw - src.width) / 2;
  } else {
    src.height = tw * r.height / r.width;
    src.y = (th - src.height) / 2;
  }
  float rect[4] = {r.x, r.y, r.width, r.height};
  if (rotate != 0) {
    // The clip is axis aligned; enlarge it to the bounding square so the rotated corners remain visible.
    float d = sqrtf(r.width * r.width + r.height * r.height);
    rect[0] = r.x + r.width / 2 - d / 2;
    rect[1] = r.y + r.height / 2 - d / 2;
    rect[2] = rect[3] = d;
    radius = 0;
  }
  gl_blend(BLEND_PREMULTIPLIED);
  gl_use(img_shader);
  gl_uniform4f(u_i_rect, rect);
  gl_uniform1f(u_i_radius, radius);
  gl_uniform1f(u_i_opacity, c->opacity);
  gl_uniform1f(u_i_gray, c->gray);
  gl_uniform1f(u_i_fbh, fb_h);
  if (rotate == 0) {
    gl_rect(n->tex, n->tex_w, n->tex_h, src.x, src.y, src.width, src.height, r.x, r.y, r.width, r.height, WHITE);
  } else {
    // About the center, with raylib's DrawTexturePro corner math.
    float deg = 3.14159265358979323846f / 180.0f, sn = sinf(rotate * deg), cs = cosf(rotate * deg);
    float x = r.x + r.width / 2, y = r.y + r.height / 2, dx = -r.width / 2, dy = -r.height / 2;
    const float xy[8] = {
        x + dx * cs - dy * sn, y + dx * sn + dy * cs,
        x + dx * cs - (dy + r.height) * sn, y + dx * sn + (dy + r.height) * cs,
        x + (dx + r.width) * cs - (dy + r.height) * sn, y + (dx + r.width) * sn + (dy + r.height) * cs,
        x + (dx + r.width) * cs - dy * sn, y + (dx + r.width) * sn + dy * cs,
    };
    float u0 = src.x / tw, v0 = src.y / th, u1 = (src.x + src.width) / tw, v1 = (src.y + src.height) / th;
    const float uv[8] = {u0, v0, u0, v1, u1, v1, u1, v0};
    gl_quad(n->tex, xy, uv, WHITE);
  }
  gl_flush();
  gl_blend(BLEND_ALPHA);
}

// A count node: prefix, the current value with thousands separators, suffix, in the style of its first span.
// The text a count node shows now: prefix, the value with thousands separators, suffix.
static void count_text(const Scene *s, const Node *n, char *text, size_t cap) {
  double v = s->targets[n->target].cur[P_VALUE].v[0];
  if (!isfinite(v)) v = 0;
  char num[64];
  snprintf(num, sizeof num, "%.*f", n->decimals, fabs(v));
  // Commas every three digits of the integer part.
  char grouped[96];
  int len = (int)strcspn(num, "."), o = 0;
  if (v < 0 && fabs(v) >= 0.5 * pow(10, -n->decimals)) grouped[o++] = '-';
  for (int i = 0; num[i]; i++) {
    if (i < len && i > 0 && (len - i) % 3 == 0) grouped[o++] = ',';
    grouped[o++] = num[i];
  }
  grouped[o] = 0;
  snprintf(text, cap, "%s%s%s", n->prefix, grouped, n->suffix);
}

static void draw_count(const Scene *s, const Node *n, const Ctx *c) {
  const Span *sp = n->nspans ? &n->spans[0] : NULL;
  int font = sp ? sp->font : n->font;
  float size = sp ? sp->size : n->size;
  char text[256];
  count_text(s, n, text, sizeof text);
  float width = font_advance(font, size, text, n->letter_spacing);
  float x = n->ax;
  if (n->w >= 0) x += n->text_align == ALIGN_CENTER ? (n->aw - width) / 2 : n->text_align == ALIGN_END ? n->aw - width : 0;
  float base = n->ay + (n->line_height - font_content_height(n->font, n->size)) / 2 + font_ascent(n->font, n->size);
  Col col = sp && sp->color.a > 0 ? sp->color : c->color;
  col = col_mul_alpha(grayed(col, c->gray), c->opacity);
  font_draw(font, size, text, c->xf.s * x + c->xf.tx, c->xf.s * base + c->xf.ty, c->xf.s, n->letter_spacing, col);
}

static void draw_text(const Scene *s, const Node *n, const Ctx *c) {
  if (n->is_count) {
    draw_count(s, n, c);
    return;
  }
  float width = 0;
  for (int i = 0; i < n->nspans; i++) width += n->spans[i].width;
  float x0 = n->ax;
  if (n->w >= 0) x0 += n->text_align == ALIGN_CENTER ? (n->aw - width) / 2 : n->text_align == ALIGN_END ? n->aw - width : 0;
  float base = n->ay + (n->line_height - font_content_height(n->font, n->size)) / 2 + font_ascent(n->font, n->size);

  // Code token highlights: one rounded rect behind each run of spans of the same token.
  float x = x0;
  for (int i = 0; i < n->nspans;) {
    const Span *sp = &n->spans[i];
    if (sp->tok < 0) { x += sp->width; i++; continue; }
    Col bg = grayed(col_of(s->targets[sp->tok].cur[P_BG]), c->gray);
    float start = x;
    int j = i;
    while (j < n->nspans && n->spans[j].tok == sp->tok) x += n->spans[j++].width;
    if (bg.a > 0) {
      float top = base - font_ascent(sp->font, sp->size), h = font_content_height(sp->font, sp->size);
      BoxPaint b = {0};
      b.x = c->xf.s * (start - 4) + c->xf.tx;
      b.y = c->xf.s * top + c->xf.ty;
      b.w = c->xf.s * (x - start + 8);
      b.h = c->xf.s * h;
      b.radius = 6 * c->xf.s;
      b.fill = col_mul_alpha(bg, c->opacity);
      draw_box(&b);
    }
    i = j;
  }

  x = x0;
  for (int i = 0; i < n->nspans; i++) {
    const Span *sp = &n->spans[i];
    Col col = sp->color.a > 0 ? sp->color : c->color;
    if (sp->tok >= 0) {
      Col fg = col_of(s->targets[sp->tok].cur[P_FG]);
      if (fg.a > 0) col = fg;
    }
    col = col_mul_alpha(grayed(col, c->gray), c->opacity);
    font_draw(sp->font, sp->size, sp->text, c->xf.s * x + c->xf.tx, c->xf.s * base + c->xf.ty, c->xf.s, n->letter_spacing, col);
    x += sp->width;
  }
}

static void draw_node(const Scene *s, const Node *n, Ctx c);

// The children into a cleared layer, then the node's effect over its box. Children draw at full opacity; the node's
// opacity applies to the effect.
static void draw_shader(const Scene *s, const Node *n, Ctx c) {
  if (depth == MAX_LAYERS) return;
  if (!layers[depth].fbo) layers[depth] = gl_fbo((int)fb_w, (int)fb_h);
  Fbo parent = gl_target(), layer = layers[depth++];
  gl_begin(layer);
  gl_clear((Rgba8){0, 0, 0, 0});
  Ctx inner = c;
  inner.opacity = 1;
  for (int i = 0; i < n->nkids; i++) draw_node(s, &n->kids[i], inner);
  gl_begin(parent);
  depth--;

  Rectangle r = box_rect(s, n);
  float rect[4] = {c.xf.s * r.x + c.xf.tx, c.xf.s * r.y + c.xf.ty, c.xf.s * r.width, c.xf.s * r.height};
  float res[2] = {r.width, r.height};
  gl_blend(BLEND_PREMULTIPLIED);
  gl_use(n->program);
  gl_uniform4f(n->locs[1], rect);
  gl_uniform2f(n->locs[2], res);
  gl_uniform1f(n->locs[3], s->t);
  gl_uniform1f(n->locs[4], c.opacity);
  gl_uniform1f(n->locs[5], fb_h);
  for (int i = 0; i < n->nuniforms; i++) {
    const Uniform *u = &n->uniforms[i];
    const float *v = s->targets[u->target].cur[P_VALUE].v;
    if (u->size == 1) gl_uniform1f(u->loc, v[0]);
    else if (u->size == 2) gl_uniform2f(u->loc, v);
    else if (u->size == 3) gl_uniform3f(u->loc, v);
    else gl_uniform4f(u->loc, v);
  }
  // The layer is iChannel0 through texture unit 0, which the quad binds; the shader reads it by position, not uv.
  gl_rect(layer.tex, 1, 1, 0, 0, 1, 1, rect[0], rect[1], rect[2], rect[3], WHITE);
  gl_flush();
  gl_blend(BLEND_ALPHA);
}

static void draw_node(const Scene *s, const Node *n, Ctx c) {
  const Target *t = &s->targets[n->target];
  c.opacity *= t->cur[P_OPACITY].v[0];
  if (c.opacity <= 0.002f) return;
  float g = t->cur[P_GRAY].v[0];
  c.gray = c.gray + g - c.gray * g;
  Col own = col_of(t->cur[P_COLOR]);
  if (own.a > 0) c.color = own;

  // Translate, then scale about the box center (GSAP's default transform origin).
  float sc = t->cur[P_SCALE].v[0], cx = n->ax + n->aw / 2, cy = n->ay + n->ah / 2;
  float lx = cx - sc * cx + t->cur[P_X].v[0], ly = cy - sc * cy + t->cur[P_Y].v[0];
  c.xf = (Xf){c.xf.s * sc, c.xf.s * lx + c.xf.tx, c.xf.s * ly + c.xf.ty};

  if (n->is_text) {
    draw_text(s, n, &c);
  } else if (n->is_field) {
    draw_field(s, n, &c);
  } else if (n->is_shader) {
    draw_shader(s, n, c);
  } else {
    Col fill = grayed(col_of(t->cur[P_FILL]), c.gray), border = grayed(col_of(t->cur[P_BORDER]), c.gray);
    Rectangle r = box_rect(s, n);
    BoxPaint b = {0};
    b.x = c.xf.s * r.x + c.xf.tx;
    b.y = c.xf.s * r.y + c.xf.ty;
    b.w = c.xf.s * r.width;
    b.h = c.xf.s * r.height;
    b.radius = t->cur[P_RADIUS].v[0] * c.xf.s;
    b.fill = col_mul_alpha(fill, c.opacity);
    b.border = col_mul_alpha(border, c.opacity);
    b.border_w = n->border_width * c.xf.s;
    b.dash = n->dash * c.xf.s;
    b.bar = col_mul_alpha(grayed(n->bar_color, c.gray), c.opacity);
    b.bar_w = n->bar_width * c.xf.s;
    // box-shadow: 0 30px 80px rgba(0, 0, 0, 0.45)
    b.shadow = n->shadow;
    b.shadow_alpha = 0.45f * c.opacity;
    b.shadow_dy = 30 * c.xf.s;
    b.shadow_sigma = 40 * c.xf.s;
    bool bordered = border.a > 0 && n->border_width > 0;
    if (n->is_image) {
      // The image goes over the box's fill and shadow, and under its border.
      BoxPaint under = b;
      under.border.a = 0;
      if (fill.a > 0 || n->shadow || n->bar_width > 0) draw_box(&under);
      draw_image(n, (Rectangle){b.x, b.y, b.w, b.h}, b.radius, t->cur[P_ROTATE].v[0], &c);
      BoxPaint over = {.x = b.x, .y = b.y, .w = b.w, .h = b.h, .radius = b.radius, .border = b.border, .border_w = b.border_w, .dash = b.dash};
      if (bordered) draw_box(&over);
    } else if (fill.a > 0 || bordered || n->shadow || n->bar_width > 0) {
      draw_box(&b);
    }
    for (int i = 0; i < n->nkids; i++) draw_node(s, &n->kids[i], c);
  }
}

// The current subtitle line, faded with the scene.
static void draw_subtitle(const Scene *s, float opacity) {
  if (s->sub < 0 || opacity <= 0.002f) return;
  const Cue *cue = &s->subs[s->sub];
  int font = font_index(SUB_FONT);
  float h = font_content_height(font, SUB_SIZE), px = 28, py = 12, bottom = fb_h - 64;
  BoxPaint b = {0};
  b.w = cue->width + 2 * px;
  b.h = h + 2 * py;
  b.x = (fb_w - b.w) / 2;
  b.y = bottom - b.h;
  b.radius = 14;
  b.fill = (Col){0, 0, 0, 0.6f * opacity};
  draw_box(&b);
  font_draw(font, SUB_SIZE, cue->text, roundf(b.x + px), roundf(b.y + py + font_ascent(font, SUB_SIZE)), 1, 0, (Col){1, 1, 1, opacity});
}

void render_scene(Scene *s) {
  Col o = s->bg_outer;
  gl_clear((Rgba8){(unsigned char)roundf(o.r * 255), (unsigned char)roundf(o.g * 255), (unsigned char)roundf(o.b * 255), 255});
  float opacity = s->targets[s->root.target].cur[P_OPACITY].v[0];
  float size[2] = {fb_w, fb_h};
  float inner[3] = {roundf(s->bg_inner.r * 255), roundf(s->bg_inner.g * 255), roundf(s->bg_inner.b * 255)};
  float outer[3] = {roundf(o.r * 255), roundf(o.g * 255), roundf(o.b * 255)};
  gl_use(bg_shader);
  gl_uniform2f(u_bg_size, size);
  gl_uniform1f(u_bg_opacity, opacity);
  gl_uniform3f(u_bg_inner, inner);
  gl_uniform3f(u_bg_outer, outer);
  shader_rect((Rectangle){0, 0, (float)(int)fb_w, (float)(int)fb_h});
  gl_flush();
  Ctx c = {{1, 0, 0}, 1, 0, {0.902f, 0.894f, 0.863f, 1}};  // --text: #e6e4dc
  draw_node(s, &s->root, c);
  draw_subtitle(s, opacity);
}

// ---------- bounds ----------

// Layout problems a still doesn't show: painted nodes past the frame's edge, or under the subtitle plate while a line
// shows. A brief overlap (an entrance, an overshoot) is fine, so only those lasting MIN_SECONDS are reported, once per
// named node and kind, with when they start and how long they last.
#define MIN_SECONDS 0.5f

typedef struct {
  int count;       // samples with the problem
  float t;         // the first one
  Rectangle rect;  // where the node was then
  const Node *n;   // the painted node; its named ancestor is `named`
  const Node *named;
} Hit;

typedef struct {
  const Scene *s;
  float t, sub_x0, sub_x1, sub_y;  // the subtitle plate at t; sub_y < 0 when no line shows
  Hit *hits;                       // per target and kind (0 frame, 1 subtitle)
  bool *now;                       // already counted at this sample
} Bounds;

static void bounds_hit(Bounds *b, const Node *n, const Node *named, int kind, Rectangle r) {
  int k = named->target * 2 + kind;
  if (b->now[k]) return;
  b->now[k] = true;
  Hit *h = &b->hits[k];
  if (h->count++ == 0) *h = (Hit){1, b->t, r, n, named};
}

// What of the box is visible: an image's opaque pixels, mapped the way draw_image crops the texture to fill it.
static Rectangle visible(const Node *n, Rectangle r) {
  if (!n->is_image || n->opaque[2] <= n->opaque[0]) return r;
  float tw = (float)n->tex_w, th = (float)n->tex_h, sx = 0, sy = 0, sw = tw, sh = th;
  if (tw * r.height > th * r.width) sw = th * r.width / r.height, sx = (tw - sw) / 2;
  else sh = tw * r.height / r.width, sy = (th - sh) / 2;
  float x0 = fmaxf(n->opaque[0], sx), y0 = fmaxf(n->opaque[1], sy), x1 = fminf(n->opaque[2], sx + sw), y1 = fminf(n->opaque[3], sy + sh);
  if (x1 <= x0 || y1 <= y0) return (Rectangle){0};
  return (Rectangle){r.x + (x0 - sx) * r.width / sw, r.y + (y0 - sy) * r.height / sh, (x1 - x0) * r.width / sw, (y1 - y0) * r.height / sh};
}

// The same transforms as draw_node, without drawing. `named` is the nearest node with an id. `found` holds, per
// kind, whether an ancestor already has the problem at this sample, so only the outermost node is reported.
static void bounds_node(Bounds *b, const Node *n, Ctx c, const Node *named, const bool found_in[2]) {
  bool found[2] = {found_in[0], found_in[1]};
  const Scene *s = b->s;
  const Target *t = &s->targets[n->target];
  c.opacity *= t->cur[P_OPACITY].v[0];
  if (c.opacity <= 0.002f) return;
  if (t->id[0]) named = n;
  float sc = t->cur[P_SCALE].v[0], cx = n->ax + n->aw / 2, cy = n->ay + n->ah / 2;
  float lx = cx - sc * cx + t->cur[P_X].v[0], ly = cy - sc * cy + t->cur[P_Y].v[0];
  c.xf = (Xf){c.xf.s * sc, c.xf.s * lx + c.xf.tx, c.xf.s * ly + c.xf.ty};

  Rectangle r = {0};
  bool painted = false;
  if (n->is_text) {
    float width = 0;
    if (n->is_count) {
      char text[256];
      count_text(s, n, text, sizeof text);
      width = font_advance(n->nspans ? n->spans[0].font : n->font, n->nspans ? n->spans[0].size : n->size, text, n->letter_spacing);
    } else {
      for (int i = 0; i < n->nspans; i++) width += n->spans[i].width;
    }
    float x0 = n->ax;
    if (n->w >= 0) x0 += n->text_align == ALIGN_CENTER ? (n->aw - width) / 2 : n->text_align == ALIGN_END ? n->aw - width : 0;
    r = (Rectangle){x0, n->ay, width, n->line_height};
    painted = width > 0;
  } else if (n != &s->root) {
    r = visible(n, box_rect(s, n));
    painted = n->is_image || n->is_field || n->is_shader || col_of(t->cur[P_FILL]).a > 0 || (col_of(t->cur[P_BORDER]).a > 0 && n->border_width > 0);
  }
  if (painted && r.width > 0 && r.height > 0) {
    Rectangle o = {c.xf.s * r.x + c.xf.tx, c.xf.s * r.y + c.xf.ty, c.xf.s * r.width, c.xf.s * r.height};
    const float slack = 2;
    if (o.x < -slack || o.y < -slack || o.x + o.width > fb_w + slack || o.y + o.height > fb_h + slack) {
      if (!found[0]) bounds_hit(b, n, named, 0, o);
      found[0] = true;
    }
    // Backdrops (half the frame or more) sit under everything, the subtitle included.
    bool backdrop = o.width * o.height >= fb_w * fb_h / 2;
    if (!backdrop && b->sub_y >= 0 && o.y + o.height > b->sub_y && o.y < fb_h && o.x < b->sub_x1 && o.x + o.width > b->sub_x0) {
      if (!found[1]) bounds_hit(b, n, named, 1, o);
      found[1] = true;
    }
  }
  for (int i = 0; i < n->nkids; i++) bounds_node(b, &n->kids[i], c, named, found);
}

char *render_bounds(Scene *s, float step) {
  size_t slots = (size_t)s->ntargets * 2;
  Bounds b = {.s = s, .hits = calloc(slots, sizeof(Hit)), .now = calloc(slots, sizeof(bool))};
  int font = font_index(SUB_FONT);
  // Up to the fade-out: every scene fades over its last 0.4s.
  for (float t = 0; t <= s->duration - 0.4f; t += step) {
    scene_eval(s, t);
    b.t = t;
    b.sub_y = -1;
    if (s->sub >= 0) {
      // As draw_subtitle places the plate.
      float w = s->subs[s->sub].width + 2 * 28, h = font_content_height(font, SUB_SIZE) + 2 * 12;
      b.sub_x0 = (fb_w - w) / 2;
      b.sub_x1 = b.sub_x0 + w;
      b.sub_y = fb_h - 64 - h;
    }
    memset(b.now, 0, slots * sizeof(bool));
    Ctx c = {{1, 0, 0}, 1, 0, {1, 1, 1, 1}};
    const bool none[2] = {false, false};
    bounds_node(&b, &s->root, c, &s->root, none);
  }
  cJSON *issues = cJSON_CreateArray();
  for (size_t k = 0; k < slots; k++) {
    const Hit *h = &b.hits[k];
    if (h->count * step < MIN_SECONDS - 1e-4f) continue;
    cJSON *o = cJSON_CreateObject();
    cJSON_AddStringToObject(o, "kind", k % 2 ? "subtitle" : "frame");
    // Under the root, a node without an id of its own has no useful name.
    cJSON_AddStringToObject(o, "id", h->named == &s->root ? "" : s->targets[h->named->target].id);
    cJSON_AddStringToObject(o, "type", h->n->is_text ? "text" : h->n->is_image ? "image" : h->n->is_field ? "field" : h->n->is_shader ? "shader" : "box");
    if (h->n->is_text && h->n->nspans) cJSON_AddStringToObject(o, "text", h->n->spans[0].text);
    cJSON_AddNumberToObject(o, "t", roundf(h->t * 100) / 100);
    cJSON_AddNumberToObject(o, "seconds", roundf(h->count * step * 100) / 100);
    float rect[4] = {roundf(h->rect.x), roundf(h->rect.y), roundf(h->rect.width), roundf(h->rect.height)};
    cJSON_AddItemToObject(o, "rect", cJSON_CreateFloatArray(rect, 4));
    cJSON_AddItemToArray(issues, o);
  }
  char *out = cJSON_PrintUnformatted(issues);
  cJSON_Delete(issues);
  free(b.hits);
  free(b.now);
  return out;
}
