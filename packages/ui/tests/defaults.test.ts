// @ts-nocheck -- executed directly by Node with --experimental-strip-types.
// The kit's default display (template UI audit, 2026-09-30): labels from the catalog, never a key or an id; dates,
// money and enums formatted by kind; row clicks open; empty states; the record sheet titled by its record.
import './dom.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
const k = await import('../src/kinds/kind.ts');
const m = await import('../src/views/model.ts');
const d = await import('../src/form/draft.ts');
const { flushSync, mount, tick, unmount } = await import('svelte');
const { default: Harness } = await import('./defaults-harness.svelte');

// ── pure ──
const catalogT = (words) => (key) => words[key] ?? key;

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
	assert.equal(k.format({ kind: 'enum', values: ['a_b', 'c'], many: true }, ['a_b', 'c']), 'A b, C');
	assert.equal(k.format({ kind: 'state', initial: 'draft', states: { on_hold: {} } }, 'on_hold', { t, collection: 'jobs', field: 'status' }), 'Paused');
});

test('tone: whole words, and a negation is never a success', () => {
	for (const s of ['inactive', 'unpaid', 'not_sent', 'NOT_SENT', 'incomplete']) assert.notEqual(k.tone(s), 'success', s);
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
	const want = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(new Date(at));
	assert.equal(k.format({ kind: 'instant' }, at, { locale: 'en-US', zone: 'UTC' }), want);
	assert.doesNotMatch(want, /:05/);
	assert.match(k.format({ kind: 'period', of: 'instant' }, { start: at, end: null }, { locale: 'en-US', zone: 'UTC' }), new RegExp(`^${want.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} – …$`));
	assert.equal(m.show(at, 'en-US'), new Date(at).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }));
});

test('numbers: money is CODE 1,234.00; a decimal is trimmed; a sum of money is money', () => {
	assert.equal(k.format({ kind: 'money', currency: 'SGD' }, '1234.5', { locale: 'en', currency: 'SGD' }), 'SGD 1,234.50');
	assert.equal(k.format({ kind: 'money' }, '1200', { locale: 'en', currency: 'JPY' }), 'JPY 1,200');
	assert.equal(k.format({ kind: 'decimal', scale: 4 }, '1234.5000', { locale: 'en' }), '1,234.5');
	assert.equal(k.format({ kind: 'decimal', scale: 2 }, '12.00', { locale: 'en' }), '12');
	// the boot marks a sum over a money child with `money` (its literal code when the child has one)
	assert.deepEqual(k.shownKind({ kind: 'sum', of: 'quote_lines.net', money: { currency: 'SGD' } }), { kind: 'money', currency: 'SGD' });
	assert.deepEqual(k.shownKind({ kind: 'sum', of: 'quote_lines.net', money: {} }), { kind: 'money' });
	assert.deepEqual(k.shownKind({ kind: 'sum', of: 'quote_lines.qty' }), { kind: 'sum', of: 'quote_lines.qty' });
	assert.equal(k.fieldName({ kind: 'sum', of: 'quote_lines.net', money: {} }), 'money');
});

test('labels: a FK names its target, the catalog outranks a declared label, a model has a singular', () => {
	const t = catalogT({ 'models.jobs.fields.crew': 'Team', 'models.people.singular': 'Person' });
	assert.equal(m.label({ t }, 'jobs', 'project_id'), 'Project');
	assert.equal(m.label({ t }, 'jobs', 'nda_required'), 'Nda required');
	assert.equal(m.label({ t }, 'jobs', 'crew', 'Crew name'), 'Team');
	assert.equal(m.label({ t }, 'jobs', 'size', 'Job size'), 'Job size');
	assert.equal(m.singular({ t }, 'jobs'), 'Job');
	assert.equal(m.singular({ t }, 'categories'), 'Category');
	assert.equal(m.singular({ t }, 'addresses'), 'Address');
	assert.equal(m.singular({ t }, 'people'), 'Person');
	assert.equal(m.singular({ t }, 'status'), 'Status');
});

