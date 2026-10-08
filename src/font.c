// Fonts: one stb_truetype glyph atlas per (font, CSS px size), uploaded as a GL texture.
// Sizes are em sizes like CSS font-size, and advances are floats with kerning, so text widths
// match the browser closely.
#include <math.h>
#include <stdlib.h>
#include <string.h>

#include "cmotion.h"
#include "stb_truetype.h"

#define MAX_FACES 192
#define MAX_SIZES 48
#define MAX_CP 0x3000  // covers Latin, punctuation, arrows and dingbats used by the scenes
#define ATLAS 1024

static const struct { const char *name, *file; } FILES[] = {
    {"inter-500", "Inter-Medium.ttf"},         {"inter-600", "Inter-SemiBold.ttf"},
    {"inter-700", "Inter-Bold.ttf"},           {"mono-400", "JetBrainsMono-Regular.ttf"},
    {"mono-600", "JetBrainsMono-SemiBold.ttf"}, {"mono-400i", "JetBrainsMono-Italic.ttf"},
};
#define NFILES (int)(sizeof FILES / sizeof FILES[0])

typedef struct {
  float x0, y0, w, h;   // offset from the pen position on the baseline, and size, in px
  float sx, sy;         // top left in the atlas
} Glyph;

typedef struct {
  int font;
  float size;
  GLuint tex;
  short map[MAX_CP];    // codepoint -> glyph slot + 1
  Glyph *glyphs;
  int nglyphs;
} Face;

typedef struct {
  const char *name;
  unsigned char *data;
  stbtt_fontinfo info;
  float ascent, descent;  // in em
  float sizes[MAX_SIZES];
  bool *used[MAX_SIZES];  // per size, the codepoints drawn at it: big sizes only rasterize their own glyphs
  int nsizes;
} Font_;

static Font_ fonts[MAX_FONTS];
static int nfonts;
static Face faces[MAX_FACES];
static int nfaces;

static int utf8_next(const char **s) {
  const unsigned char *p = (const unsigned char *)*s;
  int cp, n;
  if (p[0] < 0x80) { cp = p[0]; n = 1; }
  else if ((p[0] & 0xE0) == 0xC0) { cp = p[0] & 0x1F; n = 2; }
  else if ((p[0] & 0xF0) == 0xE0) { cp = p[0] & 0x0F; n = 3; }
  else { cp = p[0] & 0x07; n = 4; }
  for (int i = 1; i < n; i++) {
    if (!p[i]) { n = i; break; }
    cp = (cp << 6) | (p[i] & 0x3F);
  }
  *s += n;
  return cp;
}

int font_index(const char *name) {
  for (int i = 0; i < nfonts; i++)
    if (strcmp(fonts[i].name, name) == 0) return i;
  if (nfonts == MAX_FONTS) return 0;
  fonts[nfonts].name = strdup(name);
  return nfonts++;
}

void font_need(int font, float size, const char *text) {
  Font_ *f = &fonts[font];
  int s = 0;
  while (s < f->nsizes && f->sizes[s] != size) s++;
  if (s == f->nsizes) {
    if (s == MAX_SIZES) return;
    f->sizes[s] = size;
    f->used[s] = calloc(MAX_CP, sizeof(bool));
    f->used[s][' '] = true;
    f->nsizes++;
  }
  while (*text) {
    int cp = utf8_next(&text);
    if (cp < MAX_CP) f->used[s][cp] = true;
  }
}

static Face *face_for(int font, float size) {
  for (int i = 0; i < nfaces; i++)
    if (faces[i].font == font && faces[i].size == size) return &faces[i];
  return NULL;
}

// The whole file, or NULL.
static unsigned char *read_file(const char *path) {
  FILE *fp = fopen(path, "rb");
  if (!fp) return NULL;
  fseek(fp, 0, SEEK_END);
  long len = ftell(fp);
  fseek(fp, 0, SEEK_SET);
  unsigned char *data = len > 0 ? malloc((size_t)len) : NULL;
  if (data && fread(data, 1, (size_t)len, fp) != (size_t)len) {
    free(data);
    data = NULL;
  }
  fclose(fp);
  return data;
}

static float scale_of(Font_ *f, float size) { return stbtt_ScaleForMappingEmToPixels(&f->info, size); }

