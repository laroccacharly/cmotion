// A small OpenGL 3.3 layer: a headless EGL context, render targets, shaders and batched textured quads.
// It reproduces the raylib state the engine was written against: top-left origin, alpha blending, vertex colors
// as normalized bytes, and the default vertex shader with `fragTexCoord` and `fragColor`.
#pragma once
#include <stdbool.h>

#define GL_GLEXT_PROTOTYPES
#include <GL/gl.h>
#include <GL/glext.h>

typedef struct { unsigned char r, g, b, a; } Rgba8;

typedef struct {
  GLuint fbo, tex;
  int w, h;
} Fbo;

enum { BLEND_ALPHA, BLEND_PREMULTIPLIED, BLEND_OFF };

bool gl_init(char *err, int errlen);
void gl_close(void);

// A program from the default vertex shader and fs; texture unit 0 is `texture0`.
GLuint gl_shader(const char *fs);
GLuint gl_text_shader(void);  // texture * vertex color, like raylib's default shader
GLuint gl_white(void);        // a 1x1 white texture, for quads whose shader samples nothing

// Textures wrap with GL_REPEAT. Mipmapped textures filter trilinearly, the others bilinearly.
GLuint gl_texture(int w, int h, const unsigned char *rgba, bool mipmaps);

Fbo gl_fbo(int w, int h);
void gl_begin(Fbo f);  // draws into f, with (0, 0) at its top left
void gl_clear(Rgba8 c);
void gl_read(Fbo f, unsigned char *rgba);  // rows bottom-up, as GL stores them

// Drawing state. Each change first draws the quads queued so far.
void gl_use(GLuint program);
void gl_blend(int mode);
GLint gl_loc(const char *name);  // in the current program
void gl_uniform1f(GLint loc, float v);
void gl_uniform2f(GLint loc, const float *v);
void gl_uniform3f(GLint loc, const float *v);
void gl_uniform4f(GLint loc, const float *v);
void gl_uniform2i(GLint loc, const int *v);

// A quad given by its corners in order top-left, bottom-left, bottom-right, top-right.
void gl_quad(GLuint tex, const float xy[8], const float uv[8], Rgba8 c);
// An axis-aligned rect, with src in texels of a tex_w x tex_h texture.
void gl_rect(GLuint tex, int tex_w, int tex_h, float sx, float sy, float sw, float sh, float x, float y, float w, float h, Rgba8 c);
void gl_flush(void);
