# cmotion

A C renderer for motion videos: an alternative to HyperFrames for simple scenes made of code, text and basic animation.

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
