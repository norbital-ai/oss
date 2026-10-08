# Pipelines

`src/data/collection/<c>/+pipeline.ts` declares a collection's file import and export. The view toolbar's ⚡ menu wires
both automatically: Import… (upload), Download template, and Export. Each runs as the platform automation
`<c>.pipeline`, started by the member as its caller. Import and template need a create grant on `c`; export needs read.

```ts
import { pipeline } from '@norbital-ai/bolt';

export default pipeline('shifts', {
	import: {
		description: 'The roster sheet: per person, the days it covers.',
		input: { rows: { kind: 'list', of: { kind: 'object', fields: {
			row: { kind: 'number' },                       // filled with the sheet row number
			person: { kind: 'text', label: 'Person' },     // header "Person" or "person"
			day: { kind: 'date', label: 'Day' },
			hours: { kind: 'int', optional: true }         // a blank cell is left out
		} } } },
		context: { site: { kind: 'text', optional: true } }, // what the page shows (toolbar `context`)
		records: (input) => input.rows,
		// once per upload, read as the caller: what the sheet's keys name; plain data (it crosses as JSON)
		known: async (ctx, records, { context }) => ({
			leave: Object.fromEntries((await ctx.read('leave_codes', { all: true })).rows.map((r) => [r.code, r.id]))
		}),
		map: (r, { known, context }) => ({ person: r.person, day: r.day, hours: r.hours ?? null }),
		// rows of other collections each record also writes, in the same act
		related: { days_off: (r, { known }) => r.leave ? [{ person: r.person, day: r.day, leave: known.leave[r.leave] }] : [] },
		onConflict: 'update',
		// a set: per person, from the first to the last day in the file, stored days the file leaves out are deleted
		scope: { by: ['person'], range: 'day', of: (r) => ({ person: r.person, day: r.day }) },
		check: async (ctx, { records, rows, known }) => rows.flatMap((r, i) => r && r.hours > 10
			? [{ row: records[i].row, column: 'hours', message: 'Over ten hours', severity: 'warn' }] : []),
		template: async (ctx, { context }) => (await ctx.read('shifts', { where: { day: { gte: ctx.today } }, all: true })).rows
	},
	export: { description: 'Every shift.', select: ['person', 'day', 'hours'], format: 'xlsx' }
});
```

## Upload

A JSON upload decodes against `input` as it is. An xlsx upload fills the input's single list of objects: header row 1
names the fields (by name or `label`, any case), every later row is one item, blank cells and blank rows are left out, and
columns the input does not declare are ignored. A number cell fills a `number`/`int` field. An Excel date or time serial
fills a `date`/`time` field. Other cells are read as text. A `row: { kind: 'number' }` field receives the sheet row
number, so findings can point back at the sheet.

## Context

A page scopes its view (`toolbar={{ context: { company_id, period } }}`). The ⚡ menu hands that context to the import
and template runs. It decodes against the pipeline's `context` fields like any input, and a bad one refuses the run.
`known`, `map`, `related`, `check` and `template` receive it as `context`. It narrows and defaults; it is never trusted
for authorization.

## Known

`known(ctx, records, { context })` runs once per upload, before any row is mapped, and reads as the caller. Its value is
the author's own shape (employee numbers to employments, codes to ids, an entity's time zone) and reaches `map`,
`related` and `check` as `known`. It crosses the guest boundary as JSON, so it is plain data: an object, not a `Map`.

## Related rows

`related: { <collection>: (record, { known, context }) => rows }` creates rows in other collections for each record.
They are created as the caller in the import's single act, beside the import's rows and the scope's deletes: one write
statement under one idempotency key. A refusal anywhere refuses the whole file. Related rows are creates. The scope does
not reach them, so a re-import creates them again unless the related collection's key or guard refuses the duplicate.

## Template

Download template writes `<c>-template.xlsx`. Its header is the list's fields (label, else name; `row` excluded). It is
prefilled with the rows of `template(ctx)` when declared, read as the caller.

## Scope (set semantics)

`scope.of(record, { known, context })` gives each record's scope values (`by` fields and `range`), and is called for every
record, including one `map` turns into nothing. A blank day in the sheet is therefore still in scope, so its stored
row is deleted. A person whose rows are all blank is scoped too. Without `of`, the groups come from the mapped rows.

With `scope`, the import is a set over the rows it maps. Each distinct `by` combination is one scope, and with
`range` that scope runs from the group's first `range` value to its last. Stored rows in scope that the import does not
name by the collection's key are deleted. Every create, update and delete is one act, which is one statement. The
collection needs a `key` and `delete`.

Locks come from the collection's existing guards. The act refuses the whole file when any of them refuses:

- its transform, which sees each key-matched row's stored row in `ctx.existing`, and sees pruned rows as
  `{ $delete: true }` inputs when the collection declares `delete: { transform: true }`;
- its state locks (a state's `edit`);
- the caller's grants.

A row restated unchanged is no change.

## Findings

`check(ctx, { input, records, rows })` returns findings: `{ row, column, message, severity: 'warn' | 'refuse' }`.
`rows[i]` is `map(records[i])`. Decode problems in an xlsx upload (a bad cell, a missing required column) and an act
refusal are `refuse` findings too.

- Any `refuse`: nothing is written. The run answers `{ applied: false, findings }`.
- Only `warn`, not accepted: nothing is written. The menu lists the warnings with "Accept and import", which starts the
  same file again with `accept: true`.
- Otherwise the run answers `{ applied: true, created, updated, deleted, findings }`.

The menu watches the import run: a spinner while it runs, the counts as a toast when it is done, the findings in place,
and the run's error when it fails.
