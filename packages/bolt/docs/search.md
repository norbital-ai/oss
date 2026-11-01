# Search

A model declares every search mode in one `search` object. `text` names text-box fields;
`semantic` names content the platform embeds and maintains; `indexes` declares custom vectors.

The model's [`record_label` CEL](./models.md#one-record-identifier) is materialized and text-indexed
automatically. `search.text` adds fields beyond that identifier. For example, a label
`'PERSON ' + record.code + ' · ' + record.name` matches both its literal prefix and record values,
even without `search.text`. Changing a record updates the stored identifier and index together.

Find and Norbius share manifest-name discovery: type an app, model, automation or other authorized
manifest name directly. Selecting a model scopes the following query to its records; expanding an
app scopes it to pages. Right expands and Left at the start of the query collapses. `/scope query`
is an optional shortcut. The input stays in place and shows its active scope. Record searches run
only inside an explicitly selected model and show the available indexed fields; an unindexed
model says search is unavailable. Find opens records; Norbius may reference a model directly or
optionally drill into its records. Approval requests search their model name and follow the existing target reference to its live
indexed label, under the target’s row/field access rules; no target label is copied onto the request. Users search name/email only as their granted output permits.

```ts
search: {
  text: ['sample_label', 'title'],
  semantic: { fields: ['notes', 'photo'], model: 'default', dim: 1024 },
  indexes: {
    colour: {
      description: 'Nearest measured L*a*b* colour.', dim: 3, metric: 'l2',
      vector: (row) => [row.lab_l.toNumber(), row.lab_a.toNumber(), row.lab_b.toNumber()],
      input: { lab: { kind: 'custom', of: 'lab_probe' } },
      probe: (input) => ({ vector: [input.lab.l, input.lab.a, input.lab.b] }),
      rerank: (input, row) => deltaE2000(input.lab, {
        l: row.lab_l.toNumber(), a: row.lab_a.toNumber(), b: row.lab_b.toNumber()
      }),
      candidates: 4
    }
  }
}
```

The example assumes required decimal lab_l/lab_a/lab_b fields, a `lab_probe` custom field and a
pure colour-distance helper. `vector`, `probe` and optional `rerank` are pure. The engine computes a function vector on every committed
write, stores it in a hidden column and maintains HNSW. Return `null` to exclude a row. For vectors
that need I/O, an automation writes an ordinary vector field and the index uses `vector: 'field'`.

Search through `bolt.query({ trials: { search: { colour: input }, limit: 20 } })`, or the same
request on `ctx.query`; each row carries its `$distance`. The read output and caller grants always apply. A probe's `where` narrows inside the
index scan. Dimension is at most 2000; candidates is 1–16 and multiplies the requested page before
pure ascending reranking. The toolbar offers each index as a search mode with its typed input
form, including custom datatype renderers. No wrapper query is needed.

`record_label` is optional. Without it, an explicit `search.text` index still works; with neither,
record search is unavailable. Manifest discovery does not require a record index.
