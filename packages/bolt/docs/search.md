# Search

A model declares every search mode in one `search` object. `text` names text-box fields;
`semantic` names content the platform embeds and maintains; `indexes` declares custom vectors.

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

Search through `bolt.query('trials', { search: { colour: input }, limit: 20 })`, or the same form
on `ctx.query`. Caller grants and field masks always apply. A probe's `where` narrows inside the
index scan. Dimension is at most 2000; candidates is 1–16 and multiplies the requested page before
pure ascending reranking. The toolbar offers each index as a search mode with its typed input
form, including custom datatype renderers. No wrapper query is needed.
