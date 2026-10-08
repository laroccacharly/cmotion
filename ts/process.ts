// Runs a program to completion, failing with the tail of its stderr when it exits non-zero.
import { Effect, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

export class ProcessError extends Schema.TaggedError<ProcessError>()("ProcessError", {
  message: Schema.String,
}) {}

export interface RunOptions {
  // Show the program's stdout (and stderr) live instead of keeping them.
  readonly inherit?: boolean
}

// Resolves to the program's stdout, or "" when it is inherited.
export const run: (
  what: string,
  command: string,
  args: ReadonlyArray<string>,
  options?: RunOptions
) => Effect.Effect<string, ProcessError, ChildProcessSpawner.ChildProcessSpawner> = Effect.fn("run")(function* run(
  what: string,
  command: string,
  args: ReadonlyArray<string>,
  options: RunOptions = {}
) {
  const failed = (message: string) => new ProcessError({ message: `${what} failed: ${message}` })
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const output = options.inherit ? "inherit" : "pipe"
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(ChildProcess.make(command, [...args], { stdout: output, stderr: output }))
      const text = (stream: typeof handle.stdout) => (options.inherit ? Effect.succeed("") : stream.pipe(Stream.decodeText(), Stream.mkString))
      const [stdout, stderr, exitCode] = yield* Effect.all([text(handle.stdout), text(handle.stderr), handle.exitCode], { concurrency: "unbounded" })
      if (exitCode !== ChildProcessSpawner.ExitCode(0)) return yield* failed(`exit code ${exitCode}\n${stderr.slice(-2000)}`)
      return stdout
    })
  ).pipe(Effect.catchTag("PlatformError", (error) => Effect.fail(failed(error.message))))
})
