// Loads video.json into scenes, lays out the node tree and evaluates tweens at a time.
#include <math.h>
#include <stdlib.h>
#include <string.h>

#include "cJSON.h"
#include "cmotion.h"

static const char *PROP_NAMES[P_COUNT] = {"opacity", "x", "y", "scale", "gray", "color", "fill", "border", "fg", "bg", "w", "h", "radius", "spacing", "value", "rotate"};

enum { EASE_NONE, EASE_POWER_IN, EASE_POWER_OUT, EASE_POWER_INOUT, EASE_BACK_OUT, EASE_SINE_IN, EASE_SINE_OUT, EASE_SINE_INOUT,
       EASE_EXPO_IN, EASE_EXPO_OUT, EASE_EXPO_INOUT };

// ---------- JSON helpers ----------

static float num(const cJSON *o, const char *key, float def) {
  const cJSON *v = cJSON_GetObjectItemCaseSensitive(o, key);
  return cJSON_IsNumber(v) ? (float)v->valuedouble : def;
}

static bool flag(const cJSON *o, const char *key) { return cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(o, key)); }

static const char *str(const cJSON *o, const char *key, const char *def) {
  const cJSON *v = cJSON_GetObjectItemCaseSensitive(o, key);
  return cJSON_IsString(v) ? v->valuestring : def;
}

// A value is a number or an [r, g, b, a] array (0..1).
static Val val_of(const cJSON *v) {
  Val out = {{0, 0, 0, 0}};
  if (cJSON_IsNumber(v)) out.v[0] = (float)v->valuedouble;
  else if (cJSON_IsArray(v))
    for (int i = 0; i < 4 && i < cJSON_GetArraySize(v); i++) out.v[i] = (float)cJSON_GetArrayItem(v, i)->valuedouble;
  return out;
}

static Col col_of(const cJSON *o, const char *key) {
  Val v = val_of(cJSON_GetObjectItemCaseSensitive(o, key));
  return (Col){v.v[0], v.v[1], v.v[2], v.v[3]};
}

static int enum_of(const char *s, const char *const *names, int n, int def) {
  for (int i = 0; s && i < n; i++)
    if (strcmp(s, names[i]) == 0) return i;
  return def;
}

static int add_target(Scene *s, const char *id) {
  s->targets = realloc(s->targets, sizeof(Target) * (s->ntargets + 1));
  Target *t = &s->targets[s->ntargets];
  memset(t, 0, sizeof *t);
  snprintf(t->id, sizeof t->id, "%s", id ? id : "");
  t->base[P_OPACITY].v[0] = 1;
  t->base[P_SCALE].v[0] = 1;
  return s->ntargets++;
}

static int find_target(Scene *s, const char *id) {
  for (int i = 0; i < s->ntargets; i++)
    if (s->targets[i].id[0] && strcmp(s->targets[i].id, id) == 0) return i;
  return -1;
}

// ---------- parsing ----------

