// The C engine: compiled from this package's src/ on first use, into a cache directory keyed by a hash of its sources.
import { basename, dirname, join } from "node:path"
import { Console, Context, Effect, FileSystem, Layer } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import { engineDir, engineFlags, engineHash, engineLibs, engineSources, fontsDir, packageDir } from "./config.ts"
import { ProcessError, run } from "./process.ts"

export interface Encoding {
  readonly preset: string
  readonly crf: number
}

export class Engine extends Context.Service<
  Engine,
  {
    // The engine binary, built when it is missing.
    readonly binary: Effect.Effect<string, ProcessError>
    // Renders one scene of a compiled render.json to an mp4.
    render(renderJson: string, sceneId: string, out: string, encoding: Encoding): Effect.Effect<void, ProcessError>
    // Renders the frame at SCENE:SECONDS to a PNG. With bounds, resolves to the engine's JSON list of the scene's
    // nodes that leave the frame or sit under a subtitle; otherwise to "".
    still(renderJson: string, at: string, out: string, bounds?: boolean): Effect.Effect<string, ProcessError>
  }
>()("cmotion/engine/Engine") {
  static readonly layer: Layer.Layer<Engine, never, ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem> = Layer.effect(
    Engine,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const context = yield* Effect.context<ChildProcessSpawner.ChildProcessSpawner>()
      const bin = join(engineDir, "bin", "cmotion")
      const fsError = (error: { readonly message: string }) => new ProcessError({ message: `engine build: ${error.message}` })

      // engineDir is keyed by the sources, so an existing binary is current. Otherwise each file compiles in
      // parallel, and the link goes to a temporary name renamed into place, so an interrupted build leaves no binary.
      const build = Effect.gen(function* () {
        if (yield* fs.exists(bin).pipe(Effect.orElseSucceed(() => false))) return bin
        yield* Console.log(`  engine: building ${engineHash} into ${engineDir}`)
        const work = join(engineDir, `build-${process.pid}`)
        yield* fs.makeDirectory(work, { recursive: true }).pipe(Effect.mapError(fsError))
        const include = `-I${join(packageDir, "src", "vendor")}`
        const objects = yield* Effect.forEach(
          engineSources.filter((file) => file.endsWith(".c")),
          (file) => {
            const object = join(work, `${basename(file, ".c")}.o`)
            return run(`compile ${file}`, "cc", [...engineFlags, include, "-c", join(packageDir, "src", file), "-o", object]).pipe(Effect.as(object))
          },
          { concurrency: "unbounded" }
        )
        const linked = join(work, "cmotion")
        yield* run("engine link", "cc", [...objects, "-o", linked, ...engineLibs])
        yield* fs.makeDirectory(dirname(bin), { recursive: true }).pipe(Effect.andThen(fs.rename(linked, bin)), Effect.mapError(fsError))
        yield* fs.remove(work, { recursive: true }).pipe(Effect.ignore)
        return bin
      }).pipe(Effect.provide(context))
      const binary = yield* Effect.cached(build)

      // The engine does not create the output's folder.
      const engine = (what: string, out: string, args: ReadonlyArray<string>) =>
        fs.makeDirectory(dirname(out), { recursive: true }).pipe(
          Effect.mapError((error) => new ProcessError({ message: `${what}: ${error.message}` })),
          Effect.andThen(binary),
          Effect.flatMap((bin) => run(what, bin, [...args, "-o", out, "--fonts", fontsDir])),
          Effect.provide(context)
        )

      const render = (renderJson: string, sceneId: string, out: string, encoding: Encoding) =>
        engine(`scene ${sceneId}: cmotion`, out, [renderJson, "-s", sceneId, "--preset", encoding.preset, "--crf", String(encoding.crf)]).pipe(Effect.asVoid)

      const still = (renderJson: string, at: string, out: string, bounds = false) =>
        engine(`still ${at}: cmotion`, out, [renderJson, "--still", at, ...(bounds ? ["--bounds"] : [])]).pipe(Effect.map((stdout) => (bounds ? stdout : "")))

      return Engine.of({ binary, render, still })
    })
  )
}
