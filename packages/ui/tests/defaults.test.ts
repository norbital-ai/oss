// The kit's default display (template UI audit, 2026-09-30): labels from the catalog, never a key or an id; dates,
// money and enums formatted by kind; row clicks open; empty states; the record sheet titled by its record.
import './dom.ts';
import assert from 'node:assert/strict';
import { Schema, Stream } from 'effect';
import { it as test, afterEach } from '@effect/vitest';
const k = await import('../src/kinds/kind.ts');
const messages = await import('../src/text/messages.ts');
const relations = await import('../src/relations/select.ts');
const csv = await import('../src/table/csv.ts');
const d = await import('../src/form/draft.ts');
import type { Json, ViewBolt } from '../src/client/contract.ts';
import type { Row, Page, Values } from '../src/collection/types.ts';
import type { Fields, Value } from '@norbital-ai/std/kind';
import type { KindsHost } from '../src/kinds/context.ts';
import type { DefaultsPart } from './defaults-harness.svelte';
import { scriptedBolt } from './scripted-bolt.ts';
import { element } from './elements.ts';
import * as ui from '../src/index.ts';
const { flushSync, mount, tick, unmount } = await import('svelte');
const { default: Harness } = await import('./defaults-harness.svelte');

// ── pure ──
const catalogT = (words: Record<string, string>) => (key: string) => words[key] ?? key;

test('enumText: the catalog word, else the value in words; acronyms stay', () => {
	assert.equal(k.enumText('not_sent'), 'Not sent');
	assert.equal(k.enumText('PENDING_REVIEW'), 'Pending review');
	assert.equal(k.enumText('SG_CPF'), 'SG CPF');
	assert.equal(k.enumText('SG_64'), 'SG 64');
	assert.equal(k.enumText('sent_to_HR'), 'Sent to HR');
	const t = catalogT({ 'models.jobs.fields.status.on_hold': 'Paused' });
	assert.equal(k.enumText('on_hold', { t, collection: 'jobs', field: 'status' }), 'Paused');
	assert.equal(k.enumText('on_hold', { t, collection: 'jobs', field: 'kind' }), 'On hold');
	// format() speaks the same words, for one and many values and for states
	assert.equal(
		k.format({ kind: 'enum', values: ['a_b', 'c'], many: true }, ['a_b', 'c']),
		'A b, C'
	);
	assert.equal(
		k.format({ kind: 'state', initial: 'draft', states: { on_hold: {} } }, 'on_hold', {
			t,
			collection: 'jobs',
			field: 'status'
		}),
		'Paused'
	);
});

test('tone: whole words, and a negation is never a success', () => {
	for (const s of ['inactive', 'unpaid', 'not_sent', 'NOT_SENT', 'incomplete'])
		assert.notEqual(k.tone(s), 'success', s);
	assert.equal(k.tone('renewed'), 'info', 'no substring match on "new"');
	assert.equal(k.tone('approved'), 'success');
	assert.equal(k.tone('in_progress'), 'info');
	assert.equal(k.tone('on_hold'), 'warning');
	assert.equal(k.tone('skipped'), 'neutral', 'a message with nothing to send is not a failure');
	// delivery statuses (bolt §5.9)
	assert.equal(k.tone('bounced'), 'danger');
	assert.equal(k.tone('complained'), 'danger');
	assert.equal(k.tone('deferred'), 'warning');
	assert.equal(k.tone('open'), 'neutral');
	assert.equal(k.tone('opened'), 'info');
	assert.equal(k.tone('cancelled'), 'danger');
});

test('dates: a date is a medium date; an instant a medium date and a short time, no seconds', () => {
	assert.equal(k.format({ kind: 'date' }, '2026-01-02', { locale: 'en-US' }), 'Jan 2, 2026');
	const at = '2026-01-02T03:04:05.000Z';
	const want = new Intl.DateTimeFormat('en-US', {
		dateStyle: 'medium',
		timeStyle: 'short',
		timeZone: 'UTC'
	}).format(new Date(at));
	assert.equal(k.format({ kind: 'instant' }, at, { locale: 'en-US', zone: 'UTC' }), want);
	assert.doesNotMatch(want, /:05/);
	assert.match(
		k.format(
			{ kind: 'period', of: 'instant' },
			{ start: at, end: null },
			{ locale: 'en-US', zone: 'UTC' }
		),
		new RegExp(`^${want.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} – …$`)
	);
	assert.equal(
		k.formatValue(at, 'en-US'),
		new Date(at).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })
	);
});

