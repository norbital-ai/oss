# Norbital Convert

Markdown or HTML to **pdf, docx, pptx, odt, epub or html** over HTTP, and any supported file to **clean HTML or typed
JSON plus its images** (ingest). One Docker image: pandoc writes every format,
Typst typesets the PDFs, and a Node server puts API keys and a durable job queue in front. Effect Schema validates
queued conversion requests before the converter runs. Bolt's `ctx.convert.document` makes the one-call request and resumes a dropped stream
(`documentConverter` in `@norbital-ai/bolt/engine`).

```bash
docker run -d -p 8090:8080 -e CONVERT_API_KEYS=my-key -v convert-data:/var/lib/convert ghcr.io/norbital-ai/convert
```

## API

Every route except `/healthz` takes `Authorization: Bearer <key>`. A key sees only the jobs it submitted.

**One call.** `POST /v1/convert` queues the job and answers with a Server-Sent Events stream: `event: job` on every
state change (`queued` → `running` → `succeeded` | `failed`), then `event: result` with `{ mime, to, bytes }` (base64)
once it succeeds. To the caller a conversion is one awaited request; the work still runs on the queue, so whichever
replica is free converts it. If the stream drops, the job carries on: resume with `GET /v1/jobs/:id/events?result`
(the id is in the first event).

| Route                     |                                                                                                      |
| ------------------------- | ---------------------------------------------------------------------------------------------------- |
| `POST /v1/convert`        | `{ from: 'markdown' \| 'html', to, source, page?, landscape?, reference? }` → the event stream above |
| `POST /v1/jobs`           | the same body → `202` job, for callers that watch or fetch later                                     |
| `GET /v1/jobs/:id`        | the job: `{ id, state, to, error, created, updated }`                                                |
| `GET /v1/jobs/:id/events` | the job's events, closed once it settles; `?result` streams the result too                           |
| `GET /v1/jobs/:id/result` | the converted bytes (`409` until it succeeded)                                                       |
| `GET /healthz`            | `{ ok, queued, running }`; `503` while the replica drains                                            |
| `POST /v1/ingest`         | `{ name, mime, bytes, options? }` (base64) → the event stream; `event: result` is the ingest below  |

`POST /v1/jobs` also takes `{ op: 'ingest', name, mime, bytes }` (`202`; the result route answers the ingest as JSON).

## Ingest

The `event: result` of an ingest (and `GET /v1/jobs/:id/result`) is one of two shapes, by input type, each with the
job's own `meta` beside the parse:

```ts
type Image = { name: string; mime: string; bytes: string }; // base64; `name` is what the html or json references
type Meta = {
	usage?: { calls: string[]; model: string; input: number; output: number; cost: number }; // audio only
	stats: { pages: number | null; bytes: number; cpuMs: number; wallMs: number }; // pages: PDF pages, slides or sheets
};
type Ingest =
	| { kind: 'document'; html: string; images: Image[]; meta: Meta } // pdf doc docx ppt pptx odt odp rtf html txt md, images, audio
	| { kind: 'data'; json: unknown; images: Image[]; meta: Meta }; // xlsx xls ods csv tsv json
```

**Documents.** The HTML holds only `h1-6 p ul ol li table thead tbody tr th td(colspan rowspan) pre code br strong em
time img(src alt) section(data-page|data-slide|data-speaker data-start data-end)`, one block element per line: a leaf on
one line, a container (`table`, `section`, a cell holding more than one paragraph) from its opening line to its closing
one. A PDF page or a slide is a `<section data-page="n">` / `<section data-slide="n">`; outline and tables are the
HTML's own headings and tables.

