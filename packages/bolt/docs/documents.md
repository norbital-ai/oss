# Documents

Declare conversion targets in `+workspace.ts`: `convert: { to: ['pdf', 'docx'] }`. Supported targets
are `pdf`, `docx`, `pptx`, `odt`, `epub` and `html`. Sources are `{ markdown }` or `{ html }`.
The host confirms available targets at startup; an unsupported declared target produces a check
warning and an `Unavailable` failure when used.

| Caller     | Form                                                                                         | When                                                   |
| ---------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Page       | `await bolt.convert({ html }, { to: 'pdf', name: 'Quote.pdf' })`                             | immediately, returning a viewer-owned short-lived file |
| Notice     | `attachments: [{ document: { html }, to: 'pdf', name: 'Invoice.pdf' }]`                      | after commit, retried with delivery                    |
| File sync  | `write` returns `{ document: { html }, name: 'Quote.pdf' }`                                  | when a member exports                                  |
| Automation | `yield* ctx.convert.document({ html }, { to: 'pdf', name: 'Quote.pdf', for: 'make_quote' })` | inside the run                                         |

```ts
syncs: {
  document: {
    with: 'file', parser: [],
    context: { title: { kind: 'text' }, markdown: { kind: 'text' } },
    write: function* ({ context }) {
      return { document: { markdown: context.markdown }, name: `${context.title}.pdf` };
    }
  }
}
```

This example converts content already supplied by the caller. Export offers each declared
target; an empty parser list makes this export-only. A file callback's reads retain the
exporter's authority and outputs. Context is input, never authority; a supplied
record id does not bypass its read scope. Remote syncs remain trusted workspace reads.
Page conversion only converts content the caller already has and is rate limited by the
policy's `convert` limit (default `30/min`). Download the returned reference with `bolt.fileUrl(ref)`.