test('numbers: money is CODE 1,234.00; a decimal is trimmed; a sum of money is money', () => {
	assert.equal(
		k.format({ kind: 'money', currency: 'SGD' }, '1234.5', { locale: 'en', currency: 'SGD' }),
		'SGD 1,234.50'
	);
	assert.equal(k.format({ kind: 'money' }, '1200', { locale: 'en', currency: 'JPY' }), 'JPY 1,200');
	assert.equal(
		k.format({ kind: 'money' }, '5884.7', { locale: 'en' }),
		'5,884.70',
		'no currency: two places, never trimmed'
	);
	assert.equal(k.format({ kind: 'money' }, 42586, { locale: 'en' }), '42,586.00');
	assert.equal(k.format({ kind: 'decimal', scale: 4 }, '1234.5000', { locale: 'en' }), '1,234.5');
	assert.equal(k.format({ kind: 'decimal', scale: 2 }, '12.00', { locale: 'en' }), '12');
	// the boot marks a sum over a money child with `money` (its literal code when the child has one)
	assert.deepEqual(
		k.shownKind({ kind: 'sum', of: 'quote_lines.net', money: { currency: 'SGD' } }),
		{ kind: 'money', currency: 'SGD' }
	);
	assert.deepEqual(k.shownKind({ kind: 'sum', of: 'quote_lines.net', money: {} }), {
		kind: 'money'
	});
	assert.deepEqual(k.shownKind({ kind: 'sum', of: 'quote_lines.qty' }), {
		kind: 'sum',
		of: 'quote_lines.qty'
	});
	assert.equal(k.fieldName({ kind: 'sum', of: 'quote_lines.net', money: {} }), 'money');
});

test('labels: a FK names its target, the catalog outranks a declared label, a model has a singular', () => {
	const t = catalogT({ 'models.jobs.fields.crew': 'Team', 'models.people.singular': 'Person' });
	assert.equal(messages.label({ t }, 'jobs', 'project_id'), 'Project');
	assert.equal(messages.label({ t }, 'jobs', 'nda_required'), 'Nda required');
	assert.equal(messages.label({ t }, 'jobs', 'crew', 'Crew name'), 'Team');
	assert.equal(messages.label({ t }, 'jobs', 'size', 'Job size'), 'Job size');
	assert.equal(messages.singular({ t }, 'jobs'), 'Job');
	assert.equal(messages.singular({ t }, 'categories'), 'Category');
	assert.equal(messages.singular({ t }, 'addresses'), 'Address');
	assert.equal(messages.singular({ t }, 'people'), 'Person');
	assert.equal(messages.singular({ t }, 'status'), 'Status');
});

test('a record title is its label fields by kind; a target without a readable label is a dash, never its id', () => {
	const fields: Fields = {
		code: { kind: 'text' },
		due_on: { kind: 'date' },
		status: { kind: 'enum', values: ['on_hold'] }
	};
	assert.equal(
		k.fieldsText(
			fields,
			{ code: 'Q-1', due_on: '2026-01-02', status: 'on_hold' },
			['code', 'due_on', 'status'],
			{ locale: 'en-US' }
		),
		'Q-1 · Jan 2, 2026 · On hold'
	);
	const cat: NonNullable<KindsHost['catalog']> = {
		jobs: {
			label: ['title'],
			fields: { title: { kind: 'text' } },
			relations: { account: { targets: ['accounts'] } }
		},
		accounts: { label: ['name'], fields: { name: { kind: 'text' } } }
	};
	const [r] = relations.unref(
		cat,
		'jobs',
		['account'],
		[{ id: 'j1', account: { id: 'a1', name: null } }]
	);
	assert.ok(r);
	const refs = Schema.decodeUnknownSync(
		Schema.Struct({ $refs: Schema.Record(Schema.String, Schema.Struct({ text: Schema.String })) })
	)(r);
	assert.equal(refs.$refs.account.text, '—');
});

