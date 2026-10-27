// The platform's own skills: how to work with any workspace's records and how to take in unstructured material. Every
// agent has them beside the workspace's skills (a workspace skill of the same name replaces one); the system prompt
// lists them and the `skill` tool reads them, so their text costs nothing until an agent opens it.
import type { SkillSpec } from '../manifest.ts';

const skill = (text: string): SkillSpec => ({ text, digest: '', files: [] });

export const PLATFORM_SKILLS: { readonly [name: string]: SkillSpec } = {
	records: skill(`---
description: Reading and writing a workspace's records - models, layers, filters, batches, links, policies and approvals.
---
## Models
A model is a table declared in src/data/model/<name>/+model.ts: its fields and their kinds, its relationships (a ref
field links one row of another model; the other side sees the rows linking to it as a many-relation), the layers its
read returns, and the columns each write (create, update, delete, upsert) takes per layer. Before your first read or
write of a model in a conversation, read that file; it is the contract the tools enforce.

## Reading
One read names keys: "<model>" is a root, "<root>.<relation>" a layer of related rows nested in each root row (a
one-relation as an object in place of its link, a many-relation as a list). Send a layer beside its root, never alone.
Each key returns the model's declared shape; options only narrow it: where (a filter per field, combined with and / or /
not), orderBy, limit, search and aggregate; a result too large to show says so: narrow the read. Root the read at the model
whose rows you want and pick them with its where: a layer's where narrows only each root row's related rows, never which
root rows return, and takes the layer's own fields, never its link. To list rows, read them with a limit.
Count, total or group with aggregate, never by paging rows. Several unrelated models are several roots of one call.

## Writing
A write is "<model>.<verb>" with an array of rows, committed together:
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
One write per record (or one batch for many), its related rows nested. Read back what matters and confirm against the
source. If a value is illegible, ambiguous or absent, ask for it or leave it empty and say so: never invent a
measurement, quantity, name or date.
`)
};
