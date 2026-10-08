// The OpenGL layer: a surfaceless EGL context (no window or display server) and one batch of textured quads.
#include "gl.h"

#include <stddef.h>
#include <stdio.h>
#include <string.h>

#include <EGL/egl.h>
#include <EGL/eglext.h>

static const char *VS =
    "#version 330\n"
    "in vec3 vertexPosition; in vec2 vertexTexCoord; in vec4 vertexColor;\n"
    "out vec2 fragTexCoord; out vec4 fragColor;\n"
    "uniform mat4 mvp;\n"
    "void main() {\n"
    "  fragTexCoord = vertexTexCoord;\n"
    "  fragColor = vertexColor;\n"
    "  gl_Position = mvp * vec4(vertexPosition, 1.0);\n"
    "}\n";

static const char *TEXT_FS =
    "#version 330\n"
    "in vec2 fragTexCoord; in vec4 fragColor; out vec4 finalColor;\n"
    "uniform sampler2D texture0;\n"
    "void main() { finalColor = texture(texture0, fragTexCoord) * fragColor; }\n";

typedef struct {
  float x, y, z, u, v;
  Rgba8 c;
} Vertex;

#define MAX_QUADS 8192

static EGLDisplay display = EGL_NO_DISPLAY;
static EGLContext context = EGL_NO_CONTEXT;
static GLuint vao, vbo, white, text_shader;
static GLuint program, texture;
static float mvp[16];
static Vertex verts[MAX_QUADS * 6];
static int nverts;

static bool has_ext(const char *list, const char *name) {
  size_t n = strlen(name);
  for (const char *p = list; p && (p = strstr(p, name)); p += n)
    if ((p == list || p[-1] == ' ') && (p[n] == ' ' || p[n] == 0)) return true;
  return false;
}

// Mesa's surfaceless platform first, then the first GPU device (NVIDIA), then whatever the default display is.
static EGLDisplay open_display(void) {
  const char *ext = eglQueryString(EGL_NO_DISPLAY, EGL_EXTENSIONS);
  PFNEGLGETPLATFORMDISPLAYEXTPROC platform = (PFNEGLGETPLATFORMDISPLAYEXTPROC)eglGetProcAddress("eglGetPlatformDisplayEXT");
  EGLDisplay d;
  if (platform && has_ext(ext, "EGL_MESA_platform_surfaceless")) {
    d = platform(EGL_PLATFORM_SURFACELESS_MESA, EGL_DEFAULT_DISPLAY, NULL);
    if (d != EGL_NO_DISPLAY && eglInitialize(d, NULL, NULL)) return d;
  }
  PFNEGLQUERYDEVICESEXTPROC devices = (PFNEGLQUERYDEVICESEXTPROC)eglGetProcAddress("eglQueryDevicesEXT");
  if (platform && devices && has_ext(ext, "EGL_EXT_platform_device")) {
    EGLDeviceEXT list[8];
    EGLint n = 0;
    if (devices(8, list, &n))
      for (int i = 0; i < n; i++) {
        d = platform(EGL_PLATFORM_DEVICE_EXT, list[i], NULL);
        if (d != EGL_NO_DISPLAY && eglInitialize(d, NULL, NULL)) return d;
      }
  }
  d = eglGetDisplay(EGL_DEFAULT_DISPLAY);
  return d != EGL_NO_DISPLAY && eglInitialize(d, NULL, NULL) ? d : EGL_NO_DISPLAY;
}

static GLuint compile(GLenum kind, const char *src) {
  GLuint s = glCreateShader(kind);
  glShaderSource(s, 1, &src, NULL);
  glCompileShader(s);
  GLint ok;
  glGetShaderiv(s, GL_COMPILE_STATUS, &ok);
  if (!ok) {
    char log[2048];
    glGetShaderInfoLog(s, sizeof log, NULL, log);
    fprintf(stderr, "cmotion: shader: %s\n", log);
  }
  return s;
}

GLuint gl_shader(const char *fs) {
  GLuint p = glCreateProgram();
  glAttachShader(p, compile(GL_VERTEX_SHADER, VS));
  glAttachShader(p, compile(GL_FRAGMENT_SHADER, fs));
  glBindAttribLocation(p, 0, "vertexPosition");
  glBindAttribLocation(p, 1, "vertexTexCoord");
  glBindAttribLocation(p, 2, "vertexColor");
  glLinkProgram(p);
  GLint ok;
  glGetProgramiv(p, GL_LINK_STATUS, &ok);
  if (!ok) {
    char log[2048];
    glGetProgramInfoLog(p, sizeof log, NULL, log);
    fprintf(stderr, "cmotion: shader program: %s\n", log);
  }
  glUseProgram(p);
  glUniform1i(glGetUniformLocation(p, "texture0"), 0);
  glUseProgram(program);
  return p;
}