static bool parse_node(Scene *s, Node *n, const cJSON *o, char *err, int errlen) {
  static const char *LAYOUTS[] = {"none", "row", "column"};
  static const char *ALIGNS[] = {"start", "center", "end"};
  memset(n, 0, sizeof *n);
  const char *id = str(o, "id", NULL);
  if (id && find_target(s, id) >= 0) {
    snprintf(err, errlen, "scene %s: duplicate id %s", s->id, id);
    return false;
  }
  n->target = add_target(s, id);
  Target *t = &s->targets[n->target];
  t->base[P_OPACITY].v[0] = num(o, "opacity", 1);
  t->base[P_SCALE].v[0] = num(o, "scale", 1);
  t->base[P_GRAY].v[0] = num(o, "gray", 0);
  t->base[P_X].v[0] = num(o, "dx", 0);
  t->base[P_Y].v[0] = num(o, "dy", 0);
  t->base[P_COLOR] = val_of(cJSON_GetObjectItemCaseSensitive(o, "color"));
  t->base[P_FILL] = val_of(cJSON_GetObjectItemCaseSensitive(o, "fill"));
  t->base[P_BORDER] = val_of(cJSON_GetObjectItemCaseSensitive(o, "border"));

  n->is_text = strcmp(str(o, "type", "box"), "text") == 0;
  n->is_field = strcmp(str(o, "type", "box"), "field") == 0;
  n->is_image = strcmp(str(o, "type", "box"), "image") == 0;
  if (n->is_image) n->src = strdup(str(o, "src", ""));
  n->is_shader = strcmp(str(o, "type", "box"), "shader") == 0;
  if (n->is_shader) {
    n->code = strdup(str(o, "code", ""));
    if (strstr(n->code, "iTime")) s->live = true;
    const cJSON *uniforms = cJSON_GetObjectItemCaseSensitive(o, "uniforms");
    n->nuniforms = cJSON_GetArraySize(uniforms);
    n->uniforms = calloc(n->nuniforms ? n->nuniforms : 1, sizeof(Uniform));
    for (int i = 0; i < n->nuniforms; i++) {
      const cJSON *uo = cJSON_GetArrayItem(uniforms, i);
      Uniform *u = &n->uniforms[i];
      snprintf(u->name, sizeof u->name, "%s", str(uo, "name", ""));
      u->size = (int)fminf(4, fmaxf(1, num(uo, "size", 1)));
      char uid[160];
      snprintf(uid, sizeof uid, "%s.%s", id ? id : "", u->name);
      u->target = add_target(s, uid);
      s->targets[u->target].base[P_VALUE] = val_of(cJSON_GetObjectItemCaseSensitive(uo, "value"));
      t = &s->targets[n->target];  // add_target may have moved the targets
    }
  }
  t->base[P_SPACING].v[0] = num(o, "spacing", 40);
  t->base[P_VALUE].v[0] = num(o, "value", 0);
  t->base[P_ROTATE].v[0] = num(o, "rotate", 0);
  n->x = num(o, "x", 0);
  n->y = num(o, "y", 0);
  n->rel_x = num(o, "relX", 0);
  n->rel_y = num(o, "relY", 0);
  n->w = num(o, "w", -1);
  n->h = num(o, "h", -1);
  const cJSON *anchor = cJSON_GetObjectItemCaseSensitive(o, "anchor");
  if (cJSON_IsArray(anchor)) {
    n->anchor_x = (float)cJSON_GetArrayItem(anchor, 0)->valuedouble;
    n->anchor_y = (float)cJSON_GetArrayItem(anchor, 1)->valuedouble;
  }
  n->abs = flag(o, "abs");
  n->push_end = flag(o, "pushEnd");
  n->layout = enum_of(str(o, "layout", NULL), LAYOUTS, 3, LAYOUT_NONE);
  n->align = enum_of(str(o, "align", NULL), ALIGNS, 3, ALIGN_START);
  n->justify = enum_of(str(o, "justify", NULL), ALIGNS, 3, ALIGN_START);
  n->text_align = enum_of(str(o, "textAlign", NULL), ALIGNS, 3, ALIGN_START);
  n->gap = num(o, "gap", 0);
  const cJSON *pad = cJSON_GetObjectItemCaseSensitive(o, "pad");
  for (int i = 0; cJSON_IsArray(pad) && i < 4; i++) n->pad[i] = (float)cJSON_GetArrayItem(pad, i)->valuedouble;
  n->radius = num(o, "radius", 0);
  t->base[P_RADIUS].v[0] = n->radius;
  n->border_width = num(o, "borderWidth", 0);
  n->dash = num(o, "dash", 0);
  n->shadow = flag(o, "shadow");
  const cJSON *bar = cJSON_GetObjectItemCaseSensitive(o, "bar");
  if (bar) {
    n->bar_width = num(bar, "width", 0);
    n->bar_color = col_of(bar, "color");
  }

  if (n->is_text) {
    n->font = font_index(str(o, "font", "inter-500"));
    n->size = num(o, "size", 32);
    n->line_height = num(o, "lineHeight", -1);
    n->letter_spacing = num(o, "letterSpacing", 0);
    const cJSON *spans = cJSON_GetObjectItemCaseSensitive(o, "spans");
    n->nspans = cJSON_GetArraySize(spans);
    n->spans = calloc(n->nspans ? n->nspans : 1, sizeof(Span));
    for (int i = 0; i < n->nspans; i++) {
      const cJSON *so = cJSON_GetArrayItem(spans, i);
      Span *sp = &n->spans[i];
      sp->text = strdup(str(so, "text", ""));
      sp->font = font_index(str(so, "font", str(o, "font", "inter-500")));
      sp->size = num(so, "size", n->size);
      sp->color = col_of(so, "color");
      sp->tok = -1;
      const char *tok = str(so, "tok", NULL);
      if (tok) {
        sp->tok = find_target(s, tok);
        if (sp->tok < 0) sp->tok = add_target(s, tok);
      }
      font_need(sp->font, sp->size, sp->text);
    }
    font_need(n->font, n->size, " ");
    const cJSON *count = cJSON_GetObjectItemCaseSensitive(o, "count");
    if (count) {
      n->is_count = true;
      n->decimals = (int)fminf(6, fmaxf(0, num(count, "decimals", 0)));
      n->prefix = strdup(str(count, "prefix", ""));
      n->suffix = strdup(str(count, "suffix", ""));
      int font = n->nspans ? n->spans[0].font : n->font;
      float size = n->nspans ? n->spans[0].size : n->size;
      font_need(font, size, "0123456789.,-");
      font_need(font, size, n->prefix);
      font_need(font, size, n->suffix);
    }
  }

  const cJSON *kids = cJSON_GetObjectItemCaseSensitive(o, "children");
  n->nkids = cJSON_GetArraySize(kids);
  n->kids = calloc(n->nkids ? n->nkids : 1, sizeof(Node));
  for (int i = 0; i < n->nkids; i++)
    if (!parse_node(s, &n->kids[i], cJSON_GetArrayItem(kids, i), err, errlen)) return false;
  return true;
}