test('a record title is its label fields by kind; a target without a readable label is a dash, never its id', () => {
	const fields = { code: { kind: 'text' }, due_on: { kind: 'date' }, status: { kind: 'enum', values: ['on_hold'] } };
	assert.equal(k.fieldsText(fields, { code: 'Q-1', due_on: '2026-01-02', status: 'on_hold' }, ['code', 'due_on', 'status'], { locale: 'en-US' }), 'Q-1 · Jan 2, 2026 · On hold');
	const cat = { jobs: { label: ['title'], fields: { title: { kind: 'text' } }, relations: { account: { targets: ['accounts'] } } }, accounts: { label: ['name'], fields: { name: { kind: 'text' } } } };
	const [r] = m.unref(cat, 'jobs', ['account'], [{ id: 'j1', account: { id: 'a1', name: null } }]);
	assert.equal(r.$refs.account.text, '—');
});

test('CSV cells: enum words, ISO dates and instants, relation labels', () => {
	const row = { status: 'on_hold', due_on: '2026-01-02', at: '2026-01-02T03:04:05.000Z', tags: ['a_b'], n: 3, $refs: { account: { of: 'accounts', text: 'Acme' } } };
	const words = (v) => k.enumText(v);
	assert.equal(m.csvCell(row, 'status', { kind: 'state', initial: 'on_hold', states: {} }, words), 'On hold');
	assert.equal(m.csvCell(row, 'tags', { kind: 'enum', values: ['a_b'], many: true }, words), 'A b');
	assert.equal(m.csvCell(row, 'due_on', { kind: 'date' }, words), '2026-01-02');
	assert.equal(m.csvCell(row, 'at', { kind: 'instant' }, words), '2026-01-02T03:04:05.000Z');
	assert.equal(m.csvCell(row, 'account', undefined, words), 'Acme');
	assert.equal(m.CSV_BOM, '﻿');
});

test('search falls back to the label text fields', () => {
	const target = { label: ['code', 'name'], fields: { code: { kind: 'seq' }, name: { kind: 'text' } } };
	assert.deepEqual(k.likeWhere(target, ['code', 'name'], ' ac%'), { or: [{ name: { like: '%ac\\%%' } }] });
	assert.equal(k.likeWhere(target, ['code'], 'x'), undefined);
});

test('a final state has no moves: the state field is locked', () => {
	const fields = { status: { kind: 'state', initial: 'open', states: { open: { to: ['won'] }, won: {} } }, note: { kind: 'text' } };
	assert.equal(d.locked(fields, { status: 'open' })('status'), false);
	assert.equal(d.locked(fields, { status: 'won' })('status'), true);
	assert.equal(d.locked(fields, { status: 'won' })('note'), false);
});

// ── mounted ──
const q = (m, a, v) => ({ read: { m, a }, then: (ok, bad) => Promise.resolve(v).then(ok, bad) });
function fake(rows, extra = {}) {
	const reads = [];
	const bolt = {
		t: (key) => key, locale: 'en', actor: null,
		read: (c, o) => { reads.push({ c, o }); return q('read', [c, o], { rows, next: null }); },
		get: (c, id) => q('get', [c, id], rows.find((r) => r.id === id) ?? null),
		aggregate: () => q('aggregate', [], [{ count: rows.length }]),
		history: () => q('history', [], { rows: [], next: null }),
		live: (x) => ({ current: undefined, error: undefined, subscribe(run) { Promise.resolve(x).then(run); return () => {}; } }),
		act: async () => ({ kind: 'committed', output: null, records: [] }),
		fileUrl: () => '', approvals: {},
		...extra,
	};
	return { bolt, reads };
}
const settle = async () => { for (let i = 0; i < 5; i++) { flushSync(); await tick(); await new Promise((r) => setTimeout(r, 0)); } flushSync(); };
const mounted = [];
test.afterEach(() => { while (mounted.length > 0) mounted.pop()(); });
async function show(part, props, bolt, catalog = {}) {
	history.replaceState(null, '', '/');
	const target = document.createElement('div');
	document.body.append(target);
	const app = mount(Harness, { target, props: { bolt, catalog, part, props } });
	await settle();
	mounted.push(() => { unmount(app); target.remove(); });
	return target;
}
const records = () => new URL(location.href).searchParams.getAll('record');