bool gl_init(char *err, int errlen) {
  display = open_display();
  if (display == EGL_NO_DISPLAY) {
    snprintf(err, errlen, "no EGL display (error 0x%x)", eglGetError());
    return false;
  }
  EGLConfig config = NULL;
  EGLint nconfig = 0;
  const EGLint config_attrs[] = {EGL_RENDERABLE_TYPE, EGL_OPENGL_BIT, EGL_SURFACE_TYPE, EGL_PBUFFER_BIT, EGL_NONE};
  bool no_config = has_ext(eglQueryString(display, EGL_EXTENSIONS), "EGL_KHR_no_config_context");
  if (!no_config && (!eglChooseConfig(display, config_attrs, &config, 1, &nconfig) || nconfig < 1)) {
    snprintf(err, errlen, "no EGL config for desktop OpenGL");
    return false;
  }
  const EGLint context_attrs[] = {EGL_CONTEXT_MAJOR_VERSION, 3, EGL_CONTEXT_MINOR_VERSION, 3,
                                  EGL_CONTEXT_OPENGL_PROFILE_MASK, EGL_CONTEXT_OPENGL_CORE_PROFILE_BIT, EGL_NONE};
  if (!eglBindAPI(EGL_OPENGL_API) ||
      (context = eglCreateContext(display, no_config ? EGL_NO_CONFIG_KHR : config, EGL_NO_CONTEXT, context_attrs)) == EGL_NO_CONTEXT ||
      !eglMakeCurrent(display, EGL_NO_SURFACE, EGL_NO_SURFACE, context)) {
    snprintf(err, errlen, "cannot create an OpenGL 3.3 context (EGL error 0x%x)", eglGetError());
    return false;
  }

  glGenVertexArrays(1, &vao);
  glBindVertexArray(vao);
  glGenBuffers(1, &vbo);
  glBindBuffer(GL_ARRAY_BUFFER, vbo);
  glBufferData(GL_ARRAY_BUFFER, sizeof verts, NULL, GL_STREAM_DRAW);
  glVertexAttribPointer(0, 3, GL_FLOAT, GL_FALSE, sizeof(Vertex), (void *)offsetof(Vertex, x));
  glVertexAttribPointer(1, 2, GL_FLOAT, GL_FALSE, sizeof(Vertex), (void *)offsetof(Vertex, u));
  glVertexAttribPointer(2, 4, GL_UNSIGNED_BYTE, GL_TRUE, sizeof(Vertex), (void *)offsetof(Vertex, c));
  for (int i = 0; i < 3; i++) glEnableVertexAttribArray(i);

  glDisable(GL_DEPTH_TEST);
  glDisable(GL_CULL_FACE);
  glEnable(GL_BLEND);
  gl_blend(BLEND_ALPHA);
  glPixelStorei(GL_PACK_ALIGNMENT, 1);
  glPixelStorei(GL_UNPACK_ALIGNMENT, 1);

  const unsigned char px[4] = {255, 255, 255, 255};
  white = gl_texture(1, 1, px, false);
  text_shader = gl_shader(TEXT_FS);
  return true;
}

void gl_close(void) {
  eglMakeCurrent(display, EGL_NO_SURFACE, EGL_NO_SURFACE, EGL_NO_CONTEXT);
  eglDestroyContext(display, context);
  eglTerminate(display);
}

GLuint gl_text_shader(void) { return text_shader; }
GLuint gl_white(void) { return white; }

GLuint gl_texture(int w, int h, const unsigned char *rgba, bool mipmaps) {
  gl_flush();
  GLuint t;
  glGenTextures(1, &t);
  glBindTexture(GL_TEXTURE_2D, t);
  glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA8, w, h, 0, GL_RGBA, GL_UNSIGNED_BYTE, rgba);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_REPEAT);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_REPEAT);
  if (mipmaps) glGenerateMipmap(GL_TEXTURE_2D);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, mipmaps ? GL_LINEAR_MIPMAP_LINEAR : GL_LINEAR);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
  glBindTexture(GL_TEXTURE_2D, texture);
  return t;
}

Fbo gl_fbo(int w, int h) {
  Fbo f = {0, gl_texture(w, h, NULL, false), w, h};
  glGenFramebuffers(1, &f.fbo);
  glBindFramebuffer(GL_FRAMEBUFFER, f.fbo);
  glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, f.tex, 0);
  return f;
}