static void parse_ease(const char *name, int *ease, float *arg) {
  *ease = EASE_POWER_OUT;  // GSAP's default is power1.out
  *arg = 1;
  if (!name) return;
  if (strcmp(name, "none") == 0 || strcmp(name, "linear") == 0) { *ease = EASE_NONE; return; }
  if (strncmp(name, "back", 4) == 0) {
    *ease = EASE_BACK_OUT;
    const char *p = strchr(name, '(');
    *arg = p ? strtof(p + 1, NULL) : 1.70158f;
    return;
  }
  // The DSL's Ease type lists the names, so unknown ones never reach this far.
  const char *dot = strchr(name, '.');
  bool in = dot && strcmp(dot, ".in") == 0, out = !dot || strcmp(dot, ".out") == 0;
  if (strncmp(name, "sine", 4) == 0) { *ease = in ? EASE_SINE_IN : out ? EASE_SINE_OUT : EASE_SINE_INOUT; return; }
  if (strncmp(name, "expo", 4) == 0) { *ease = in ? EASE_EXPO_IN : out ? EASE_EXPO_OUT : EASE_EXPO_INOUT; return; }
  if (strncmp(name, "power", 5) == 0) {
    *arg = (float)atoi(name + 5);  // power1..power4
    *ease = in ? EASE_POWER_IN : out ? EASE_POWER_OUT : EASE_POWER_INOUT;
  }
}

static float ease_apply(int ease, float arg, float p) {
  switch (ease) {
    case EASE_NONE: return p;
    case EASE_POWER_IN: return powf(p, arg + 1);
    case EASE_POWER_OUT: return 1 - powf(1 - p, arg + 1);
    case EASE_POWER_INOUT: return p < 0.5f ? powf(2 * p, arg + 1) / 2 : 1 - powf(2 * (1 - p), arg + 1) / 2;
    case EASE_BACK_OUT: { float q = p - 1; return 1 + (arg + 1) * q * q * q + arg * q * q; }
    case EASE_SINE_IN: return 1 - cosf((float)M_PI * p / 2);
    case EASE_SINE_OUT: return sinf((float)M_PI * p / 2);
    case EASE_SINE_INOUT: return -(cosf((float)M_PI * p) - 1) / 2;
    case EASE_EXPO_IN: return p <= 0 ? 0 : powf(2, 10 * p - 10);
    case EASE_EXPO_OUT: return p >= 1 ? 1 : 1 - powf(2, -10 * p);
    case EASE_EXPO_INOUT:
      return p <= 0 ? 0 : p >= 1 ? 1 : p < 0.5f ? powf(2, 20 * p - 10) / 2 : (2 - powf(2, -20 * p + 10)) / 2;
  }
  return p;
}

static Val lerp_val(Val a, Val b, float k) {
  Val o;
  for (int i = 0; i < 4; i++) o.v[i] = a.v[i] + (b.v[i] - a.v[i]) * k;
  return o;
}

