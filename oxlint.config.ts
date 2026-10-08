import { defineConfig } from "oxlint"
import tsLint from "ts-lint/config"

export default defineConfig({
  extends: [tsLint],
  options: {
    typeAware: true,
    typeCheck: true,
  },
  overrides: [
    {
      // The scene DSL and its compiler are plain TypeScript for scene authors, not Effect code.
      files: ["ts/dsl.ts", "ts/compile.ts"],
      rules: {
        "ts-lint/no-unknown": "off",
        "ts-lint/no-undefined": "off",
      },
    },
  ],
})
