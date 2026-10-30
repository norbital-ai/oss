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

## Agent ingest

The agent reads every document through one path (plan 12): `ingest { id }` sends the stored file to the host's ingest
port, which answers one of two kinds. A `document` (pdf, office, html, text, images, audio) is sanitised HTML (one block
element per line; tables keep `colspan`, `rowspan` and nesting; `<section data-page|data-slide>` per page or slide) plus
its images. `data` (xlsx, xls, ods, csv, tsv, json) is its typed cells, `{ sheets: [{ name, columns, rows, merges?,
images? }] }` (a `.json` file: its own parsed value), plus its images. Parsing only, never OCR: a scan is its page images.
Images and plain text are ingested in the engine as themselves; audio goes to the same port, whose diarised transcript is
one `<section data-speaker data-start data-end><time>…</time> …</section>` per segment. A format with no parser (video,
CAD) is refused at once. The engine derives a document's index (lines, page and slide counts, the outline with line
ranges — headings, then page, slide and speaker sections —, table count, image names) and a recording's transcript
(speakers, segments, `durationMs` from the last end) from the HTML.

- **Port.** `HostPorts.agent.ingest` (`IngestPort['ingest']`, HOST_API 16): `(file, options, signal)` answering
  `Promise<Ingested | { unsupported }>` for `file: { sha256, name, mime, bytes }` and audio's
  `options: { diarize?, language?, speakers?, prompt? }`, decoded once on the engine side (`Convert.ingest`).
  `Ingested` is `{ kind: 'document', html, images, meta } | { kind: 'data', json, images, meta }`; `meta.stats` is the
  conversion's compute (`pages`, `bytes`, `cpuMs`, `wallMs`) and audio's `meta.usage` its model calls (`calls`, `model`,
  `input`, `output`, `cost`): the agent records it as an `ai.call` observation and the host bills each call id once.
  `documentIngester({ url, key })` implements it over Norbital Convert's `POST /v1/ingest` (SSE job events, then the
  result; a cut stream resumes from `/v1/jobs/<id>/events?result`; a 415 is `{ unsupported }`; a 503, a converter with
  no transcription model, is `unavailable`). Without the port, `ingest` answers that the host cannot ingest files; there
  is no fallback reader.
- **Workspace code.** `ctx.convert.ingest(file, options?)` reads through the same port and answers
  `{ kind: 'document', html, index, transcript? }` or `{ kind: 'data', json }`; `options.for` also stores the images,
  answered as `images` (FileRefs). A format with no parser fails `unsupported`; a host without the port, `Unavailable`.
- **Job.** `ingest` always answers at once with `{ job, output }`. The job outlives the turn. When it ends, a
  `[job j done] …` message opens the conversation's next step, once: a document's counts and outline map (a recording
  also names its `transcript.json` for run_js), a data ingest's sheets with their row counts and its `data.json` id for
  run_js. If the turn has ended, the message is queued and wakes the conversation (an ordinary, billed turn). Every job
  kind (long host calls too) announces itself the same way; `wait` stays for collecting one now.
- **Outputs and cache.** Each ingest is one entry in `sys_conversation.outputs` (`name: "tender.pdf (ingested)"`, the
  HTML as its file, `files` holding the HTML, `images/…`, a recording's `transcript.json` and the engine's `index.json`;
  a data ingest is `"rates.xlsx (data)"` with `data.json` as its file and no HTML; `ingest: { output, source, sha256,
job, status }`). The stored files are named `ingest/<sha256>/…` and shared: the same bytes are converted once for
  every conversation.
- **Reading.** `read_file { output, from?, to? }` answers numbered HTML lines (about 64 KB, never cutting a table or
  section) with the images those lines reference shown to the model (at most 8) and where to read on;
  `{ output, text }` the lines holding a text (`{ from, to, text }`, a hit in a table naming the whole table);
  `{ output, image: n }` one image. A window read twice in a turn answers "already above". A data ingest has no lines:
  `{ output }` answers each sheet's name, columns, row count, first five rows and image anchors and points at run_js
  over `data.json`; `{ output, text }` is refused; `{ output, image: n }` reads its images.
- **Metering.** Each conversion writes an `ingest.convert` log event (`kind`, pages, bytes, cpuMs, wallMs, `cached`)
  with the conversation and turn; a cache hit records `cached: true` and no compute. A transcription writes an `ai.call`
  observation from the ingest's `meta.usage`.
