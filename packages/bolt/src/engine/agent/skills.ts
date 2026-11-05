// The platform's own skills: how to work with any workspace's records and how to take in unstructured material. Every
// agent has them beside the workspace's skills (a workspace skill of the same name replaces one); the system prompt
// lists them and the `skill` tool reads them, so their text costs nothing until an agent opens it.
import type { SkillSpec } from '../manifest.ts';

const skill = (text: string): SkillSpec => ({ text, digest: '', files: [] });

export const PLATFORM_SKILLS: { readonly [name: string]: SkillSpec } = {
	records: skill(`---
description: Protocol for reading and writing a workspace's records.
---
1. Know: describe_workspace { names } gives every model the task touches, in one call, unless the conversation shows them.
2. Read: one request with every root; narrow by where, never by paging. Pick rows by their relations with is/some/none/every/count. Count, total and group with aggregate. A value may be a { var } over requestor, today, now.
3. Resolve: each referenced record by one exact read. Missing and stated in the source: create it nested if the write allows, else ask. A word search is ranking, not proof of identity or a category count.
4. Write: one act, the whole change as a batch, related rows inside their root. A computed or large batch is a JSON file run_js returned, given as inputFile.
5. Report from the answer: a committed write returns its stored rows; a held write awaits its approvers, say so; a refused one names why, say that. An empty read earns one different read, then a question.
`),
	ingest: skill(`---
description: Protocol for taking in documents, scans, photos, handwriting, sheets or messages, whether or not they touch records.
---
1. Decide what was asked. Reading, summarising or checking material writes nothing. Filing or acting on it follows steps 5 to 7. Matching against records happens only when the task, or the workspace's own paperwork skill, calls for it; a read-only task may cross-reference to raise confidence and says so.
2. Read everything once: every file, page and sheet. read_file { id } answers lines and shows page images.
3. Read images by eye, value by value. Crossings-out, corrections and margin notes are data: report what stands and what was struck. Prove every table: qty × price = amount, amounts = subtotal, subtotal + tax = total; a sum that fails means a misread digit, so zoom that row. Anything unclear: one read_file with crops listing every such region together. Still unclear: name the field and give your best reading marked uncertain, never a confident guess.
4. Comparing documents: line by line, every field, and report each difference with both values and its amount.
5. Map: every target column to a source value, kinds and required columns from describe_workspace. Trace each value to where it was read; check numbers, units and dates against the original.
6. Resolve: every relational field by an exact read of its source identifier. Decide LINK, CREATE or UPDATE with the value, or REFUSE naming the field. Never take the closest name, the current user, or a record from another row. Create a missing catalogue row only when its required values are stated and the task allows. Find an existing root by its source identity first; an unchanged repeat, same content hash and values, writes nothing.
7. Write and confirm: values derived from a file are computed in run_js from the file itself, never retyped. Report the root model and every relational field as model.field → target, decision, value. Mark any value not from the source MOCKED.
`),
	research: skill(`---
description: Protocol for web research, scraping and downloading.
---
1. web_search, then open the primary source: the authority, publisher or vendor, not an aggregator.
2. One browser call: open, act, evaluate. Extract with one evaluate returning JSON rows, never by reading screens. Loop pages or sites inside run_js with tool('browser', …) and return only the result.
3. Follow pagination until the set is complete. Keep each value's URL and exact wording; cite it.
4. Media: save the file's own URL, never the page's. What a recording says comes only from its transcript; without one, say so.
5. When sources disagree, report the disagreement. Change records only if asked, citing the source.
`),
	analysis: skill(`---
description: Protocol for analysing data and producing charts and reports.
---
1. A count, total, average or group is one read with aggregate. Read rows only for what aggregate cannot give.
2. Anything further is run_js over the read's rows; verify its totals against an aggregate.
3. A chart is an SVG file run_js returns. A report is document, with numbers as tables and charts inline.
4. State what the numbers show in a sentence or two.
`)
};
