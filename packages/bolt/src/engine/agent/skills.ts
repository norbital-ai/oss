// The platform's own skills: how to work with any workspace's records and how to take in unstructured material. Every
// agent has them beside the workspace's skills (a workspace skill of the same name replaces one); the system prompt
// lists them and the `skill` tool reads them, so their text costs nothing until an agent opens it.
import type { SkillSpec } from '../manifest.ts';

const skill = (text: string): SkillSpec => ({ text, digest: '', files: [] });

export const PLATFORM_SKILLS: { readonly [name: string]: SkillSpec } = {
	records: skill(`---
description: Reading and writing a workspace's records - models, layers, filters, batches, links, policies and approvals.
---
## Know the model first
A model is a table: its fields and their kinds, its links (a link field names one row of another model; that model
sees the rows linking to it as a many-relation), the layers its read declares, and the columns each write takes.
Unless this conversation already shows them, describe every model the task needs in one read ({ "<model>": { "describe":
true }, … }) before you first filter or write them: read and act take exactly those names. Its source,
src/data/model/<name>/+model.ts, holds what a description leaves out (callbacks, checks, help).

## Steps
1. Find: one read for everything the request needs; several unrelated models are several roots of one call.
2. Resolve: every record a write references with one bounded read. A missing one is created inline only where the
   write's input declares that nested create, else ask first; an optional link still missing after one exact and one
   focused lookup is left out.
3. Change once: one act carrying the whole change as a batch, related rows inside their root row.
4. Report from the result: a committed write answers its stored rows; read again only for what they lack.
An empty read earns one different key, then a question to the person, never the same read again. When no described
field holds what is asked, say so and offer what the data does hold: never hunt the source or the rows for it.

## Reading
One read names keys: "<model>" is a root, "<root>.<relation>" a layer of related rows nested in each root row (a
one-relation as an object in place of its link, a many-relation as a list). Send a layer beside its root, never alone.
Each key returns the model's declared shape; options only narrow it: fields (only the columns you need), where (a filter
per field, combined with and / or / not), orderBy, limit, search and aggregate; a result too large to show says so:
narrow the read. Root the read at the model
whose rows you want and pick them with its where: a layer's where narrows only each root row's related rows, never which
root rows return, and takes the layer's own fields, never its link. To pick roots by their related rows, the root's
where crosses a declared layer: { "<one>": { "is": { … } } }, { "<many>": { "some": { … } } } or { "<many>": { "count":
{ "gte": 2 } } }; one read with nested crossings replaces a chain of reads by id. "My …" and "due today" need no
lookup: a value may be a variable, a typed CEL expression: { "var": "requestor.id" } (the person you act for),
{ "var": "today - days(7)" }, { "var": "startOfMonth(today)" } or { "var": "now - hours(1)" }. To list rows, read them
with a limit.
Count, total, rank or group with aggregate, never by paging rows or adding them up yourself; what aggregate cannot give
is run_js over the rows. search is only for words the person asked to find: filter by values with where. Several unrelated models are several roots of one call.

## Writing
A write is "<model>.<verb>" with an array of rows, committed together (a large or computed batch is a JSON file run_js
returned, given to act as inputFile):
- create: [{ column, <relation>: [row or existing id] }]
- update: [{ target: id, set: { column, <relation>: { create, update: [{ target, set }], delete, link, unlink } } }]
- delete: [{ target: id }]
- upsert: [{ id?, column, … }] - with an id it updates that row, without one it creates.
Related rows go inside their root row in the same call. A link column takes the linked row's id, found by a read; a
file column takes the file reference { id, name, mime } a message or tool gave. Put every row of one change in one call.

## Policies and approvals
Every call runs with the authority of whom you act for. Their policies (src/access_control/policy/) grant reads (which
rows, by a where, and which fields) and writes (which columns per layer, and a check that allows, denies or routes the
batch to approval). A denial says why: tell the person and do not retry it. A write routed to approval is held until
its approvers approve, reject or request changes: say it awaits approval, not that it is done.

## After a write
A committed write answers its stored rows and the automation runs it started; report from them. Runs finish in the
background: wait on one only when its result is needed now.
`),
	ingest: skill(`---
description: Turning unstructured material - documents, sheets, photos, handwriting, messages - into records faithfully.
---
## Explore first
Inventory every supplied source before mapping any of it: file names and types, sheets, pages, labels, dates, repeats.
Open each in the form that shows its content (a document as a document, a sheet as a sheet, an image or handwriting as
an image). Learn the target models from their +model.ts: required columns, kinds, links and nested layers.

## Map
Build one candidate per target record from the sources, every value traced to where it was read. Cross-check identity
across sources (labels, dates, order); a shared label alone is not identity when there are repeats. Never merge two
items to satisfy a required field. Check numbers, units and dates against the original.

## Resolve
Find every linked record with one bounded read. A missing one is created inline only where the write's input declares
that nested create; otherwise ask before creating it. Never substitute free text for a link or invent an id.

## Write and confirm
Never copy numbers by hand. Anything derived from a source (averages, a curve, a table of rows) is computed in run_js
from the source file itself (files: [{ id }] hands the code its sheets or text as input.files), and returned as a JSON
file of the write's whole input ({ files: [{ name: 'input.json', text }] });
act then takes that file's id as inputFile. One write per record (or one batch for many), its related rows nested. Read back what matters and confirm against the
source. If a value is illegible, ambiguous or absent, ask for it or leave it empty and say so: never invent a
measurement, quantity, name or date.
`),
	research: skill(`---
description: Finding, reading and extracting information and media from the web - search, browse, scrape tables and lists, download files, cite every source.
---
## Find
Search for the question, then open the primary source: the authority, publisher or vendor itself, never an aggregator
when the original exists. A long page narrows to the lines that hold your words (find); a PDF opens as text.

## Extract
Take structured data in one step: evaluate one expression in the page that returns the rows as JSON (a table's cells,
a list's items with their links) instead of reading screen after screen. Follow pagination by its links or URL
pattern until the set is complete. Keep the URL and the exact quoted text of every value you take.

## Media
Download saves an image, video, audio, PDF or CAD file at its own URL as the person's file, loaded by your browser as
the page loads it; a file field takes its reference. For media embedded in a page, find its source URL in the page (a
video or source element's src, og:video or og:image, a download link's href), never the page URL. Segmented streams
(HLS, DASH) and DRM-protected media cannot be saved: say so.

## Compare and write back
Compare what you found with the workspace's records in one read and report each difference with its source. Change
records only as the person or the task asks, citing the source; when sources disagree, say so instead of choosing.
`),
	analysis: skill(`---
description: Analysing workspace data - aggregate reads, computing in run_js, and charts and reports as files.
---
## Get the numbers
A count, total, average or grouping is one read with aggregate (count, sum, avg, min, max, by fields or time buckets):
never page rows to count them. Read rows only for what aggregate cannot give, bounded by fields, where and limit.

## Compute
Anything beyond an aggregate (ratios, shares, percentiles, trends, a join of two reads) is run_js with the read's rows
as its input: return JSON, and check its totals against an aggregate before you report them. A result that becomes a
write is returned as a JSON file and given to act as inputFile, never retyped.

## Charts and reports
A chart is an SVG that run_js returns as a file: return { files: [{ name: 'chart.svg', text: svg }] }. A report is
document (pdf, docx or pptx) whose markdown carries the numbers as tables and the chart inline as its SVG.
A bar chart, to adapt (a line chart draws a polyline through the same points):
\`\`\`js
const bars = (title, labels, values, w = 640, h = 320, pad = 40) => {
  const max = Math.max(...values, 0) || 1, bw = (w - 2 * pad) / values.length;
  const rects = values.map((v, i) => {
    const bh = ((h - 2 * pad) * v) / max, x = pad + i * bw, y = h - pad - bh;
    return \`<rect x="\${x + 4}" y="\${y}" width="\${bw - 8}" height="\${bh}" fill="#4f6bed"/>\` +
      \`<text x="\${x + bw / 2}" y="\${h - pad + 14}" font-size="11" text-anchor="middle">\${labels[i]}</text>\` +
      \`<text x="\${x + bw / 2}" y="\${y - 4}" font-size="11" text-anchor="middle">\${v}</text>\`;
  }).join('');
  return \`<svg xmlns="http://www.w3.org/2000/svg" width="\${w}" height="\${h}" font-family="sans-serif"><text x="\${pad}" y="20" font-size="14">\${title}</text>\${rects}</svg>\`;
};
\`\`\`
Say what the numbers show in a sentence or two; the person reads the chart for the detail.
`)
};
