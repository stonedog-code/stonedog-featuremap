/**
 * Copyright (C) 2026 StoneDogCode L.L.C.
 *
 * Is this a valid feature map?
 *
 * ## Why the answer is a value and not an exception
 *
 * The gate has to distinguish two verdicts that look identical from the outside
 * and mean opposite things: **this map is malformed** and **this map is fine
 * and found unmapped files**. Both are a red check. Only one of them means the
 * pull request did anything wrong.
 *
 * Throwing collapses that. A caller that wraps the parse in try/catch reports
 * "feature map check failed" for both, and the author of a perfectly good
 * change spends an afternoon looking for the file they failed to map. So this
 * returns a verdict, the caller branches on it, and both exit paths are
 * asserted in the tests.
 *
 * ## Structural rules the schema cannot state
 *
 * JSON Schema cannot express "keys are unique across two nesting levels", so
 * `duplicateKeys` runs here and its findings are reported as errors of the same
 * weight. Putting it in the caller would make it optional in practice, and the
 * one caller that forgot would accept a map whose keys silently overwrite each
 * other.
 */

// The NAMED export, not the default. Ajv is CommonJS: `module.exports` is the
// constructor and also carries a `.default` pointing at itself. Under
// NodeNext, TypeScript resolves the default import to the namespace object,
// which is not constructable -- `TS2351: This expression is not constructable`.
//
// This mattered more than the error suggests. ts-jest was configured with
// `moduleResolution: "bundler"`, which resolves the default import happily, so
// the whole suite passed green while `tsc` failed. Two tools disagreeing about
// what the code means is worse than either being wrong; the jest config now
// uses NodeNext too, so the tests exercise the resolution the package ships.
import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";

import schema from "../schema/feature-map.schema.json" with { type: "json" };
import { duplicateKeys, misprefixedFeatureKeys } from "./derive.js";
import type { FeatureMap } from "./types.js";

export interface ValidationError {
  /** JSON Pointer to the offending node, or "" for the document itself. */
  path: string;
  message: string;
}

export type Validation =
  | { valid: true; map: FeatureMap }
  | { valid: false; errors: ValidationError[] };

/** The schema, exported so a consumer can publish or inspect it. */
export { schema };

// `allErrors` because a map with four problems should report four. The default
// stops at the first, which turns one migration into four round trips.
//
// `strict: false` — the schema uses `description` beside `$ref`, which draft
// 2020-12 permits and Ajv's strict mode rejects as a likely mistake. Here it is
// deliberate: the descriptions ARE the documentation for this format.
const ajv = new Ajv2020({ allErrors: true, strict: false });
const compiled = ajv.compile(schema);

function describe(error: ErrorObject): ValidationError {
  // `oneOf` on its own says "must match exactly one schema", which tells the
  // reader nothing about which rule they broke. The union is the single most
  // likely thing to get wrong when hand-editing a map, so it gets a sentence
  // rather than a keyword.
  if (error.keyword === "oneOf") {
    return {
      path: error.instancePath,
      message:
        "a group must carry exactly one of `codePaths` or `features` — not both, and not neither",
    };
  }
  // `additionalProperties` reports "must NOT have additional properties" and
  // puts the offending key in `params`, not in the message. For a migration
  // that is the whole answer -- which field do I delete -- so it is folded in.
  // Without it the top-level `features` array this schema exists to remove
  // produces an error that does not contain the word "features".
  if (error.keyword === "additionalProperties") {
    const offending = (error.params as { additionalProperty?: string }).additionalProperty;
    return {
      path: error.instancePath,
      message: `unknown property \`${offending}\` — this schema lists every field it accepts, so an unrecognised one is either a typo or a field that was deliberately removed`,
    };
  }
  return { path: error.instancePath, message: error.message ?? "is invalid" };
}

/**
 * Ajv's raw errors, reduced to the ones a person can act on.
 *
 * The union is expressed as `oneOf` over two `not` branches, so a group that
 * gets it wrong produces THREE errors at the same path: two bare
 * "must NOT be valid" from the internals, and one `oneOf`. Only the last is
 * about anything the reader controls.
 *
 * Reporting all three is not merely untidy. The two noise lines say nothing,
 * sit above the useful one, and are the first thing a person sees when their
 * map is refused -- so the message that would have told them what to fix is the
 * one they scroll past. A validator whose output is ignored is a validator that
 * did not run.
 */
function presentable(errors: ErrorObject[]): ValidationError[] {
  const unionPaths = new Set(
    errors.filter((error) => error.keyword === "oneOf").map((error) => error.instancePath),
  );
  return errors
    .filter((error) => !(error.keyword === "not" && unionPaths.has(error.instancePath)))
    .map(describe);
}

/**
 * Validate a parsed map.
 *
 * Takes `unknown` rather than `FeatureMap`, deliberately: the input comes from
 * `JSON.parse`, so typing the parameter as the thing being checked would let a
 * caller assert the very fact this function exists to establish.
 */
export function validate(input: unknown): Validation {
  if (!compiled(input)) {
    return { valid: false, errors: presentable(compiled.errors ?? []) };
  }

  // Through `unknown`: Ajv's compiled validator is a type guard that narrows
  // `input` to a shape inferred from the schema literal, which does not overlap
  // with the hand-written FeatureMap. The narrowing is real -- the document
  // just passed the schema -- so this asserts the type the rest of the package
  // is written against rather than the one Ajv happened to infer.
  const map = input as unknown as FeatureMap;

  const duplicates = duplicateKeys(map);
  if (duplicates.length > 0) {
    return {
      valid: false,
      errors: duplicates.map((key) => ({
        path: "/featureGroups",
        message: `duplicate key \`${key}\` — a key is an identity, and two things sharing one silently overwrite each other wherever it is used as an index`,
      })),
    };
  }

  const misprefixed = misprefixedFeatureKeys(map);
  if (misprefixed.length > 0) {
    return {
      valid: false,
      errors: misprefixed.map(({ key, groupKey }) => ({
        path: "/featureGroups",
        message: `feature \`${key}\` sits in group \`${groupKey}\` but is not prefixed \`${groupKey}.\` — a feature pasted into the wrong group validates field by field and reports under a group that does not own it`,
      })),
    };
  }

  return { valid: true, map };
}

/**
 * Validate raw file contents.
 *
 * Unparseable JSON is a validation failure, not a thrown error, for the reason
 * in the header: the gate must be able to say "your map is malformed" without
 * that being indistinguishable from "your map is fine and your change is not".
 */
export function validateText(text: string): Validation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      valid: false,
      errors: [{ path: "", message: `not valid JSON — ${(error as Error).message}` }],
    };
  }
  return validate(parsed);
}