test('CSV cells: enum words, ISO dates and instants, relation labels', () => {
	const row: Row = {
		id: 'j1',
		status: 'on_hold',
		due_on: '2026-01-02',
		at: '2026-01-02T03:04:05.000Z',
		tags: ['a_b'],
		n: 3,
		$refs: { account: { of: 'accounts', text: 'Acme' } }
	};
	const words = (v: string) => k.enumText(v);
	assert.equal(
		csv.csvCell(row, 'status', { kind: 'state', initial: 'on_hold', states: {} }, words),
		'On hold'
	);
	assert.equal(
		csv.csvCell(row, 'tags', { kind: 'enum', values: ['a_b'], many: true }, words),
		'A b'
	);
	assert.equal(csv.csvCell(row, 'due_on', { kind: 'date' }, words), '2026-01-02');
	assert.equal(csv.csvCell(row, 'at', { kind: 'instant' }, words), '2026-01-02T03:04:05.000Z');
	assert.equal(csv.csvCell(row, 'account', undefined, words), 'Acme');
	assert.equal(csv.CSV_BOM, '﻿');
});

test('search falls back to the label text fields', () => {
	const target: NonNullable<KindsHost['catalog']>[string] = {
		label: ['code', 'name'],
		fields: { code: { kind: 'seq' }, name: { kind: 'text' } }
	};
	assert.deepEqual(k.likeWhere(target, ['code', 'name'], ' ac%'), {
		or: [{ name: { like: '%ac\\%%' } }]
	});
	assert.equal(k.likeWhere(target, ['code'], 'x'), undefined);
});

test('a final state has no moves: the state field is locked', () => {
	const fields: Fields = {
		status: { kind: 'state', initial: 'open', states: { open: { to: ['won'] }, won: {} } },
		note: { kind: 'text' }
	};
	assert.equal(d.locked(fields, { status: 'open' })('status'), false);
	assert.equal(d.locked(fields, { status: 'won' })('status'), true);
	assert.equal(d.locked(fields, { status: 'won' })('note'), false);
});

// ── mounted ──
type ReadOptions = Readonly<Record<string, Json>>;
async function fake(
	rows: readonly Row[],
	extra: {
		read?(collection: string, options: ReadOptions): Page | Promise<Page>;
		get?(collection: string, id: string): Row | null | Response | Promise<Row | null | Response>;
		aggregate?(): readonly Values[];
		start?(automation: string, input: Value): void;
		t?: ViewBolt['t'];
		runs?: ViewBolt['runs'];
	} = {}
) {
	const reads: { c: string; o: ReadOptions }[] = [];
	const client = await scriptedBolt({
		...extra,
		answer: ({ m, a }) => {
			const collection = Schema.decodeUnknownSync(Schema.String)(a[0]);
			if (m === 'read') {
				const options = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json))(a[1]);
				reads.push({ c: collection, o: options });
				return extra.read?.(collection, options) ?? { rows, next: null };
			}
			if (m === 'get') {
				const id = Schema.decodeUnknownSync(Schema.String)(a[1]);
				return extra.get === undefined
					? (rows.find((row) => row.id === id) ?? null)
					: extra.get(collection, id);
			}
			if (m === 'aggregate') return extra.aggregate?.() ?? [{ count: rows.length }];
			if (m === 'history') return { rows: [], next: null };
			return null;
		}
	});
	clients.push(client.dispose);
	return { bolt: client.bolt, reads };
}
const settle = async () => {
	for (let i = 0; i < 5; i++) {
		flushSync();
		await tick();
		await new Promise((r) => setTimeout(r, 0));
	}
	flushSync();
};
const clients: (() => Promise<void>)[] = [];
const mounted: (() => Promise<void>)[] = [];
afterEach(async () => {
	while (mounted.length > 0) await mounted.pop()?.();
	while (clients.length > 0) await clients.pop()?.();
});
async function show(
	part: DefaultsPart,
	bolt: ViewBolt,
	catalog: NonNullable<KindsHost['catalog']> = {}
) {
	history.replaceState(null, '', '/');
	const target = document.createElement('div');
	document.body.append(target);
	const app = mount(Harness, { target, props: { bolt, catalog, ...part } });
	mounted.push(async () => {
		await unmount(app);
		target.remove();
	});
	await settle();
	return target;
}
const records = () => new URL(location.href).searchParams.getAll('record');

