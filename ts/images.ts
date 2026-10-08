// Scene images with OpenAI Images, kept in videos/VIDEO/generated/images/<key>.{png,json} by prompt, settings and model.
import { join } from "node:path"
import { Console, Context, Effect, FileSystem, Layer, Redacted, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { type CredentialsError, Keyring } from "effect-lib/credentials"
import { OpenAIKey } from "./config.ts"
import { canonicalJson, sha } from "./key.ts"
import type { GeneratedImage, Scene } from "./script.ts"

// The settings an image is generated from. compile.ts finds cached images by these fields, so keep them in sync.
export const imageSpec = (image: GeneratedImage) => ({ prompt: image.prompt.trim(), size: image.size, quality: image.quality, transparent: image.transparent })

export const imageKey = (image: GeneratedImage, model: string): string => sha(canonicalJson({ ...imageSpec(image), model }))

const Generated = Schema.Struct({ data: Schema.NonEmptyArray(Schema.Struct({ b64_json: Schema.String })) })

export class ImageError extends Schema.TaggedError<ImageError>()("ImageError", {
  message: Schema.String,
}) {}

export class OpenAIImages extends Context.Service<
  OpenAIImages,
  {
    generate(image: GeneratedImage, model: string): Effect.Effect<Uint8Array, ImageError | CredentialsError>
  }
>()("cmotion/images/OpenAIImages") {
  static readonly layer = Layer.effect(
    OpenAIImages,
    Effect.gen(function* () {
      const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk)
      const keyring = yield* Keyring

      const generate: (image: GeneratedImage, model: string) => Effect.Effect<Uint8Array, ImageError | CredentialsError> = Effect.fn("OpenAIImages.generate")(function* (image: GeneratedImage, model: string) {
        const key = yield* OpenAIKey.resolve.pipe(Effect.provideService(Keyring, keyring))
        const generated = yield* HttpClientRequest.post("https://api.openai.com/v1/images/generations").pipe(
          HttpClientRequest.bearerToken(Redacted.value(key)),
          HttpClientRequest.bodyJsonUnsafe({
            model,
            prompt: image.prompt,
            size: image.size,
            quality: image.quality === "auto" ? "high" : image.quality,
            background: image.transparent ? "transparent" : "opaque",
            output_format: "png",
            n: 1,
          }),
          client.execute,
          Effect.flatMap(HttpClientResponse.schemaBodyJson(Generated)),
          Effect.mapError((error) => new ImageError({ message: `OpenAI Images failed: ${error.message}` }))
        )
        return Buffer.from(generated.data[0].b64_json, "base64")
      })

      return OpenAIImages.of({ generate })
    })
  ).pipe(Layer.provide(FetchHttpClient.layer))
}

const sceneImage: (
  image: GeneratedImage,
  sceneId: string,
  dir: string,
  model: string
) => Effect.Effect<void, ImageError | CredentialsError, OpenAIImages | FileSystem.FileSystem> = Effect.fn("sceneImage")(function* sceneImage(
  image: GeneratedImage,
  sceneId: string,
  dir: string,
  model: string
) {
  const fs = yield* FileSystem.FileSystem
  const key = imageKey(image, model)
  const png = join(dir, `${key}.png`)
  const meta = join(dir, `${key}.json`)
  const cached = (yield* fs.exists(png).pipe(Effect.orElseSucceed(() => false))) && (yield* fs.exists(meta).pipe(Effect.orElseSucceed(() => false)))
  if (cached) return yield* Console.log(`  image ${sceneId}/${image.id}: cached`)
  yield* Console.log(`  image ${sceneId}/${image.id}: generating ${image.size} with ${model}`)
  const data = yield* (yield* OpenAIImages).generate(image, model)
  yield* fs.makeDirectory(dir, { recursive: true }).pipe(
    Effect.andThen(fs.writeFile(png, data)),
    Effect.andThen(fs.writeFileString(meta, JSON.stringify({ ...imageSpec(image), model, image: `${key}.png` }, null, 2))),
    Effect.mapError((error) => new ImageError({ message: `could not write the image: ${error.message}` }))
  )
})

// Every new generated image of these scenes, a few at a time; file images are skipped. The same prompt and settings in two scenes is generated once.
export const sceneImages: (
  scenes: ReadonlyArray<Scene>,
  dir: string,
  model: string,
  concurrency: number
) => Effect.Effect<void, ImageError | CredentialsError, OpenAIImages | FileSystem.FileSystem> = Effect.fn("sceneImages")(function* sceneImages(
  scenes: ReadonlyArray<Scene>,
  dir: string,
  model: string,
  concurrency: number
) {
  const jobs = new Map(
    scenes.flatMap((scene) =>
      scene.images.flatMap((image) => ("prompt" in image ? [[imageKey(image, model), { image, sceneId: scene.id }] as const] : []))
    )
  )
  yield* Effect.forEach(jobs.values(), ({ image, sceneId }) => sceneImage(image, sceneId, dir, model), { concurrency, discard: true })
})
