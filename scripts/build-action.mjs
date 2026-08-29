#!/usr/bin/env node
/**
 * Bundle the action into the single file GitHub actually runs.
 *
 * `dist/index.js` is COMMITTED, because a JavaScript action has no install step
 * — the runner executes exactly this file. That is the whole reason the action
 * works in a repository with no Node toolchain, and it is also why the bundle
 * can go stale: an edit under src/ that is not rebuilt means CI silently runs
 * the OLD logic and reports success. `npm run check:bundle` refuses that, and
 * CI runs it.
 *
 * Bundled, not externalised: `ajv` and the validator must be INSIDE the file,
 * or the action needs an npm install and every argument for shipping it as an
 * action collapses.
 */
import { build } from "esbuild"

const result = await build({
  entryPoints: ["src/action/main.ts"],
  outfile: "dist/index.js",
  bundle: true,
  platform: "node",
  // Matches `runs.using: node24` in action.yml. Targeting lower would emit
  // downlevelled code for a runtime that does not need it; targeting higher
  // would emit syntax the runner cannot parse, and the failure would be a
  // SyntaxError in somebody else's CI.
  target: "node24",
  // ESM, because this package declares `"type": "module"` -- a `.js` file here
  // is parsed as ESM whatever esbuild emitted. A CJS bundle built and looked
  // fine, then died at run time with "module is not defined in ES module
  // scope". The build succeeding is not evidence the artifact runs, which is
  // why check:bundle is not the only thing that exercises it.
  // ESM, matching this package's `"type": "module"`. A CJS bundle is parsed as
  // ESM here and dies with "module is not defined"; that was observed, not
  // predicted. ESM only works because the action has no dependency doing a
  // dynamic `require` -- which is one of the reasons runner.ts exists instead
  // of `@actions/core`.
  format: "esm",
  // Deterministic output, so `check:bundle` compares logic rather than
  // whitespace or a timestamp.
  minify: false,
  sourcemap: false,
  legalComments: "none",
  logLevel: "info",
  metafile: true,
})

const bytes = Object.values(result.metafile.outputs)[0]?.bytes ?? 0
process.stdout.write(`bundled dist/index.js — ${bytes} bytes\n`)
