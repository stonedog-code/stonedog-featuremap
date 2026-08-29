/**
 * Copyright (C) 2026 StoneDogCode L.L.C.
 *
 * The feature-map format: its schema, its types, and the derivations that
 * replace the fields the schema deliberately does not store.
 */

export { validate, validateText, schema, type Validation, type ValidationError } from "./validate.js";
export { features, featureKeys, claimedPaths, duplicateKeys, misprefixedFeatureKeys } from "./derive.js";
export { isLeafGroup, type FeatureMap, type FeatureGroup, type Feature, type LeafGroup, type NestedGroup, type PathGlob } from "./types.js";
