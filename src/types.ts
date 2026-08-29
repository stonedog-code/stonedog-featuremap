/**
 * Copyright (C) 2026 StoneDogCode L.L.C.
 *
 * The shape of a `feature-map.json`, in TypeScript.
 *
 * These types mirror `schema/feature-map.schema.json` and the schema is the
 * authority -- a type can express "string" where the schema also demands a
 * pattern, so passing the type checker is never proof a map is valid. Callers
 * validate; the types are for writing the code that runs afterwards.
 */

/** A repository-relative path or glob. */
export type PathGlob = string;

/**
 * A group that owns code paths directly, because this repository does not need
 * the inner level. Its groups ARE its features.
 */
export interface LeafGroup {
  key: string;
  name: string;
  codePaths: PathGlob[];
  features?: never;
}

/** A group that nests features, each owning its own code paths. */
export interface NestedGroup {
  key: string;
  name: string;
  features: Feature[];
  codePaths?: never;
}

/**
 * A group is one or the other, never both.
 *
 * The `?: never` members are what make that a compile-time fact rather than a
 * comment: a literal carrying both fails to narrow, so the union is checked at
 * every construction site and not only by the validator at run time.
 */
export type FeatureGroup = LeafGroup | NestedGroup;

export interface Feature {
  key: string;
  name: string;
  codePaths: PathGlob[];
  /** Documentation only. The gate does not treat these as claimed files. */
  relatedComponents?: string[];
}

export interface FeatureMap {
  product: string;
  governedRoots: PathGlob[];
  featureGroups: FeatureGroup[];
}

/** Does this group carry its own code paths rather than nested features? */
export function isLeafGroup(group: FeatureGroup): group is LeafGroup {
  return Array.isArray((group as LeafGroup).codePaths);
}