**Data.** A spreadsheet is `json: { sheets: [{ name, columns, rows, merges?, images? }] }`. `rows` are the cells,
row-major, each `string`, `number`, `boolean` or `null` (empty): numbers stay numbers, a date or time is ISO
(`2026-10-30`, `2026-01-02T13:45:00`, `13:45:00`), a formula is its cached value (none cached: `null`). `columns` are
the first row's names when that row is distinct text, no merge touches it and another row follows (it then leaves
`rows`), else `A`, `B`, …. `merges` are `{ row, col, rows, cols }` and `images` `{ name, row, col }` (a picture drawn on
the sheet, at its top-left anchor cell; xlsx drawings, ods pictures anchored to a cell), both indexed into `rows`. A csv
or tsv is one sheet named after the file, its delimiter sniffed (comma, semicolon, tab or pipe), quoted fields kept, its
values typed from their text (`007` stays text). An xls comes through Kreuzberg as text: typed the same way, a date stays
the text it shows. A `.json` file is its parsed value, as is.

| Format                       | Reader                                                                                    |
| ---------------------------- | ----------------------------------------------------------------------------------------- |
| docx pptx odt odp            | their XML: merged cells (`colspan`, `rowspan`) and nested tables kept; slides as `<section>` |
| xlsx ods · xls · csv tsv · json | their XML · Kreuzberg's grids · the text · `JSON.parse` → `json`                       |
| pdf                          | pdf.js alone (below)                                                                      |
| doc ppt rtf                  | Kreuzberg's structured result                                                             |
| html                         | parse5, then only the allowed elements; `data:` images become image files, remote ones go |
| txt md · png jpeg gif webp   | `<pre>` · one `<img>`                                                                     |
| mp3 m4a wav ogg opus flac aac webm, mp4 (its audio track) | the transcription model (below); `503` when none is configured |
| CAD, any other video container (mov, mkv), anything else | `415` `{ error: 'unsupported', message: 'no parser: build a tool for it with your workspace tools' }` |

**PDF** is read from its own structure by one reader, pdf.js 6.4.299 (Apache-2.0): never pixels, never a model, never
OCR. Each page is read as shown (its `/Rotate` and every matrix applied): positioned text runs, vector paths and painted
pictures. Ruled tables: the page's horizontal and vertical rules (strokes and thin filled bars), joined where collinear,
make a grid per connected set; a missing inner rule merges cells (`colspan`, `rowspan`), a grid inside another's cell
nests there, and a grid ending a page continues the one opening the next page with the same columns. A grid with a word
across a rule, a merge that is not a rectangle or mostly empty cells is no table. Unruled tables: ≥ 3 consecutive lines
whose em-wide gaps line up into ≥ 2 columns of short cells, every line in a column, with no vertical rule between them;
prose in columns, CJK lines and a chart's axis labels stay paragraphs. Every other word is text: lines cut at gutters are
read in order by recursive cuts (two prose columns one after the other; label and value pairs stay on their line), then
run into headings (a short block set larger than the body, its level the rank of its size, or all bold over plainer
text), list items (a bullet or number, then its hanging indent) and paragraphs (while the leading, size, weight and left
edge hold), bold and italic kept inline. Every word of the text layer lands exactly once (an invisible OCR layer, render
mode 3, is text like any other). Pictures stand in reading order, turned as the page shows them: an upright JPEG is
returned as stored, any other picture as a PNG of its pixels (a scanned page is its picture, upright).

