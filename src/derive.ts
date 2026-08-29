/**
 * Copyright (C) 2026 StoneDogCode L.L.C.
 *
 * Everything the map used to state twice.
 *
 * hopperguard's map carried a top-level `features` array beside the nested
 * groups that already implied it -- 133 keys in both places, provably identical
 * (`([.featureGroups[].features[].key]|sort) == (.features|sort)` was `true`
 * when measured). The schema drops it, and these functions are what replaces
 * it.
 *
 * A derived value cannot drift from its source. A hand-maintained copy of a
 * derived value drifts the first time somebody adds a feature and updates one
 * of the two lists -- and because the copy still looks complete, nothing
 * reports it. That is the whole argument for computing rather than storing, and
 * it is worth the three functions below.
 */

import { isLeafGroup, type Feature, type FeatureGroup, type FeatureMap, type PathGlob } from "./types.js";

/**
 * Every feature in the map, flattened, with the group it came from.
 *
 * A leaf group yields ITSELF as a feature. That is not a convenience: its
 * groups genuinely are its features, so a caller counting features across the
 * fleet must count them, or a repository that chose the flat shape reports zero
 * features while plainly having some.
 */
export function features(map: FeatureMap): Array<Feature & { groupKey: string }> {
  return map.featureGroups.flatMap((group: FeatureGroup) =>
    isLeafGroup(group)
      ? [{ key: group.key, name: group.name, codePaths: group.codePaths, groupKey: group.key }]
      : group.features.map((feature) => ({ ...feature, groupKey: group.key })),
  );
}

/**
 * Every feature key, sorted.
 *
 * Sorted because this is what the removed top-level array held, and the two
 * were compared as sorted sets. A caller diffing this against an old map's
 * `features` should get equality, not an ordering difference.
 */
export function featureKeys(map: FeatureMap): string[] {
  return features(map)
    .map((feature) => feature.key)
    .sort();
}

/**
 * Every code path claimed by anything in the map, de-duplicated and sorted.
 *
 * `relatedComponents` is deliberately NOT included. It documents what a feature
 * touches without owning, and folding it in here would let a file be "claimed"
 * by a feature that does not implement it -- which is precisely the coverage
 * the gate exists to refuse.
 */
export function claimedPaths(map: FeatureMap): PathGlob[] {
  return [...new Set(features(map).flatMap((feature) => feature.codePaths))].sort();
}

/**
 * Keys that appear more than once, sorted.
 *
 * Empty means every key is unique. The schema cannot express this: JSON Schema
 * has `uniqueItems` for values in one array, and nothing for "unique across a
 * union of two nesting levels". So it is checked here and asserted by the
 * validator's caller rather than silently permitted.
 *
 * It matters because a key is an identity -- it names a diagram file and a row
 * in gate output. Two features sharing one means the second silently overwrites
 * the first wherever the key is used as an index.
 */
export function duplicateKeys(map: FeatureMap): string[] {
  const seen = new Map<string, number>();
  for (const key of [...map.featureGroups.map((g) => g.key), ...features(map).map((f) => f.key)]) {
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  // A leaf group is counted twice on purpose above -- once as a group and once
  // as the feature it also is -- so its own key is expected at 2, not 1.
  const leafKeys = new Set(map.featureGroups.filter(isLeafGroup).map((g) => g.key));
  return [...seen.entries()]
    .filter(([key, count]) => count > (leafKeys.has(key) ? 2 : 1))
    .map(([key]) => key)
    .sort();
}

/**
 * Feature keys whose prefix does not name the group they sit in.
 *
 * Measured before it was required: all 133 of hopperguard's feature keys are
 * exactly `<groupKey>.<segment>`, so this is the corpus's own rule rather than
 * one imposed on it.
 *
 * JSON Schema cannot express it -- there is no way to compare a value against
 * its parent's -- so the schema checks only the dotted SHAPE and this checks
 * the relationship. It is worth checking because of what it catches: a feature
 * copied into the wrong group keeps working, keeps validating, and reports
 * under a group that does not own it. Nothing else in the pipeline would ever
 * notice, because every individual field is well-formed.
 *
 * Leaf groups have no inner features and cannot violate this.
 */
export function misprefixedFeatureKeys(map: FeatureMap): Array<{ key: string; groupKey: string }> {
  return map.featureGroups.flatMap((group) =>
    isLeafGroup(group)
      ? []
      : group.features
          .filter((feature) => !feature.key.startsWith(`${group.key}.`))
          .map((feature) => ({ key: feature.key, groupKey: group.key })),
  );
}