void gl_begin(Fbo f) {
  gl_flush();
  glBindFramebuffer(GL_FRAMEBUFFER, f.fbo);
  glViewport(0, 0, f.w, f.h);
  // Orthographic, top-left origin, depth 0..1, computed like raylib's rlOrtho(0, w, h, 0, 0, 1).
  float rl = (float)f.w, tb = (float)(0 - f.h), fn = 1.0f;
  memset(mvp, 0, sizeof mvp);
  mvp[0] = 2.0f / rl;
  mvp[5] = 2.0f / tb;
  mvp[10] = -2.0f / fn;
  mvp[12] = -(0.0f + (float)f.w) / rl;
  mvp[13] = -(0.0f + (float)f.h) / tb;
  mvp[14] = -(1.0f + 0.0f) / fn;
  mvp[15] = 1.0f;
  if (program) glUniformMatrix4fv(glGetUniformLocation(program, "mvp"), 1, GL_FALSE, mvp);
}

void gl_clear(Rgba8 c) {
  gl_flush();
  glClearColor(c.r / 255.0f, c.g / 255.0f, c.b / 255.0f, c.a / 255.0f);
  glClear(GL_COLOR_BUFFER_BIT);
}

void gl_read(Fbo f, unsigned char *rgba) {
  gl_flush();
  glBindFramebuffer(GL_FRAMEBUFFER, f.fbo);
  glReadPixels(0, 0, f.w, f.h, GL_RGBA, GL_UNSIGNED_BYTE, rgba);
}

void gl_use(GLuint p) {
  if (p == program) return;
  gl_flush();
  program = p;
  glUseProgram(p);
  glUniformMatrix4fv(glGetUniformLocation(p, "mvp"), 1, GL_FALSE, mvp);
}

void gl_blend(int mode) {
  gl_flush();
  if (mode == BLEND_OFF) {
    glDisable(GL_BLEND);
    return;
  }
  glEnable(GL_BLEND);
  glBlendEquation(GL_FUNC_ADD);
  glBlendFunc(mode == BLEND_PREMULTIPLIED ? GL_ONE : GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA);
}

GLint gl_loc(const char *name) { return glGetUniformLocation(program, name); }

void gl_uniform1f(GLint loc, float v) { gl_flush(); glUniform1f(loc, v); }
void gl_uniform2f(GLint loc, const float *v) { gl_flush(); glUniform2fv(loc, 1, v); }
void gl_uniform3f(GLint loc, const float *v) { gl_flush(); glUniform3fv(loc, 1, v); }
void gl_uniform4f(GLint loc, const float *v) { gl_flush(); glUniform4fv(loc, 1, v); }
void gl_uniform2i(GLint loc, const int *v) { gl_flush(); glUniform2iv(loc, 1, v); }

void gl_quad(GLuint tex, const float xy[8], const float uv[8], Rgba8 c) {
  if (tex != texture || nverts + 6 > MAX_QUADS * 6) {
    gl_flush();
    texture = tex;
    glBindTexture(GL_TEXTURE_2D, tex);
  }
  // Two triangles, 0-1-2 and 0-2-3, like raylib's quad indices. z = -0.5 lands mid depth range.
  static const int order[6] = {0, 1, 2, 0, 2, 3};
  for (int i = 0; i < 6; i++) {
    int k = order[i];
    verts[nverts++] = (Vertex){xy[2 * k], xy[2 * k + 1], -0.5f, uv[2 * k], uv[2 * k + 1], c};
  }
}

void gl_rect(GLuint tex, int tex_w, int tex_h, float sx, float sy, float sw, float sh, float x, float y, float w, float h, Rgba8 c) {
  float tw = (float)tex_w, th = (float)tex_h;
  float u0 = sx / tw, v0 = sy / th, u1 = (sx + sw) / tw, v1 = (sy + sh) / th;
  const float xy[8] = {x, y, x, y + h, x + w, y + h, x + w, y};
  const float uv[8] = {u0, v0, u0, v1, u1, v1, u1, v0};
  gl_quad(tex, xy, uv, c);
}

void gl_flush(void) {
  if (!nverts) return;
  // Orphan the buffer so the driver need not wait for the previous draw to finish reading it.
  glBufferData(GL_ARRAY_BUFFER, sizeof verts, NULL, GL_STREAM_DRAW);
  glBufferSubData(GL_ARRAY_BUFFER, 0, (GLsizeiptr)(nverts * sizeof(Vertex)), verts);
  glDrawArrays(GL_TRIANGLES, 0, nverts);
  nverts = 0;
}