const jobs: NonNullable<KindsHost['catalog']> = {
	jobs: {
		label: ['title'],
		fields: {
			title: { kind: 'text' },
			kind: { kind: 'enum', values: ['on_site', 'remote'] },
			due_on: { kind: 'date', optional: true },
			status: { kind: 'state', initial: 'open', states: { open: { to: ['won'] }, won: {} } },
			notes: { kind: 'text', format: 'markdown', optional: true }
		},
		relations: { account_id: { targets: ['accounts'], optional: true } },
		update: { columns: ['title', 'status'] }
	},
	accounts: { label: ['name'], fields: { name: { kind: 'text' } } }
};
const ROW = {
	id: 'j1',
	revision: 1,
	title: 'Paint',
	kind: 'on_site',
	due_on: '2026-01-02',
	status: 'open',
	notes: '**bold**',
	account_id: null
};

test('Table: a row click opens its record; links, buttons and selected text do not; Enter opens a focused row', async () => {
	const { bolt } = await fake([ROW]);
	const t = await show(
		{ part: 'table', props: { of: 'jobs', columns: ['title', 'kind'] } },
		bolt,
		jobs
	);
	const tr = element(t, '[data-table-wide] tbody tr:not([aria-hidden])');
	element(tr, 'td').click();
	assert.deepEqual(records(), ['jobs/j1']);
	history.replaceState(null, '', '/');
	element(tr, '[data-row-open]').click();
	assert.deepEqual(records(), ['jobs/j1'], 'the hover button still opens');
	history.replaceState(null, '', '/');
	const link = document.createElement('a');
	element(tr, 'td div').append(link);
	link.click();
	assert.deepEqual(records(), []);
	tr.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
	assert.deepEqual(records(), ['jobs/j1']);
	assert.equal(tr.tabIndex, 0);
});

test('Table inside a sheet: the row and the phone card still open their record (the sheet is no control of the row)', async () => {
	const { bolt } = await fake([ROW]);
	const t = await show(
		{ part: 'table', props: { of: 'jobs', columns: ['title', 'kind'] } },
		bolt,
		jobs
	);
	t.setAttribute('role', 'dialog'); // a project's RecordShell sheet around its Trials table
	element(t, '[data-table-wide] tbody tr:not([aria-hidden]) td').click();
	assert.deepEqual(records(), ['jobs/j1']);
	history.replaceState(null, '', '/');
	element(t, '[data-row-card]').click();
	assert.deepEqual(records(), ['jobs/j1']);
});

test('Table: an enum is a neutral chip in words, a state a coloured badge; a FK column is named by its target', async () => {
	const { bolt } = await fake([ROW]);
	const t = await show(
		{ part: 'table', props: { of: 'jobs', columns: ['title', 'kind', 'status', 'account_id'] } },
		bolt,
		jobs
	);
	const chip = t.querySelector('[data-table-wide] [data-enum-value=on_site]');
	assert.equal(chip?.textContent?.trim(), 'On site');
	assert.ok(t.querySelector('[data-table-wide] [data-state-value=open]'));
	const heads = [...t.querySelectorAll('[data-table-wide] th[data-column]')].map((th) =>
		th.textContent?.trim()
	);
	assert.ok(heads.includes('Account'), heads.join());
});

test("Table: search falls back to the label fields; the empty text keeps the label's case", async () => {
	const { bolt, reads } = await fake([], {
		t: (key) => (key === 'models.sow_documents.label' ? 'SOW documents' : key)
	});
	const cat: NonNullable<KindsHost['catalog']> = {
		sow_documents: { label: ['title'], fields: { title: { kind: 'text' } } }
	};
	const t = await show(
		{ part: 'table', props: { of: 'sow_documents', columns: ['title'] } },
		bolt,
		cat
	);
	assert.match(t.textContent ?? '', /No SOW documents yet/);
	element(t, '[data-search-toggle]').click();
	await settle();
	const box = document.querySelector<HTMLInputElement>('[data-search]');
	assert.ok(box, 'a search box');
	assert.match(document.querySelector('[data-search-fields]')?.textContent ?? '', /Title/);
	box.value = 'acme';
	box.dispatchEvent(new Event('input', { bubbles: true }));
	await new Promise((r) => setTimeout(r, 350));
	await settle();
	const last = reads.filter((r) => r.c === 'sow_documents').at(-1);
	assert.ok(last);
	assert.equal(last.o.search, undefined);
	assert.deepEqual(last.o.where, { or: [{ title: { like: '%acme%' } }] });
});