const jobs = {
	jobs: {
		label: ['title'],
		fields: {
			title: { kind: 'text' }, kind: { kind: 'enum', values: ['on_site', 'remote'] }, due_on: { kind: 'date', optional: true },
			status: { kind: 'state', initial: 'open', states: { open: { to: ['won'] }, won: {} } }, notes: { kind: 'text', format: 'markdown', optional: true },
		},
		relations: { account_id: { targets: ['accounts'], optional: true } },
		update: { columns: ['title', 'status'] },
	},
	accounts: { label: ['name'], fields: { name: { kind: 'text' } } },
};
const ROW = { id: 'j1', revision: 1, title: 'Paint', kind: 'on_site', due_on: '2026-01-02', status: 'open', notes: '**bold**', account_id: null };

test('Table: a row click opens its record; links, buttons and selected text do not; Enter opens a focused row', async () => {
	const { bolt } = fake([ROW]);
	const t = await show('table', { of: 'jobs', columns: ['title', 'kind'] }, bolt, jobs);
	const tr = t.querySelector('[data-table-wide] tbody tr:not([aria-hidden])');
	tr.querySelector('td').click();
	assert.deepEqual(records(), ['jobs/j1']);
	history.replaceState(null, '', '/');
	tr.querySelector('[data-row-open]').click();
	assert.deepEqual(records(), ['jobs/j1'], 'the hover button still opens');
	history.replaceState(null, '', '/');
	const link = document.createElement('a');
	tr.querySelector('td div').append(link);
	link.click();
	assert.deepEqual(records(), []);
	tr.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
	assert.deepEqual(records(), ['jobs/j1']);
	assert.equal(tr.tabIndex, 0);
});

test('Table: an enum is a neutral chip in words, a state a coloured badge; a FK column is named by its target', async () => {
	const { bolt } = fake([ROW]);
	const t = await show('table', { of: 'jobs', columns: ['title', 'kind', 'status', 'account_id'] }, bolt, jobs);
	const chip = t.querySelector('[data-table-wide] [data-enum-value=on_site]');
	assert.equal(chip?.textContent.trim(), 'On site');
	assert.ok(t.querySelector('[data-table-wide] [data-state-value=open]'));
	const heads = [...t.querySelectorAll('[data-table-wide] th[data-column]')].map((th) => th.textContent.trim());
	assert.ok(heads.includes('Account'), heads.join());
});

test('Table: search falls back to the label fields; the empty text keeps the label\'s case', async () => {
	const { bolt, reads } = fake([], { t: (key) => key === 'models.sow_documents.label' ? 'SOW documents' : key });
	const cat = { sow_documents: { label: ['title'], fields: { title: { kind: 'text' } } } };
	const t = await show('table', { of: 'sow_documents', columns: ['title'] }, bolt, cat);
	assert.match(t.textContent, /No SOW documents yet/);
	t.querySelector('[data-search-toggle]').click();
	await settle();
	const box = document.querySelector('[data-search]');
	assert.ok(box, 'a search box');
	assert.match(document.querySelector('[data-search-fields]')?.textContent ?? '', /Title/);
	box.value = 'acme';
	box.dispatchEvent(new Event('input', { bubbles: true }));
	await new Promise((r) => setTimeout(r, 350));
	await settle();
	const last = reads.filter((r) => r.c === 'sow_documents').at(-1).o;
	assert.equal(last.search, undefined);
	assert.deepEqual(last.where, { or: [{ title: { like: '%acme%' } }] });
});