static Val tween_value(const Tween *tw, float t) {
  float p = tw->dur > 0 ? (t - tw->start) / tw->dur : 1;
  if (p < 0) p = 0;
  if (p > 1) p = 1;
  return lerp_val(tw->resolved_from, tw->to, ease_apply(tw->ease, tw->ease_arg, p));
}

// Value of one property from the tweens before index `upto`, at time t (GSAP-style: the latest started tween wins,
// and a fromTo shows its start value before it begins when it is the first tween on that property).
static Val track_value(const Scene *s, int target, int prop, int upto, float t) {
  const Tween *last = NULL, *first = NULL;
  for (int i = 0; i < upto; i++) {
    const Tween *tw = &s->tweens[i];
    if (tw->target != target || tw->prop != prop) continue;
    if (!first || tw->start < first->start) first = tw;
    if (tw->start <= t && (!last || tw->start >= last->start)) last = tw;
  }
  if (last) return tween_value(last, t);
  if (first && first->has_from) return first->from;
  return s->targets[target].base[prop];
}

static int cmp_tween(const void *a, const void *b) {
  const Tween *x = a, *y = b;
  if (x->start != y->start) return x->start < y->start ? -1 : 1;
  return x->order - y->order;
}

static Node *find_node(Node *n, int target) {
  if (n->target == target) return n;
  for (int i = 0; i < n->nkids; i++) {
    Node *hit = find_node(&n->kids[i], target);
    if (hit) return hit;
  }
  return NULL;
}

// Points each field node at the node whose shape it draws.
static bool link_fields(Scene *s, Node *n, const cJSON *o, char *err, int errlen) {
  if (n->is_field) {
    const char *id = str(o, "shape", "");
    int target = find_target(s, id);
    n->shape = target >= 0 ? find_node(&s->root, target) : NULL;
    if (!n->shape || n->shape->is_text) {
      snprintf(err, errlen, "scene %s: field shape \"%s\" is not a box", s->id, id);
      return false;
    }
  }
  const cJSON *kids = cJSON_GetObjectItemCaseSensitive(o, "children");
  for (int i = 0; i < n->nkids; i++)
    if (!link_fields(s, &n->kids[i], cJSON_GetArrayItem(kids, i), err, errlen)) return false;
  return true;
}

static bool parse_scene(Scene *s, const cJSON *o, char *err, int errlen) {
  memset(s, 0, sizeof *s);
  snprintf(s->id, sizeof s->id, "%s", str(o, "id", "scene"));
  snprintf(s->audio, sizeof s->audio, "%s", str(o, "audio", ""));
  s->duration = num(o, "duration", 1);
  s->audio_start = num(o, "audioStart", 0);
  const cJSON *bg = cJSON_GetObjectItemCaseSensitive(o, "background");
  s->bg_inner = bg ? col_of(bg, "inner") : (Col){25 / 255.f, 27 / 255.f, 33 / 255.f, 1};  // #191b21
  s->bg_outer = bg ? col_of(bg, "outer") : (Col){14 / 255.f, 15 / 255.f, 18 / 255.f, 1};  // #0e0f12
  const cJSON *root = cJSON_GetObjectItemCaseSensitive(o, "root");
  if (!parse_node(s, &s->root, root, err, errlen) || !link_fields(s, &s->root, root, err, errlen)) return false;

  const cJSON *tweens = cJSON_GetObjectItemCaseSensitive(o, "tweens");
  s->ntweens = cJSON_GetArraySize(tweens);
  s->tweens = calloc(s->ntweens ? s->ntweens : 1, sizeof(Tween));
  for (int i = 0; i < s->ntweens; i++) {
    const cJSON *to = cJSON_GetArrayItem(tweens, i);
    Tween *tw = &s->tweens[i];
    tw->order = i;
    const char *target = str(to, "target", "");
    tw->target = find_target(s, target);
    if (tw->target < 0) {
      snprintf(err, errlen, "scene %s: tween targets unknown id \"%s\"", s->id, target);
      return false;
    }
    tw->prop = enum_of(str(to, "prop", ""), PROP_NAMES, P_COUNT, -1);
    if (tw->prop < 0) {
      snprintf(err, errlen, "scene %s: unknown property \"%s\"", s->id, str(to, "prop", ""));
      return false;
    }
    const cJSON *from = cJSON_GetObjectItemCaseSensitive(to, "from");
    tw->has_from = from != NULL;
    if (from) tw->from = val_of(from);
    tw->to = val_of(cJSON_GetObjectItemCaseSensitive(to, "to"));
    tw->start = num(to, "start", 0);
    tw->dur = num(to, "dur", 0);
    parse_ease(str(to, "ease", NULL), &tw->ease, &tw->ease_arg);
  }
  const cJSON *subs = cJSON_GetObjectItemCaseSensitive(o, "subtitles");
  s->nsubs = cJSON_GetArraySize(subs);
  s->subs = calloc(s->nsubs ? s->nsubs : 1, sizeof(Cue));
  for (int i = 0; i < s->nsubs; i++) {
    const cJSON *co = cJSON_GetArrayItem(subs, i);
    Cue *cue = &s->subs[i];
    cue->text = strdup(str(co, "text", ""));
    cue->start = num(co, "start", 0);
    cue->end = num(co, "end", 0);
    font_need(font_index(SUB_FONT), SUB_SIZE, cue->text);
  }
  s->sub = -1;
  qsort(s->tweens, s->ntweens, sizeof(Tween), cmp_tween);  // stable order by start time
  return true;
}