**Audio and video** are transcribed: ffmpeg normalises the audio track to mono 16 kHz 32 kbps mp3, and an audio-input chat model
(`CONVERT_TRANSCRIBE_MODEL` at `CONVERT_AI_BASE_URL`'s chat completions, JSON-schema answers) hears it in 300 s chunks
overlapping by 15 s; the speakers heard so far go into each chunk's prompt so labels carry, overlaps are merged once, and
a 429 or 5xx is retried twice. A container (mp4, m4a, webm, ogg or an `audio/*` type) is read from its audio track; a
video's picture is ignored. `options` is `{ diarize?, language?, speakers?, prompt? }`. The `html` is one
`<section data-speaker="S1" data-start="12.3" data-end="15"><time>00:00:12</time> text</section>` per segment (seconds,
one decimal); the model's usage, summed over the chunks as the provider reports it, is `meta.usage`.

**No OCR.** Kreuzberg (the published `@kreuzberg/node` 4.10.2, MIT) reads only doc, xls, ppt and rtf. Its prebuilt
binding has Tesseract and PaddleOCR compiled in; Kreuzberg runs them only when a call sets `ocr`, `forceOcr` or
`forceOcrPages`, and no call here sets any of them (`tests/ingest.test.ts` spies on every call's config). No OCR language
data or model of any kind is in the image.

`page` (`A4`, `A3`, `Letter`) and `landscape` are a PDF's. `reference` is base64 of a docx, pptx or odt whose styles,
headers and footers the output takes (pandoc's `--reference-doc`); a docx without one is A4 portrait with the PDF's
margins. HTML is read for its structure; CSS does not carry.

`src/convert.lua` runs on every conversion: Chinese falls back to Noto Sans CJK SC (the image's one CJK family) in a PDF,
a long table breaks across pages, a long identifier or timestamp in a table cell wraps inside its column, a table cell starting `- `, `+ `, `1. `, `= ` or `/ ` stays text, and a data-URI image
is not its own description in a docx, pptx or odt.

```bash
curl -N -H 'authorization: Bearer my-key' -H 'content-type: application/json' \
  -d '{"from":"markdown","to":"pdf","source":"# Hello"}' localhost:8090/v1/convert
```

## Configuration

| Variable              | Default            |                                                               |
| --------------------- | ------------------ | ------------------------------------------------------------- |
| `CONVERT_API_KEYS`    | required           | comma-separated keys; the server refuses to start without one |
| `CONVERT_CONCURRENCY` | CPU count          | conversions one replica runs at once                          |
| `CONVERT_MAX_QUEUED`  | 1000               | queued jobs before `429`                                      |
| `CONVERT_MAX_BYTES`   | 20 MiB             | request body limit (`413`)                                    |
| `CONVERT_INGEST_MAX_BYTES` | 200 MiB       | an ingest's request body limit (`413`)                        |
| `CONVERT_KREUZBERG_LANES` | 2              | Kreuzberg reads (doc xls ppt rtf) at once on a replica        |
| `CONVERT_TIMEOUT_S`   | 60                 | one conversion's wall; the job fails past it                  |
| `CONVERT_PANDOC_HEAP` | 512m               | pandoc's heap ceiling (`+RTS -M`)                             |
| `CONVERT_RETAIN_S`    | 3600               | how long a settled job and its bytes are kept                 |
| `CONVERT_AI_BASE_URL` | https://openrouter.ai/api/v1 | the transcription model's OpenAI-compatible API     |
| `CONVERT_AI_API_KEY`  | none               | its key; without it (or the model) audio is `503`             |
| `CONVERT_TRANSCRIBE_MODEL` | none          | an audio-input chat model, e.g. `google/gemini-3.8-flash`     |
| `CONVERT_DATA`        | `/var/lib/convert` | where the queue (`jobs.db`) lives                             |
| `PORT`                | 8080               |                                                               |

## Scaling and durability

Jobs live in one SQLite file (WAL) on the data volume. Every replica mounting it serves every route and pulls the oldest
queued job when it has a free slot, so work spreads across replicas whichever one took the request; put any load balancer
(or Docker's service DNS) in front. A claim is a lease the replica renews every 5 s: a replica that dies has its jobs
queued again within 15 s (three strikes and the job fails). `SIGTERM` stops claiming and finishes what is running.
`compose.yml` runs two replicas: `docker compose up -d --scale convert=4`.

The queue is one host's: SQLite's WAL needs the replicas on one kernel. Across hosts, run one stack per host behind a
load balancer that keeps a job's calls on the host that took it, or move the queue to Postgres.

pandoc runs with `--sandbox` (it reads only the files on its command line: no local files, no fetched resources), a
heap ceiling and a hard timeout, as an unprivileged user.

## Development

```bash
pnpm install --ignore-workspace --frozen-lockfile
pnpm test                                       # pandoc cases run where pandoc is on PATH
docker build --target test -t convert-test .
docker run --rm convert-test                     # all cases run with pandoc and Typst
```

pandoc is GPL-2.0-or-later, Typst Apache-2.0, ffmpeg LGPL/GPL (Ubuntu build), Kreuzberg MIT, parse5 MIT, pdf.js Apache-2.0; this server is
AGPL-3.0.
