# Norbital Convert

Markdown or HTML to **pdf, docx, pptx, odt, epub or html** over HTTP. One Docker image: pandoc writes every format,
Typst typesets the PDFs, and a zero-dependency Node server puts API keys and a durable job queue in front. Bolt's
`ctx.convert.document` talks to it (`documentConverter` in `@norbital-ai/bolt`).

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

| Route | |
|---|---|
| `POST /v1/convert` | `{ from: 'markdown' \| 'html', to, source, page?, landscape?, reference? }` → the event stream above |
| `POST /v1/jobs` | the same body → `202` job, for callers that watch or fetch later |
| `GET /v1/jobs/:id` | the job: `{ id, state, to, error, created, updated }` |
| `GET /v1/jobs/:id/events` | the job's events, closed once it settles; `?result` streams the result too |
| `GET /v1/jobs/:id/result` | the converted bytes (`409` until it succeeded) |
| `GET /healthz` | `{ ok, queued, running }`; `503` while the replica drains |

`page` (`A4`, `A3`, `Letter`) and `landscape` are a PDF's. `reference` is base64 of a docx, pptx or odt whose styles,
headers and footers the output takes (pandoc's `--reference-doc`). HTML is read for its structure; CSS does not carry.

```bash
curl -N -H 'authorization: Bearer my-key' -H 'content-type: application/json' \
  -d '{"from":"markdown","to":"pdf","source":"# Hello"}' localhost:8090/v1/convert
```

Bolt's `ctx.convert.document` is this call (`documentConverter` in `@norbital-ai/bolt`), resuming a dropped stream.

## Configuration

| Variable | Default | |
|---|---|---|
| `CONVERT_API_KEYS` | required | comma-separated keys; the server refuses to start without one |
| `CONVERT_CONCURRENCY` | CPU count | conversions one replica runs at once |
| `CONVERT_MAX_QUEUED` | 1000 | queued jobs before `429` |
| `CONVERT_MAX_BYTES` | 20 MiB | request body limit (`413`) |
| `CONVERT_TIMEOUT_S` | 60 | one conversion's wall; the job fails past it |
| `CONVERT_PANDOC_HEAP` | 512m | pandoc's heap ceiling (`+RTS -M`) |
| `CONVERT_RETAIN_S` | 3600 | how long a settled job and its bytes are kept |
| `CONVERT_DATA` | `/var/lib/convert` | where the queue (`jobs.db`) lives |
| `PORT` | 8080 | |

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
node --test tests/*.test.ts                       # the pandoc test runs where pandoc is on PATH
docker build -t convert . && docker run --rm --entrypoint node convert --test tests/service.test.ts
```

pandoc is GPL-2.0-or-later, Typst Apache-2.0; this server is AGPL-3.0.
