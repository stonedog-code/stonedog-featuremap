import tseslint from "typescript-eslint"

export default tseslint.config(
  {
    // dist/ is a GENERATED bundle -- esbuild output containing ajv's compiled
    // code. Linting it reports on a dependency's style, which nobody can act
    // on, and would push people toward inline disables in a file that is
    // rewritten on every build. `check:bundle` is what guards dist/.
    ignores: ["node_modules/**", "coverage/**", "dist/**"],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      // The validator takes `unknown` and narrows it deliberately; a few casts
      // at that boundary are the point of the function, not an oversight.
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
)
