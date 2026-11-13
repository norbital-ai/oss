// The platform's own skills: how to work with any workspace's records and how to take in unstructured material. Every
// agent has them beside the workspace's skills (a workspace skill of the same name replaces one); the system prompt
// lists them and the `skill` tool reads them, so their text costs nothing until an agent opens it.
import type { SkillSpec } from '../manifest.ts';

const skill = (text: string): SkillSpec => ({ text, digest: '', files: [] });

export const PLATFORM_SKILLS: { readonly [name: string]: SkillSpec } = {
	records: skill(`---
description: Protocol for reading and writing a workspace's records.
---
1. Know: describe_workspace { names } gives every model the task touches, in one call, before any read of them, unless the conversation shows them.
2. Read: one request with every root; narrow by where, never by paging. Pick rows by their relations with is/some/none/every/count. Every read answers total, its match count, beside its rows; aggregate is for sums, averages and groups, and answers measures instead of rows. A value may be a { var } over requestor, today, now.
3. Resolve: each referenced record by one exact read. Missing and stated in the source: create it nested if the write allows, else ask. A word search is ranking, not proof of identity or a category count.
4. Write: one act, the whole change as a batch, related rows inside their root. A computed or large batch is a JSON file run_js returned, given as input_file.
5. Report from the answer, with no read after it: a committed write returns its stored rows; a held write awaits its approvers, say so; a refused one names why, say that. An empty read earns one different read, then a question.
`),
	ingest: skill(`---
description: Protocol for taking in documents, scans, photos, handwriting, sheets or messages, whether or not they touch records.
---
1. Decide what was asked. Reading, summarising or checking material writes nothing. Filing or acting on it follows steps 5 to 7. Matching against records happens only when the task, or the workspace's own paperwork skill, calls for it; a read-only task may cross-reference to raise confidence and says so.
2. Read everything once: every file, page and sheet. read_file { id } answers lines and shows page images; a scan's lines are its transcript. A locked PDF or Office file opens with read_file { id, password }, the password the person gave; without one, ask for it. A format read_file has no parser for gets a tool of your own, never a decoder written by hand in run_js.
3. Read images by eye, value by value. Crossings-out, corrections and margin notes are data: report what stands and what was struck. Prove every table: qty × price = amount, amounts = subtotal, subtotal + tax = total; a sum that fails means a misread digit, so zoom that row. Anything unclear: one read_file with crops listing every such region together. Still unclear: name the field and give your best reading marked uncertain, never a confident guess.
4. Comparing documents: line by line, every field, and report each difference with both values and its amount.
5. Map: every target column to a source value, kinds and required columns from describe_workspace. Trace each value to where it was read; check numbers, units and dates against the original.
6. Resolve: every relational field by an exact read of its source identifier (like ignores case, eq does not; read every field you need at once). A transcript's code or name a character or two from the one close record: zoom on it once; if the crop can be that record, LINK and say so. Decide LINK, CREATE or UPDATE with the value, or REFUSE naming the field. Only a required field refuses: an optional value that is blank or unreadable stays empty and you say so. Never take the closest name, the current user, or a record from another row. Create a missing catalogue row only when its required values are stated and the task allows. Find an existing root by its source identity first; an unchanged repeat, same content hash and values, writes nothing.
7. Write and confirm: a table's numbers or a file's data are computed in run_js from the file itself, never retyped; single values go straight in the write. A file field takes the whole reference the message lists, never its bare id. Report the root model and every relational field as model.field → target, decision, value. Mark any value not from the source MOCKED.
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
1. A count is a read's total. A sum, average or group is one read with aggregate. Read rows only for what those cannot give.
2. Money adds up only within one currency: group every money sum by its currency, and never add or rank across currencies.
3. Anything further is run_js over the read's rows; verify its totals against an aggregate.
4. A chart is an SVG file run_js returns. A report is document, with numbers as tables and charts inline.
5. State what the numbers show in a sentence or two.
`),
	requirements: skill(`---
description: How to turn a brief into the smallest product that fits.
---
1. Restate the goal, the people it serves, the jobs they do, the non-goals and what acceptance means. If two readings of the brief would produce different pages, ask with the ask tool before building.
2. Write a short design note: each requirement, the page or section that serves it, and why. Every page, model and automation in the change must trace to a line in that note; anything without one is deleted or merged.
3. One page serves one job. Prefer a section, a form or a field over a new page; prefer an existing model over a new one. Add a surface only when the requirement needs it.
4. On feedback, state what will be removed or merged first, then add only what the person asked for.
5. A build is not done until the design note, the tests and workspace_preview agree with the brief.
`),
	'data-modelling': skill(`---
description: How to model a domain with the fewest, most general models, and how to lay them out.
---
1. Learn the domain first: its jobs, actors, inputs and the variations its users need. Design so a new variation is a new configuration record created at runtime, never new source.
2. Generic over specific: one engine model plus the runtime records that configure it. Code reads the configuration and never branches on a customer or a case.
3. Fewest models. A fact is, in order of preference: a field; a custom datatype or shaped json on its owner; an owned child model; a separate model.
4. A model earns its table over a custom datatype only when the fact needs a foreign-key constraint, its own view, its own lifecycle, permissions or approval, history, or relational queries.
5. Lay models out as a hierarchy: a model's folder nests under the model that owns it (data/model/<root>/<child>/+model.ts); catalogues and settings group under one settings root. The tree reads as the domain.
6. One owner per fact. Do not duplicate a value across models; a read that needs it reaches the owner.
7. External live facts (rates, prices, weather, feeds) are reads through the host's facilities. Persist a value only when a requirement asks for history or audit, and say which one.
8. A dated report is one record: its figures, sections and conclusions are inline shapes or owned children, not one model per section.
9. Model the domain, not the page. A table that exists only to arrange a screen is a UI concern, not a model.
`),
	'product-ux': skill(`---
description: How a workspace page and form should be composed.
---
1. Read the page and layout references before the first page. Compose from the shell, layout and view primitives the contract names; a page root is never raw markup.
2. The shell owns the page. A page with more than one section scrolls inside its shell, never on the browser body.
3. Reveal detail progressively: group a form's fields by meaning into sections, never one long flat list.
4. Records show in the native views (table, board, chart) and the record sheet for one row; give every record model a representation. Use them before any custom component, and never render a model as ad-hoc markup.
5. One scroll owner per region. Never nest scrolling containers on one axis.
6. A table or board fills its parent region and scrolls inside itself; it never makes its parent overflow. Only when the parent's available height is below its minimum height may it exceed it, and then the parent scrolls.
7. Tabs follow their nesting level: the first level is default tabs, the second underline, the third chips. Many sections or deep nesting take vertical tabs, always on the left, never the right; otherwise horizontal.
8. The simplest, most general layout that serves the job is the better one: fewer pages, fewer components.
9. Artwork is part of the app identity: a banner or thumbnail is a real image with a working source and alt text, never a placeholder.
10. Verify in the preview: pages render, scroll, and show no broken images or console errors.
`),
	engineering: skill(`---
description: General engineering practice for a workspace change.
---
1. Read the source, the contract and the relevant references before writing. Do not guess an API when a type or a reference answers it.
2. Make the smallest complete change. No unasked feature, no abstraction without two real call sites, no dead model, page or field.
3. Write Effect code: bodies are function* and yield* their ctx Effects; helpers return Effects with typed failures; no Promise wrappers.
4. src/lib/<domain>/ holds reusable services. Logic a server body and a page both need lives there once and both import it. No lone file: a helper with one caller stays beside that caller.
5. Keep values in the form the platform already gives them; decode at the boundary once. Do not erase types or fabricate partial data.
6. Tests prove this workspace's own flows: which write its policies hold, for whom, and who approves. Never test what the platform already guarantees.
7. Finish the source, then verify in this order: types, tests, build, preview. Report what failed and what you fixed.
8. When feedback says the result is wrong, remove or merge before adding. A larger diff is not progress.
`),
	capabilities: skill(`---
description: What a workspace can do on its own, to compose a solution to a person's problem.
---
1. Start from the problem: what the person does by hand, how often, from what input. Then compose the mechanisms below. Configuring an existing mechanism beats writing new code.
2. Models: transforms validate and derive on every write; effects react after commit; constraints and locks guard state.
3. Automations: jobs run queued, on a cron or from an effect; calls answer at once and serve pages and agents as tools. Each runs with its own policies.
4. Inference: ctx.ai infers structured output against a JSON schema with CEL rules, to parse documents, classify, extract or draft. Keep its instructions and schema in configuration records.
5. Messaging: envoys converse on a paired account; ctx.send sends through it; a scheduled message is a cron automation; replies continue in the same conversation.
6. Syncs and integrations: syncs exchange rows with remote systems and with files (import, export, templates); connections are runtime records the person creates and pairs.
7. Policies and approvals: grants decide who may do what; a verdict can route a write for approval.
8. Agent work: scripts compute over reads and files; the browser works the web; an automation marked for agents becomes your own tool; a workspace skill records a repeated procedure and the brief records standing rules.
9. Onboarding and configuration: set up envoys, connections and runtime catalogues through native records and the integration page. Never collect a credential in chat.
10. When a step repeats, build a tool for it; when a procedure repeats, write a skill. Prefer the least complex composition.
`),
	'workspace-eval': skill(`---
description: How to grade a workspace against its brief before merge.
---
1. Read the brief, the design note, the source, the preview report and the tests. The question is requirement fit, not taste.
2. For every requirement, name the page, section, model or automation that serves it and the evidence that it works. A surface with no requirement is a finding.
3. Ask what could be deleted or inlined. A model that only arranges a screen, a page that repeats another page, a section that could be a field: each is a finding with the requirement it fails to justify.
4. Check live versus stored: an external value is a read unless a stated history or audit requirement needs a record.
5. Check the UI evidence: every page scrolls, the shell and forms are used, representations exist for record views, artwork loads, no console errors.
6. Score requirement fit, simplicity, data shape, UI and verification from 0 to 4. Verdict: pass only when every requirement is traced and every finding is fixed or explicitly accepted by the person.
`)
};
