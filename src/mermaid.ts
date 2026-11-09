/**
 * Copyright (C) 2026 StoneDogCode L.L.C.
 *
 * The `.mer` view of a feature map: one Mermaid diagram per feature.
 *
 * ## The diagram is a VIEW, never the source
 *
 * `feature-map.json` stays in the product repository and stays what the gate
 * reads. Mermaid cannot express a `codePaths` glob as anything but a label, so
 * a diagram is a one-way, lossy rendering -- which is why this module only ever
 * goes JSON -> Mermaid and nothing reads a `.mer` back.
 *
 * ## Byte-deterministic, because it is regenerated hourly
 *
 * The content collector rewrites every diagram on every run and commits only
 * what changed. Any instability -- a feature order that depends on object
 * iteration, a timestamp in a header -- would make every run a change and every
 * diff noise, forever. So: features are sorted by key, paths keep the order the
 * map declares them in (that order is the author's, and is stable), nothing
 * time- or environment-dependent is emitted, and every file ends in exactly one
 * newline.
 *
 * ## Metadata lives in leading `%%` comments
 *
 * The convention `diagram-viewer` established and the viewer ports: a comment
 * is ignored by every Mermaid renderer, so the file stays valid Mermaid
 * anywhere while still carrying a title and description for a listing.
 */

import { duplicateKeys, features } from "./derive.js";
import type { FeatureMap } from "./types.js";

export interface MermaidDiagram {
  /** The feature key. Also the file's stem -- the schema guarantees it survives a filename. */
  key: string;
  /** `<key>.mer`. A caller places it under whatever directory names the product. */
  fileName: string;
  /** The whole file, ending in a single newline. */
  text: string;
}

/**
 * Escape text for a Mermaid double-quoted label.
 *
 * Mermaid decodes `#name;` / `#123;` entities inside labels, so a literal `#`
 * is escaped FIRST -- otherwise a path such as `docs/#a;b` would be read as an
 * entity and render as something it is not. Then the quote that would end the
 * label, and the three characters an HTML-rendering label would interpret.
 */
export function escapeLabel(text: string): string {
  return text
    .replace(/#/g, "#35;")
    .replace(/"/g, "#quot;")
    .replace(/&/g, "#amp;")
    .replace(/</g, "#lt;")
    .replace(/>/g, "#gt;");
}

/**
 * A header comment's value on one line.
 *
 * A `%%` comment ends at the newline, so a name containing one would leak its
 * remainder into the diagram body as syntax.
 */
function oneLine(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, " ").trim();
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * Every feature in the map as a Mermaid flowchart, sorted by key.
 *
 * A leaf group is its own feature (see `features()`), so a flat map yields one
 * diagram per group rather than none.
 *
 * Throws when two things share a key. A key names a file here, so a duplicate
 * would silently overwrite one diagram with another -- and the caller would
 * report N diagrams written while holding N-1.
 */
export function toMermaid(map: FeatureMap): MermaidDiagram[] {
  const duplicates = duplicateKeys(map);
  if (duplicates.length > 0) {
    throw new Error(`feature map "${map.product}" has duplicate keys: ${duplicates.join(", ")}`);
  }

  const groupNames = new Map(map.featureGroups.map((group) => [group.key, group.name]));

  return features(map)
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((feature) => {
      const related = feature.relatedComponents ?? [];
      const groupName = groupNames.get(feature.groupKey) ?? feature.groupKey;
      const summary = [plural(feature.codePaths.length, "code path")];
      if (related.length > 0) summary.push(plural(related.length, "related component"));

      const lines = [
        `%% title: ${oneLine(feature.name)}`,
        `%% description: ${oneLine(groupName)} · ${summary.join(" · ")}`,
        `%% generated from feature-map.json by @stonedogcode/featuremap -- edit the map, not this file`,
        "",
        "flowchart LR",
        `    F["<b>${escapeLabel(feature.name)}</b><br/><code>${escapeLabel(feature.key)}</code>"]`,
        ...feature.codePaths.flatMap((path, i) => [`    P${i}["${escapeLabel(path)}"]`, `    F --> P${i}`]),
        ...related.flatMap((path, i) => [`    R${i}["${escapeLabel(path)}"]`, `    F -.->|related| R${i}`]),
      ];

      return { key: feature.key, fileName: `${feature.key}.mer`, text: `${lines.join("\n")}\n` };
    });
}