bool video_load(Video *v, const char *path, char *err, int errlen) {
  FILE *f = fopen(path, "rb");
  if (!f) {
    snprintf(err, errlen, "cannot open %s", path);
    return false;
  }
  fseek(f, 0, SEEK_END);
  long len = ftell(f);
  fseek(f, 0, SEEK_SET);
  char *buf = malloc(len + 1);
  fread(buf, 1, len, f);
  buf[len] = 0;
  fclose(f);
  cJSON *root = cJSON_Parse(buf);
  free(buf);
  if (!root) {
    snprintf(err, errlen, "%s: invalid JSON near %.40s", path, cJSON_GetErrorPtr());
    return false;
  }
  v->width = (int)num(root, "width", 1920);
  v->height = (int)num(root, "height", 1080);
  v->fps = (int)num(root, "fps", 30);
  const cJSON *scenes = cJSON_GetObjectItemCaseSensitive(root, "scenes");
  v->nscenes = cJSON_GetArraySize(scenes);
  v->scenes = calloc(v->nscenes ? v->nscenes : 1, sizeof(Scene));
  bool ok = true;
  for (int i = 0; ok && i < v->nscenes; i++) ok = parse_scene(&v->scenes[i], cJSON_GetArrayItem(scenes, i), err, errlen);
  cJSON_Delete(root);
  return ok;
}

// ---------- layout ----------

static void measure(Node *n) {
  for (int i = 0; i < n->nkids; i++) measure(&n->kids[i]);
  float cw = 0, ch = 0;
  if (n->is_text) {
    for (int i = 0; i < n->nspans; i++) {
      Span *sp = &n->spans[i];
      sp->width = font_advance(sp->font, sp->size, sp->text, n->letter_spacing);
      cw += sp->width;
    }
    if (n->line_height < 0) n->line_height = font_content_height(n->font, n->size);
    ch = n->line_height;
  } else if (n->layout != LAYOUT_NONE) {
    int count = 0;
    for (int i = 0; i < n->nkids; i++) {
      Node *k = &n->kids[i];
      if (k->abs) continue;
      if (n->layout == LAYOUT_ROW) {
        cw += k->aw;
        ch = fmaxf(ch, k->ah);
      } else {
        ch += k->ah;
        cw = fmaxf(cw, k->aw);
      }
      count++;
    }
    if (count > 1) {
      if (n->layout == LAYOUT_ROW) cw += n->gap * (count - 1);
      else ch += n->gap * (count - 1);
    }
  }
  n->aw = n->w >= 0 ? n->w : cw + n->pad[1] + n->pad[3];
  n->ah = n->h >= 0 ? n->h : ch + n->pad[0] + n->pad[2];
}

static float align_offset(int align, float space) {
  return align == ALIGN_CENTER ? space / 2 : align == ALIGN_END ? space : 0;
}

