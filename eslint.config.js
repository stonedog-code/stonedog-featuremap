import tseslint from "typescript-eslint"

export default tseslint.config(
  { ignores: ["node_modules/**", "coverage/**"] },
  ...tseslint.configs.recommended,
  {
    rules: {
      // The validator takes `unknown` and narrows it deliberately; a few casts
      // at that boundary are the point of the function, not an oversight.
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
)