test('record sheet: titled by the record, the singular model above; a subtitle of fields by kind; no id, no "by —"', async () => {
	const { bolt } = fake([{ ...ROW, account_id: 'a9', created_at: '2026-01-02T03:04:05.000Z', created_by: 'u1' }], { get: (c, id) => q('get', [c, id], c === 'jobs' ? { ...ROW, account_id: 'a9', created_at: '2026-01-02T03:04:05.000Z', created_by: 'u1' } : null) });
	const t = await show('record', { of: 'jobs', id: 'j1', subtitle: ['kind', 'due_on'] }, bolt, jobs);
	const head = document.querySelector('[role=dialog] [data-record-head]');
	assert.equal(head.querySelector('h2').textContent.trim(), 'Paint');
	assert.match(head.textContent, /Job/);
	assert.match(head.textContent, /On site · Jan 2, 2026/);
	const account = document.querySelector('[data-field=account_id]');
	assert.match(account.textContent, /Account/);
	assert.doesNotMatch(account.textContent, /a9/);
	assert.match(account.textContent, /—/);
	const info = document.querySelector('[data-record-info]').textContent;
	assert.match(info, /Created/);
	assert.doesNotMatch(info, /by/);
	assert.ok(document.querySelector('[data-field=notes] [data-markdown] strong'), 'markdown reads as prose');
	void t;
});

test('record sheet: an explicit title and subtitle still win', async () => {
	const { bolt } = fake([ROW]);
	await show('record', { of: 'jobs', id: 'j1', title: 'Custom', subtitle: 'Line' }, bolt, jobs);
	const head = document.querySelector('[role=dialog] [data-record-head]');
	assert.equal(head.querySelector('h2').textContent.trim(), 'Custom');
	assert.match(head.textContent, /Line/);
});

test('an empty relation reads as a dash', async () => {
	const { bolt } = fake([ROW]);
	await show('record', { of: 'jobs', id: 'j1' }, bolt, jobs);
	assert.match(document.querySelector('[data-field=account_id]').textContent, /—/);
});

test('a record in a final state: its state is read-only and there is no Save', async () => {
	const { bolt } = fake([]);
	const won = { ...ROW, status: 'won' };
	const cat = { jobs: { ...jobs.jobs, update: { columns: ['status'] } } };
	const t = await show('form', { of: 'jobs', mode: 'update', id: 'j1', record: won }, bolt, cat);
	assert.ok(t.querySelector('[data-field=status][data-readonly]'));
	assert.equal(t.querySelectorAll('button[type=submit]').length, 0);
});

test('CustomView: no rows is the kit\'s empty state', async () => {
	const { bolt } = fake([]);
	const t = await show('custom', { of: [], fields: ['title'], key: 'x' }, bolt);
	assert.ok(t.querySelector('[data-read=empty]'));
	assert.equal(t.querySelector('[data-custom-rows]'), null);
	const some = await show('custom', { of: [{ title: 'a' }], fields: ['title'], key: 'y' }, bolt);
	assert.equal(some.querySelector('[data-custom-rows]').textContent, '1');
});

test('Runs tab: one "No runs yet" only when no automation has runs; runs named by title, not key', async () => {
	const run = { id: 'r1', automation: 'jobs.send_pdf', status: 'succeeded' };
	const live = (v) => ({ current: v, error: undefined, subscribe(f) { f(v); return () => {}; } });
	const { bolt } = fake([ROW], { runs: (a) => live({ rows: a === 'jobs.send_pdf' ? [run] : [], next: null }) });
	await show('record', { of: 'jobs', id: 'j1', runs: [{ automation: 'jobs.send_pdf', title: 'Send the PDF' }, { automation: 'jobs.reindex' }] }, bolt, jobs);
	[...document.querySelectorAll('[role=tab]')].find((x) => /Runs/.test(x.textContent)).click();
	await settle();
	const body = document.querySelector('[role=dialog]').textContent;
	assert.doesNotMatch(body, /No runs yet/);
	assert.match(body, /Send the PDF/);
	assert.doesNotMatch(body, /jobs\.send_pdf/);
});

test('ReadonlyMarkdown passes attributes through; the index exports the helpers', async () => {
	const { bolt } = fake([]);
	const t = await show('markdown', {}, bolt);
	assert.ok(t.querySelector('[data-probe=md] strong'));
	const ui = await import(String(new URL('../src/index.ts', import.meta.url))); // not a literal: tsc would typecheck every .svelte export
	for (const name of ['format', 'enumText', 'markdownHtml', 'EmptyState', 'label', 'singular', 'TAB_LEVEL']) assert.ok(name in ui, name);
	assert.equal(ui.TAB_LEVEL, Symbol.for('norbital.ui.tabs.level'));
});