static void place(Node *n, float x, float y) {
  n->ax = x;
  n->ay = y;
  float ix = x + n->pad[3], iy = y + n->pad[0];
  float iw = n->aw - n->pad[1] - n->pad[3], ih = n->ah - n->pad[0] - n->pad[2];

  // Flow children: main-axis size and the position where pushed (margin-left: auto) items start.
  float main = 0, pushed = 0;
  int count = 0, push_from = -1;
  for (int i = 0; i < n->nkids; i++) {
    Node *k = &n->kids[i];
    if (k->abs || n->layout == LAYOUT_NONE) continue;
    if (k->push_end && push_from < 0) push_from = i;
    float size = n->layout == LAYOUT_ROW ? k->aw : k->ah;
    main += size + (count ? n->gap : 0);
    if (push_from >= 0) pushed += size + (count ? n->gap : 0);
    count++;
  }
  float avail = n->layout == LAYOUT_ROW ? iw : ih;
  float cursor = push_from >= 0 ? 0 : align_offset(n->justify, avail - main);
  bool first = true;
  for (int i = 0; i < n->nkids; i++) {
    Node *k = &n->kids[i];
    if (k->abs || n->layout == LAYOUT_NONE) {
      place(k, x + k->x + k->rel_x * n->aw - k->anchor_x * k->aw, y + k->y + k->rel_y * n->ah - k->anchor_y * k->ah);
      continue;
    }
    if (!first) cursor += n->gap;
    if (i == push_from) cursor = avail - pushed + (first ? 0 : n->gap);
    first = false;
    if (n->layout == LAYOUT_ROW) {
      place(k, ix + cursor, iy + align_offset(n->align, ih - k->ah));
      cursor += k->aw;
    } else {
      place(k, ix + align_offset(n->align, iw - k->aw), iy + cursor);
      cursor += k->ah;
    }
  }
}

// The base of w and h is the laid-out size.
static void size_bases(Scene *s, const Node *n) {
  s->targets[n->target].base[P_W].v[0] = n->aw;
  s->targets[n->target].base[P_H].v[0] = n->ah;
  for (int i = 0; i < n->nkids; i++) size_bases(s, &n->kids[i]);
}

void scene_layout(Scene *s) {
  for (int i = 0; i < s->nsubs; i++) s->subs[i].width = font_advance(font_index(SUB_FONT), SUB_SIZE, s->subs[i].text, 0);
  measure(&s->root);
  place(&s->root, s->root.x, s->root.y);
  size_bases(s, &s->root);
  // Each tween's start value comes from the ones before it, once every base value is known.
  for (int i = 0; i < s->ntweens; i++) {
    Tween *tw = &s->tweens[i];
    tw->resolved_from = tw->has_from ? tw->from : track_value(s, tw->target, tw->prop, i, tw->start);
  }
}

// ---------- animation ----------

bool scene_still(const Scene *s, float t1, float t2) {
  if (s->live) return false;
  // A tween changes the scene between t1 and t2 when it starts by t2 and has not finished by t1.
  for (int i = 0; i < s->ntweens && s->tweens[i].start <= t2; i++)
    if (s->tweens[i].start + s->tweens[i].dur > t1) return false;
  // A subtitle line appears or goes away between t1 and t2.
  for (int i = 0; i < s->nsubs; i++)
    if ((s->subs[i].start > t1 && s->subs[i].start <= t2) || (s->subs[i].end > t1 && s->subs[i].end <= t2)) return false;
  return true;
}

void scene_eval(Scene *s, float t) {
  s->t = t;
  s->sub = -1;
  for (int i = 0; i < s->nsubs; i++)
    if (s->subs[i].start <= t && t < s->subs[i].end) s->sub = i;
  for (int i = 0; i < s->ntargets; i++) memcpy(s->targets[i].cur, s->targets[i].base, sizeof s->targets[i].cur);
  // Tweens are sorted by start; for each property the latest started one wins, and a fromTo that has not started
  // yet holds its start value when it is the first tween on that property.
  static unsigned char *seen;
  static int seen_cap;
  int need = s->ntargets * P_COUNT;
  if (need > seen_cap) {
    seen = realloc(seen, need);
    seen_cap = need;
  }
  memset(seen, 0, need);
  for (int i = 0; i < s->ntweens; i++) {
    const Tween *tw = &s->tweens[i];
    unsigned char *sn = &seen[tw->target * P_COUNT + tw->prop];
    Val *cur = &s->targets[tw->target].cur[tw->prop];
    if (tw->start <= t) {
      *cur = tween_value(tw, t);
      *sn = 1;
    } else if (!*sn) {
      if (tw->has_from) *cur = tw->from;
      *sn = 1;
    }
  }
}