test('record sheet: titled by the record, the singular model above; a subtitle of fields by kind; no id, no "by —"', async () => {
	const { bolt } = await fake(
		[{ ...ROW, account_id: 'a9', created_at: '2026-01-02T03:04:05.000Z', created_by: 'u1' }],
		{
			get: (c) =>
				c === 'jobs'
					? { ...ROW, account_id: 'a9', created_at: '2026-01-02T03:04:05.000Z', created_by: 'u1' }
					: null
		}
	);
	const t = await show(
		{ part: 'record', props: { of: 'jobs', id: 'j1', subtitle: ['kind', 'due_on'] } },
		bolt,
		jobs
	);
	const head = element(document, '[role=dialog] [data-record-head]');
	assert.equal(element(head, 'h2').textContent?.trim(), 'Paint');
	assert.match(head.textContent ?? '', /Job/);
	assert.match(head.textContent ?? '', /On site · Jan 2, 2026/);
	const account = element(document, '[data-field=account_id]');
	assert.match(account.textContent ?? '', /Account/);
	assert.doesNotMatch(account.textContent ?? '', /a9/);
	assert.match(account.textContent ?? '', /—/);
	assert.equal(
		document.querySelector('[data-record-info]'),
		null,
		'audit metadata belongs only in History'
	);
	assert.ok(
		document.querySelector('[data-field=notes] [data-markdown] strong'),
		'markdown reads as prose'
	);
	void t;
});

test('record sheet: an explicit title and subtitle still win', async () => {
	const { bolt } = await fake([ROW]);
	await show(
		{ part: 'record', props: { of: 'jobs', id: 'j1', title: 'Custom', subtitle: 'Line' } },
		bolt,
		jobs
	);
	const head = element(document, '[role=dialog] [data-record-head]');
	assert.equal(element(head, 'h2').textContent?.trim(), 'Custom');
	assert.match(head.textContent ?? '', /Line/);
});

test('an empty relation reads as a dash', async () => {
	const { bolt } = await fake([ROW]);
	await show({ part: 'record', props: { of: 'jobs', id: 'j1' } }, bolt, jobs);
	assert.match(element(document, '[data-field=account_id]').textContent ?? '', /—/);
});

test('a record in a final state: its state is read-only and there is no Save', async () => {
	const { bolt } = await fake([]);
	const won = { ...ROW, status: 'won' };
	const cat = { jobs: { ...jobs.jobs, update: { columns: ['status'] } } };
	const t = await show(
		{ part: 'form', props: { of: 'jobs', mode: 'update', id: 'j1', record: won } },
		bolt,
		cat
	);
	assert.ok(t.querySelector('[data-field=status][data-readonly]'));
	assert.equal(t.querySelectorAll('button[type=submit]').length, 0);
});

test("CustomView: no rows is the kit's empty state", async () => {
	const { bolt } = await fake([]);
	const t = await show({ part: 'custom', props: { of: [], fields: ['title'], key: 'x' } }, bolt);
	assert.ok(t.querySelector('[data-read=empty]'));
	assert.equal(t.querySelector('[data-custom-rows]'), null);
	const some = await show(
		{ part: 'custom', props: { of: [{ title: 'a' }], fields: ['title'], key: 'y' } },
		bolt
	);
	assert.equal(element(some, '[data-custom-rows]').textContent, '1');
});

