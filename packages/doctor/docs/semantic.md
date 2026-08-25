# The semantic tier

The semantic pass gives the doctor a second way to see code. Where the syntactic and graph tiers
answer "what does this text say" and "what reaches what", the semantic tier answers "what is this
file *for*" — by embedding one vector per source file and comparing those vectors.

## Indexing

- **Granularity**: one embedding per file, never per symbol or per chunk. A file is the unit a
  person moves, deletes, or rewrites; it is therefore the unit whose responsibility can overlap
  with another's.
- **Incremental refresh by Merkle tree**: leaf = sha256 of file bytes; directory nodes hash their
  sorted children. The persisted tree is diffed against the current one and recursion prunes on
  equal subtrees, so an untouched directory costs nothing — not even a read of its vectors.
- **Identity**: provider, model, width, query instruction, and index schema fold into one
  embedder id recorded in the receipt. A changed id invalidates every stored vector at once,
  because vectors from two identities are not two vintages of one number, they are different
  numbers wearing the same shape.
- **Storage**: `.norbital/diagnosis/index/` holds `manifest.json` (commit marker, renamed last),
  `entries.jsonl` (path → content hash → offset/length), `vectors.bin` (little-endian float32).
  Corruption throws; it is never silently treated as absence.
- **Long files** embed a deterministic skeleton: comments stripped, blank runs collapsed,
  declaration headers kept with bounded bodies, capped well under the model's window. Same bytes
  in, same skeleton out.

## Providers

`openrouter` ships today, defaulting to `qwen/qwen3-embedding-8b` (4096 dimensions). Queries are
prefixed with a frozen instruction so retrieval-tuned behaviour applies on the query side only;
the instruction is part of the embedder id. The registry anticipates further names; an inline
function covers any endpoint that speaks neither.

Credentials are referenced by environment-variable **name** in configuration and resolved from
the invoking environment. A missing credential is exit-2 evidence naming the variable — the same
three-valued contract as every other failure.

## Analysis

1. **Clustering.** Vectors are L2-normalised; each file links to up to 10 neighbours above cosine
   0.85; union-find turns links into clusters. Labels are the most frequent identifier words
   among members — navigation aids, not claims.
2. **Ownership spread (`SEM_SPREAD`).** A cluster whose members answer to two or more packages
   nominates each outlying member: one responsibility apparently living across boundaries.
3. **Cross-package twins (`SEM_TWIN`).** Two files in different packages at cosine ≥ 0.93
   nominate once per pair. Structural duplicates within a package remain D1's territory.
4. **Pseudocode rules.** Each YAML rule's `pseudocode` half embeds as a query against committed
   vectors; files at or above the rule's threshold fire that rule at `file:1`, evidence
   `semantic=<similarity>`.

All semantic findings are `hint` severity with `medium` confidence unless a rule states
otherwise: they nominate for review and never fail a gate. Deterministic evidence keeps the exit
code.

## Spend

Every run reports `IndexRunStats`: files total / embedded / reused / deleted, API requests
(including retries), tokens when the provider reports them, cost when it reports one, wall time.
The numbers appear in the CLI summary, in `AuditResult.semantic`, and verbatim in the receipt's
`indexing` block, which the consolidated analyzer authenticates field by field. An analysis tier
that calls a paid API owes its reader the bill.

## Receipt fields

Receipt schema 6 adds:

| Field | Meaning |
| --- | --- |
| `tiers.semantic` | `false` only when the tier was explicitly declined |
| `embedderId` | identity of what produced these vectors |
| `indexDigest` | committed Merkle root — which vectors answered |
| `indexing` | the spend block |

The analyzer rejects partial presence of the three semantic fields, a claimed-but-unbilled tier,
and malformed counters: half-written evidence must never authenticate.