// Rasterizes the codepoints used at one size of one font into a gray+alpha atlas (shelf packing).
static bool build_face(int font, int s, char *err, int errlen) {
  Font_ *f = &fonts[font];
  float size = f->sizes[s];
  const bool *used = f->used[s];
  if (nfaces == MAX_FACES) {
    snprintf(err, errlen, "too many font sizes");
    return false;
  }
  Face *face = &faces[nfaces++];
  memset(face, 0, sizeof *face);
  face->font = font;
  face->size = size;
  float sc = scale_of(f, size);
  int count = 0;
  for (int cp = 0; cp < MAX_CP; cp++) count += used[cp];
  face->glyphs = calloc(count + 1, sizeof(Glyph));

  int aw = ATLAS, ah = ATLAS;
  unsigned char *alpha = calloc(aw * ah, 1);
  int px = 1, py = 1, row = 0;
  for (int cp = 0; cp < MAX_CP; cp++) {
    if (!used[cp]) continue;
    int x0, y0, x1, y1;
    stbtt_GetCodepointBitmapBox(&f->info, cp, sc, sc, &x0, &y0, &x1, &y1);
    int w = x1 - x0, h = y1 - y0;
    if (px + w + 1 >= aw) { px = 1; py += row + 1; row = 0; }
    if (py + h + 1 >= ah) {
      snprintf(err, errlen, "glyph atlas full for %s at %.0fpx", f->name, size);
      return false;
    }
    if (w > 0 && h > 0) stbtt_MakeCodepointBitmap(&f->info, alpha + py * aw + px, w, h, aw, sc, sc, cp);
    Glyph *g = &face->glyphs[face->nglyphs];
    *g = (Glyph){(float)x0, (float)y0, (float)w, (float)h, (float)px, (float)py};
    face->map[cp] = (short)(++face->nglyphs);
    px += w + 1;
    if (h > row) row = h;
  }
  // White glyphs with coverage in alpha, so the vertex color sets the color.
  unsigned char *rgba = malloc((size_t)aw * ah * 4);
  for (int i = 0; i < aw * ah; i++) {
    memset(rgba + 4 * i, 255, 3);
    rgba[4 * i + 3] = alpha[i];
  }
  free(alpha);
  face->tex = gl_texture(aw, ah, rgba, false);
  free(rgba);
  return true;
}

bool fonts_load(const char *dir, char *err, int errlen) {
  for (int i = 0; i < nfonts; i++) {
    Font_ *f = &fonts[i];
    const char *file = NULL;
    for (int j = 0; j < NFILES; j++)
      if (strcmp(FILES[j].name, f->name) == 0) file = FILES[j].file;
    if (!file) {
      snprintf(err, errlen, "unknown font %s", f->name);
      return false;
    }
    char path[1024];
    snprintf(path, sizeof path, "%s/%s", dir, file);
    f->data = read_file(path);
    if (!f->data || !stbtt_InitFont(&f->info, f->data, stbtt_GetFontOffsetForIndex(f->data, 0))) {
      snprintf(err, errlen, "cannot load font %s", path);
      return false;
    }
    int asc, desc, gap;
    stbtt_GetFontVMetrics(&f->info, &asc, &desc, &gap);
    float em = scale_of(f, 1);
    f->ascent = asc * em;
    f->descent = -desc * em;
    for (int s = 0; s < f->nsizes; s++)
      if (!build_face(i, s, err, errlen)) return false;
  }
  return true;
}

float font_ascent(int font, float size) { return fonts[font].ascent * size; }

float font_content_height(int font, float size) { return (fonts[font].ascent + fonts[font].descent) * size; }

float font_advance(int font, float size, const char *text, float letter_spacing) {
  Font_ *f = &fonts[font];
  float sc = scale_of(f, size), w = 0;
  int prev = 0;
  while (*text) {
    int cp = utf8_next(&text), adv, lsb;
    if (prev) w += stbtt_GetCodepointKernAdvance(&f->info, prev, cp) * sc;
    stbtt_GetCodepointHMetrics(&f->info, cp, &adv, &lsb);
    w += adv * sc + letter_spacing;
    prev = cp;
  }
  return w;
}

void font_draw(int font, float size, const char *text, float x, float baseline, float scale, float letter_spacing, Col c) {
  Font_ *f = &fonts[font];
  Face *face = face_for(font, size);
  if (!face || c.a <= 0) return;
  float sc = scale_of(f, size);
  Rgba8 tint = {(unsigned char)(c.r * 255 + 0.5f), (unsigned char)(c.g * 255 + 0.5f), (unsigned char)(c.b * 255 + 0.5f),
                (unsigned char)(fminf(c.a, 1) * 255 + 0.5f)};
  gl_use(gl_text_shader());
  // At scale 1, snap to whole pixels so glyphs stay as crisp as the browser's.
  bool snap = fabsf(scale - 1) < 1e-3f;
  float pen = 0;
  int prev = 0;
  while (*text) {
    int cp = utf8_next(&text), adv, lsb;
    if (prev) pen += stbtt_GetCodepointKernAdvance(&f->info, prev, cp) * sc;
    if (cp < MAX_CP && face->map[cp]) {
      Glyph *g = &face->glyphs[face->map[cp] - 1];
      if (g->w > 0) {
        float gx = x + (pen + g->x0) * scale, gy = baseline + g->y0 * scale;
        if (snap) { gx = roundf(gx); gy = roundf(gy); }
        gl_rect(face->tex, ATLAS, ATLAS, g->sx, g->sy, g->w, g->h, gx, gy, g->w * scale, g->h * scale, tint);
      }
    }
    stbtt_GetCodepointHMetrics(&f->info, cp, &adv, &lsb);
    pen += adv * sc + letter_spacing;
    prev = cp;
  }
}