test("select-all: the card list selects its page, then every matching row, beside the grid's header checkbox", async () => {
	const all = Array.from({ length: 30 }, (_, i) => ({ ...ROW, id: `j${i}`, title: `Job ${i}` }));
	const reads: ReadOptions[] = [];
	const { bolt } = await fake(all.slice(0, 25), {
		aggregate: () => [{ count: 30 }],
		read: (_c, o) => {
			reads.push(o);
			const rows = o.all ? all.map((r) => ({ id: r.id })) : all.slice(0, 25);
			return { rows, next: o.all ? null : 'c1' };
		}
	});
	const t = await show(
		{ part: 'table', props: { of: 'jobs', columns: ['title'], toolbar: { select: true } } },
		bolt,
		jobs
	);
	const card = element(t, '[data-table-card]');
	const before = [...card.children];
	const page = t.querySelector<HTMLInputElement>('[data-select-page]');
	assert.ok(page, 'the card list has its own page checkbox');
	page.click();
	await settle();
	assert.equal(element(t, '[data-selected-count]').textContent, '25 selected');
	// the selection sits in the footer in place of the range: nothing is inserted above the rows
	assert.ok(element(t, '[data-table-footer] [data-selected-count]'));
	assert.equal(t.querySelector('[data-table-footer] [data-range]'), null);
	assert.deepEqual([...card.children], before);
	assert.equal(t.querySelectorAll('[data-table-list] input[type=checkbox]:checked').length, 25);
	assert.equal(
		element<HTMLInputElement>(t, 'thead input[type=checkbox]').checked,
		true,
		'the grid header agrees'
	);
	const more = element(t, '[data-select-matching]');
	assert.match(more.textContent ?? '', /Select all 30 matching/);
	more.click();
	await settle();
	assert.equal(element(t, '[data-selected-count]').textContent, '30 selected');
	const last = reads.at(-1);
	assert.ok(last);
	assert.deepEqual(last.select, { id: true });
	assert.equal(t.querySelector('[data-select-matching]'), null);
	element(t, '[data-select-clear]').click();
	await settle();
	assert.equal(t.querySelector('[data-selected-count]'), null);
	assert.ok(
		element(t, '[data-table-footer] [data-range]'),
		'the range returns once nothing is selected'
	);
});

test("CustomView with `collection`: the menu offers that collection's pipeline, and the search stays on the view's own rows", async () => {
	const started: { automation: string; input: Value }[] = [];
	const { bolt } = await fake([], {
		start: (automation, input) => {
			started.push({ automation, input });
		}
	});
	const cat = { jobs: { ...jobs.jobs, search: ['title'], pipeline: { export: 'Every job' } } };
	const props: Extract<DefaultsPart, { part: 'custom' }>['props'] = {
		of: [{ id: 'a', name: 'Ada' }],
		fields: [{ field: 'name', label: 'Person' }],
		key: 'roster',
		toolbar: { title: 'Roster', context: { site: 's1' } }
	};
	const t = await show({ part: 'custom', props: { ...props, collection: 'jobs' } }, bolt, cat);
	element(t, '[data-view-actions]').click();
	await settle();
	const row = document.querySelector('[data-view-menu] [data-menu-item="export-pipeline"]');
	assert.ok(row, 'the pipeline export is in the menu');
	element(row, 'button').click();
	await settle();
	assert.deepEqual(started, [{ automation: 'jobs.pipeline', input: { mode: 'export' } }]);
	element(t, '[data-search-toggle]').click();
	await settle();
	assert.match(
		element(document, '[data-search-fields]').textContent ?? '',
		/Person/,
		"it searches the roster's columns, not jobs' fields"
	);
	assert.equal(document.querySelector('[data-search-commands]'), null);
	const plain = await show({ part: 'custom', props }, bolt, cat);
	assert.equal(
		plain.querySelector('[data-view-actions]'),
		null,
		'without `collection` the view offers no pipeline'
	);
});

test('Runs tab: one "No runs yet" only when no automation has runs; runs named by title, not key', async () => {
	const run = { id: 'r1', automation: 'jobs.send_pdf', status: 'succeeded' };
	const live = <A>(value: A) => Stream.succeed(value).pipe(Stream.concat(Stream.never));
	const { bolt } = await fake([ROW], {
		runs: (a) => live({ rows: a === 'jobs.send_pdf' ? [run] : [], next: null })
	});
	await show(
		{
			part: 'record',
			props: {
				of: 'jobs',
				id: 'j1',
				runs: [
					{ automation: 'jobs.send_pdf', title: 'Send the PDF' },
					{ automation: 'jobs.reindex' }
				]
			}
		},
		bolt,
		jobs
	);
	const tab = [...document.querySelectorAll<HTMLElement>('[role=tab]')].find((x) =>
		/Runs/.test(x.textContent ?? '')
	);
	assert.ok(tab);
	tab.click();
	await settle();
	const body = element(document, '[role=dialog]').textContent ?? '';
	assert.doesNotMatch(body, /No runs yet/);
	assert.match(body, /Send the PDF/);
	assert.doesNotMatch(body, /jobs\.send_pdf/);
});

