# @stonedogcode/featuremap

The **feature-map** format: what a repository declares about its own features
and the code paths that implement them, plus a validator that a coverage gate
can call.

A `feature-map.json` answers one question — *which feature owns this file?* — so
a gate can refuse a pull request that touches governed code no feature claims.

```bash
npm install @stonedogcode/featuremap
```

## The format

```json
{
  "product": "example",
  "governedRoots": ["src/"],
  "featureGroups": [
    {
      "key": "BILLING",
      "name": "Billing",
      "features": [
        { "key": "BILLING.INVOICES", "name": "Invoices", "codePaths": ["src/billing/invoice.ts"] }
      ]
    },
    { "key": "SCANNER", "name": "Scanner", "codePaths": ["src/scanner/**"] }
  ]
}
```

A group carries **either** `features` **or** `codePaths` — never both, never
neither.

That union is the format's one real decision, and it exists because both shapes
are already in use and both are right. A repository with fine-grained features
nests them; a repository whose groups *are* its features does not. Requiring two
levels everywhere would force synthetic single-feature wrappers that describe
nothing; requiring one would flatten real granularity and **destroy
information**. So the reader handles one branch, and the schema makes the
ambiguous case unrepresentable.

| field | |
|---|---|
| `product` | free text, for a human reading the file |
| `governedRoots` | what the gate looks at. A changed file outside every root is ignored; inside one it must be claimed |
| `key` | `SCREAMING_SNAKE` for a group, `GROUP.SEGMENT` for a feature |
| `codePaths` | the files this feature owns. At least one — an empty list claims nothing while looking covered |
| `relatedComponents` | documentation only. **Does not claim a file** |

## Usage

```ts
import { validateText, featureKeys, claimedPaths } from "@stonedogcode/featuremap"

const result = validateText(readFileSync("feature-map.json", "utf8"))
if (!result.valid) {
  for (const { path, message } of result.errors) console.error(`${path}: ${message}`)
  process.exit(1)
}
featureKeys(result.map)   // every feature key, sorted, both shapes flattened
claimedPaths(result.map)  // every claimed path, de-duplicated
```

The JSON Schema itself is exported for consumers that are not JavaScript:

```js
import schema from "@stonedogcode/featuremap/schema" with { type: "json" }
```

### CLI

```console
$ npx @stonedogcode/featuremap validate feature-map.json
feature-map.json: valid — 11 group(s), 11 feature(s), 161 claimed path(s), 1 governed root(s)
```

| exit | meaning |
|---|---|
| `0` | valid |
| `1` | read, and **invalid** |
| `2` | could not be read at all |

Three codes, not two. *"There is no feature-map.json"* and *"your
feature-map.json is malformed"* send a person to completely different places,
and a gate that cannot tell them apart reports a missing file as a corrupted
one.

For the same reason `validate` returns a verdict rather than throwing: the gate
must be able to distinguish **this map is malformed** from **this map is fine
and your change left a file unclaimed**. Both are a red check; only one means
the pull request did anything wrong.

## Two rules live in code, not in the schema

JSON Schema cannot express either, and both are reported as ordinary validation
errors so no caller can forget them:

- **Keys are unique** across groups and features. A key is an identity — it
  names a diagram file and a row of gate output — so two things sharing one
  silently overwrite each other.
- **A feature key is prefixed by its group.** `BILLING.INVOICES` must sit in
  `BILLING`. This catches a feature pasted into the wrong group, which is
  otherwise completely silent: every field is well-formed and the feature simply
  reports under a group that does not own it.

## The format was measured, not designed

Every rule here was checked against the three maps already in this fleet before
it was written down — 28 groups and 133 features in one, 11 and 4 in the others.
`SCREAMING_SNAKE` keys, the dotted feature form, and the group/feature union are
all what those files already do. A schema that invents a convention invalidates
its entire corpus on first run and calls that a finding.

Two fields are deliberately **not** in the format:

- **A top-level `features` index.** One map carried a flat list of all 133 keys
  beside the nested groups that already implied it, and the two were provably
  identical. A hand-maintained copy of a derived value drifts the first time
  somebody updates one of them, and because the copy still looks complete,
  nothing reports it. Call `featureKeys()` instead.
- **Governed roots in the workflow.** One repository kept them as a JavaScript
  constant inside its gate, which made the setting that decides what the gate
  even looks at invisible to the map and unreadable by a shared action. A gate
  whose scope lives in its own implementation cannot be extracted.

## Development

```bash
npm install
npm test              # unit
npm run test:integration
npm run type-check
npm run lint
```

The integration tier validates the **real** maps on a workstation that has them
checked out, and skips where they are absent — but it always prints how many it
examined, because `0 examined` and `3 passed` must never look alike.

There is no end-to-end tier: this package has no running surface to drive. See
NEH-1227 for the viewer, which will have one.

## Licence

Apache-2.0. See `LICENSE` and `NOTICE`.
