#!/usr/bin/env bun
// cmotion: videos generated from a script and TypeScript scenes, rendered with the C engine. Every step is cached.
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Console, Effect, Layer, Option } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import { bunKeyring } from "effect-lib/credentials"
import { build } from "./build.ts"
import { configPath, credentials, engineDir, loadConfig, version } from "./config.ts"
import { Engine } from "./engine.ts"
import { OpenAIImages, sceneImages } from "./images.ts"
import { inspect, stills } from "./inspect.ts"
import { imageDir, musicDir, videoDir, voiceoverDir } from "./layout.ts"
import { music, MusicGeneration } from "./music.ts"
import { loadScript, selectScenes } from "./script.ts"
import { ElevenLabs, voiceover } from "./voiceover.ts"

const cmotion = Command.make("cmotion").pipe(
  Command.withSharedFlags({
    root: Flag.String("root").pipe(Flag.withDescription("Project root holding videos/VIDEO"), Flag.withDefault(".")),
  }),
  Command.withDescription(
    "Generated videos in videos/VIDEO: script.json lists the scenes and their voiceovers, scenes/<id>.ts draws each one, theme.ts holds the look. Voiceovers, images and music go to generated/, working files to build/, the video to script.mp4. Every step is cached."
  )
)

const video = Argument.String("video").pipe(Argument.withDescription("Video name: the folder under videos/"))
const scenes = Flag.String("scene").pipe(Flag.withAlias("s"), Flag.withDescription("Only this scene id (repeatable)"), Flag.atLeast(0))

const voiceoverCommand = Command.make(
  "voiceover",
  { video, scenes },
  Effect.fn("voiceoverCommand")(function* voiceoverCommand({ video, scenes }) {
    const dir = videoDir((yield* cmotion).root, video)
    const script = yield* loadScript(dir)
    for (const scene of yield* selectScenes(script, scenes)) yield* voiceover(script, scene, voiceoverDir(dir))
  })
).pipe(Command.withDescription("Generate each scene's voiceover with ElevenLabs into generated/voiceover/, skipping text already generated"))

const images = Command.make(
  "images",
  { video, scenes },
  Effect.fn("imagesCommand")(function* imagesCommand({ video, scenes }) {
    const dir = videoDir((yield* cmotion).root, video)
    const config = yield* loadConfig
    const script = yield* loadScript(dir)
    yield* sceneImages(yield* selectScenes(script, scenes), imageDir(dir), config.imageModel, config.imageJobs)
  })
).pipe(Command.withDescription("Generate each scene's images with OpenAI Images into generated/images/, skipping prompts and settings already generated"))

const musicCommand = Command.make(
  "music",
  { video },
  Effect.fn("musicCommand")(function* musicCommand({ video }) {
    const dir = videoDir((yield* cmotion).root, video)
    const script = yield* loadScript(dir)
    if (!script.music) return yield* Console.log("  music: none in the script")
    yield* music(script.music, musicDir(dir))
  })
).pipe(Command.withDescription("Generate background music with OpenRouter or Gemini into generated/music/, skipping a provider, prompt and model already generated"))

const buildCommand = Command.make(
  "build",
  {
    video,
    scenes,
    preset: Flag.String("preset").pipe(Flag.withDescription("x264 preset (default from the config, veryfast)"), Flag.optional),
    crf: Flag.Int("crf").pipe(Flag.withDescription("x264 CRF (default from the config, 18)"), Flag.optional),
  },
  Effect.fn("buildCommand")(function* buildCommand({ video, scenes, preset, crf }) {
    const config = yield* loadConfig
    const encoding = { preset: Option.getOrElse(preset, () => config.preset), crf: Option.getOrElse(crf, () => config.crf) }
    yield* build(videoDir((yield* cmotion).root, video), scenes, { ...config, ...encoding })
  })
).pipe(
  Command.withDescription(
    "Voiceovers, images, music, scene renders to build/scenes/<id>.mp4 and the joined script.mp4, redoing only what changed. With --scene, only those scenes render and nothing is joined."
  )
)

const sheetFlags = (columns: number, width: number) => ({
  columns: Flag.Int("columns").pipe(Flag.withAlias("c"), Flag.withDescription("Frames per row in a sheet"), Flag.withDefault(columns)),
  width: Flag.Int("width").pipe(Flag.withAlias("w"), Flag.withDescription("Width of each frame in a sheet, px"), Flag.withDefault(width)),
})

const still = Command.make(
  "still",
  {
    video,
    frames: Argument.String("frame").pipe(
      Argument.withDescription(
        "A frame: SCENE (its settled last frame), SCENE:SECONDS, or SCENE@WORD (when the voiceover says it; #N for the Nth time, +0.5 or -0.2 to shift), like cue@now#2+0.3"
      ),
      Argument.atLeast(1)
    ),
    out: Flag.String("output").pipe(Flag.withAlias("o"), Flag.withDescription("PNG path (default a new numbered file in videos/VIDEO/build/stills/)"), Flag.optional),
    ...sheetFlags(2, 960),
  },
  Effect.fn("stillCommand")(function* stillCommand({ video, frames, out, columns, width }) {
    const dir = videoDir((yield* cmotion).root, video)
    yield* stills(dir, (yield* loadConfig).imageModel, frames, { columns, width }, out)
  })
).pipe(
  Command.withDescription(
    "Compile only the scenes asked for and render those frames to one PNG, tiled and labelled when there are several, without a full render. Prints the layout problems of those scenes: nodes that leave the frame or sit under a showing subtitle"
  )
)

const inspectCommand = Command.make(
  "inspect",
  {
    video,
    out: Flag.String("output").pipe(Flag.withAlias("o"), Flag.withDescription("PNG path (default a new numbered file in videos/VIDEO/build/inspect/)"), Flag.optional),
    ...sheetFlags(3, 640),
  },
  Effect.fn("inspectCommand")(function* inspectCommand({ video, out, columns, width }) {
    const dir = videoDir((yield* cmotion).root, video)
    yield* inspect(dir, (yield* loadConfig).imageModel, { columns, width }, out)
  })
).pipe(
  Command.withDescription(
    "Compile the scenes and tile each one's settled last frame (just before its fade-out) into one labelled PNG, an overview of the whole video without a full render. Prints every scene's layout problems: nodes that leave the frame or sit under a showing subtitle"
  )
)

const engine = Command.make(
  "engine",
  {},
  Effect.fn("engineCommand")(function* engineCommand() {
    yield* Console.log(yield* (yield* Engine).binary)
  })
).pipe(Command.withDescription(`Build the C engine if needed (into ${engineDir}) and print its path`))

const configCommand = Command.make(
  "config",
  {},
  Effect.fn("configCommand")(function* configCommand() {
    yield* Console.log(configPath)
    yield* Console.log(JSON.stringify(yield* loadConfig, null, 2))
  })
).pipe(Command.withDescription("Print the config file path and the effective config"))

const app = cmotion.pipe(Command.withSubcommands([voiceoverCommand, images, musicCommand, buildCommand, still, inspectCommand, engine, configCommand, ...credentials.commands]))

// The API clients read their keys through the keyring, so it sits under them as well as alongside.
const AppLayer = Layer.mergeAll(ElevenLabs.layer, OpenAIImages.layer, MusicGeneration.live, Engine.layer).pipe(
  Layer.provideMerge(Layer.merge(BunServices.layer, credentials.layer(bunKeyring())))
)

BunRuntime.runMain(Command.run(app, { version }).pipe(Effect.provide(AppLayer)))