test('ReadonlyMarkdown passes attributes through; the index exports the helpers', async () => {
	const { bolt } = await fake([]);
	const t = await show({ part: 'markdown' }, bolt);
	assert.ok(t.querySelector('[data-probe=md] strong'));
	for (const name of [
		'format',
		'enumText',
		'markdownHtml',
		'EmptyState',
		'label',
		'singular',
		'TAB_LEVEL'
	])
		assert.ok(name in ui, name);
	assert.equal(ui.TAB_LEVEL, Symbol.for('norbital.ui.tabs.level'));
});

test('form reads keep the current draft when an older row resolves last', async () => {
	const { reactive } = await import('./kinds-state.svelte.ts');
	const pending = new Map<string, (row: Row) => void>();
	const calls: string[] = [];
	const { bolt } = await fake([], {
		get: (_c, id) => {
			calls.push(id);
			return new Promise<Row>((resolve) => {
				pending.set(id, resolve);
			});
		}
	});
	const state = reactive({
		bolt,
		catalog: jobs,
		part: 'form' as const,
		props: { of: 'jobs', id: 'a', fields: ['title'] }
	});
	const target = document.createElement('div');
	document.body.append(target);
	const app = mount(Harness, { target, props: state });
	try {
		await settle();
		state.props = { of: 'jobs', id: 'b', fields: ['title'] };
		await settle();
		const current = pending.get('b');
		assert.ok(current);
		current({ id: 'b', title: 'Current' });
		await settle();
		const input = target.querySelector('input');
		assert.ok(input);
		assert.equal(input.value, 'Current');
		input.value = 'Edited';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		await settle();
		const old = pending.get('a');
		assert.ok(old);
		old({ id: 'a', title: 'Old' });
		await settle();
		assert.deepEqual(calls, ['a', 'b']);
		assert.equal(target.querySelector('input')?.value, 'Edited');
		state.props = { of: 'jobs', id: 'c', fields: ['title'] };
		await settle();
		await unmount(app);
		const stopped = pending.get('c');
		assert.ok(stopped);
		stopped({ id: 'c', title: 'Unmounted' });
		await settle();
		assert.equal(target.childNodes.length, 0);
	} finally {
		await unmount(app);
		target.remove();
	}
});

test('form one-shot reads retain missing/error feedback and supplied rows avoid a read', async () => {
	const calls: string[] = [];
	const { bolt } = await fake([], {
		get: (_c, id) => {
			calls.push(id);
			return Response.json(
				{ error: { code: 'unavailable', message: 'unavailable' } },
				{ status: 503 }
			);
		}
	});
	const missing = await show(
		{ part: 'form', props: { of: 'jobs', id: 'missing', fields: ['title'] } },
		bolt,
		jobs
	);
	assert.match(missing.textContent ?? '', /Not found|notFound/);
	await settle();
	assert.deepEqual(calls, ['missing']);
	const supplied = await show(
		{
			part: 'form',
			props: {
				of: 'jobs',
				id: 'given',
				record: { id: 'given', title: 'Provided' },
				fields: ['title']
			}
		},
		bolt,
		jobs
	);
	assert.equal(supplied.querySelector('input')?.value, 'Provided');
	assert.deepEqual(calls, ['missing']);
});

test('period labels retain month/year precision, including lists and open ends', () => {
	const month = { kind: 'period', of: 'date', precision: 'month' } as const;
	assert.equal(
		k.format(month, { from: '2026-10-01', to: '2026-10-31' }, { locale: 'en-US' }),
		'October 2026'
	);
	assert.equal(
		k.format(month, { from: '2026-10-01', to: '2026-11-30' }, { locale: 'en-US' }),
		'October 2026 – November 2026'
	);
	assert.equal(
		k.format(month, { from: '2026-10-01', to: null }, { locale: 'en-US' }),
		'October 2026 – …'
	);
	assert.equal(
		k.format({ kind: 'list', of: month }, [{ from: '2026-10-01', to: '2026-10-31' }], {
			locale: 'en-US'
		}),
		'October 2026'
	);
	assert.equal(
		k.format(
			{ kind: 'period', of: 'date', precision: 'year' },
			{ from: '2026-01-01', to: '2027-12-31' },
			{ locale: 'en-US' }
		),
		'2026 – 2027'
	);
});
