// One video's folder, videos/VIDEO under the project root.
//
// - script.json, theme.ts, scenes/<id>.ts: what you write
// - generated/voiceover/, generated/images/, generated/music/: paid to make, so kept
// - build/: render.json, scenes/<id>.mp4, stills/, safe to delete
// - script.mp4: the joined video
import { join, resolve } from "node:path"

export const videoDir = (root: string, video: string): string => resolve(root, "videos", video)

export const scriptFile = (dir: string) => join(dir, "script.json")
export const sceneFile = (dir: string, id: string) => join(dir, "scenes", `${id}.ts`)
export const voiceoverDir = (dir: string) => join(dir, "generated", "voiceover")
export const imageDir = (dir: string) => join(dir, "generated", "images")
export const musicDir = (dir: string) => join(dir, "generated", "music")
export const buildDir = (dir: string) => join(dir, "build")
export const renderFile = (dir: string) => join(buildDir(dir), "render.json")
export const sceneRenderDir = (dir: string) => join(buildDir(dir), "scenes")
export const stillsDir = (dir: string) => join(buildDir(dir), "stills")
export const outputFile = (dir: string) => join(dir, "script.mp4")
