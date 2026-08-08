# @norbital-ai/platform-utils

## 1.0.0

### Patch Changes

- c0991df: Allow server-side authoring AI calls to send explicitly selected workspace image assets and receive schema-validated structured output. Image bytes remain binary across the host boundary, image access is checked through `document_asset`, and transactional hook capability restrictions are unchanged.
- af71711: Add pgvector support: bootstrap the `vector` extension, a single `vector()` column builder, HNSW/IVFFlat indexes, and server-only `findNearest` / `withinDistance` (cosine, L2, IP). One embedding path for PDQ-as-binary-vector, Gemini omni embeddings, and a future per-record system column.
  - @norbital-ai/std@1.0.0

## 4.0.1

### Patch Changes

- Updated dependencies [9594db9]
  - @norbital-ai/std@4.0.1

## 4.0.0

### Patch Changes

- Updated dependencies [fd8435e]
- Updated dependencies [fd8435e]
  - @norbital-ai/std@4.0.0

## 3.0.0

### Patch Changes

- d864ec2: Stop record titles collapsing into raw uuids when a label field is a date, a number or empty.

  `recordLabel: [a, b]` compiles to the CEL expression `scope.record.a + ' · ' + scope.record.b`. CEL
  has no `+` overload but string+string, so a label naming a `date()` column threw
  `no such overload: string + dyn<google.protobuf.Timestamp>` — and, as it turns out, the same is true
  for numbers, booleans and null. The throw was swallowed by `resolveRecordLabel`, the label resolved
  to `null`, and `resolveRecordDisplayLabel` then fell back to joining _every_ scalar column, which is
  how foreign keys like `employment_id` and `leave_type_id` ended up rendered as record panel titles.
  Eight collections in the hr-payroll template alone were affected.

  Wrapping the terms in `string(...)` does not fix it: this CEL environment has no `string()` overload
  for a timestamp or for null either, so the expression still throws. Coercion has to happen where the
  values are ordinary JavaScript, so `resolveRecordLabel` now evaluates the compiled chain term by
  term, renders each in JS, and joins the ones that produced something. A null or blank field costs its
  own term instead of the entire title, and dates render as a locale-independent `2026-08-05` (labels
  are also built server-side, for approval requests and audit subjects, where there is no viewer whose
  locale could be consulted). `modelTableMeta` is deliberately unchanged: the emitted expression is part
  of the manifest and feeds the schema fingerprint, and rewriting it would churn migrations across every
  template without fixing anything the evaluator has not already fixed.

  The fallback can no longer emit an identifier at all. A value shaped like a uuid is skipped wherever
  it appears — the honest test is whether the value is opaque, not whether the column is named like an
  id — and a record with nothing readable left is now `Untitled roster entries` rather than its primary
  key. A label naming a `custom()` JSONB column still cannot be built, because an object is not a title
  however it is coerced; it now degrades to that placeholder instead of falling through to the
  every-scalar scan, and the blob is never printed as the name whether it arrives as an object or as
  its own serialization after a JSONB round trip.

- Updated dependencies [d864ec2]
  - @norbital-ai/std@3.0.0

## 2.0.0

### Patch Changes

- @norbital-ai/std@2.0.0

## 1.0.2

### Patch Changes

- @norbital-ai/std@1.0.2

## 1.0.1

### Patch Changes

- @norbital-ai/std@1.0.1

## 1.0.0

### Patch Changes

- @norbital-ai/std@1.0.0

## 0.0.1

### Patch Changes

- Shared manifests, wire contracts, migrations, and tenant database utilities for Norbital.
