// @ts-nocheck -- executed directly by Node with --experimental-strip-types.
// The view popover (rule 16b, P34): typed rows that lower to a decodable `Where`, strict URL state, one combined
// filter-and-sort popover on Table and Board, and one header in a record sheet.
import './dom.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { fromWhere, likeOf, orderKeys, orderOf, orderText, parseOrder, sortable, sortRows, toWhere } from '../src/views/filter.ts';
import { listSelect, MANY_SHOWN, unref } from '../src/views/model.ts';
const { flushSync, mount, tick, unmount } = await import('svelte');
const { default: Harness } = await import('./view-harness.svelte');

const catalog = {
	jobs: {
		label: ['title'],
		fields: {
			title: { kind: 'text' }, hours: { kind: 'number', optional: true }, scheduled_on: { kind: 'date', optional: true },
			status: { kind: 'state', initial: 'scheduled', states: { scheduled: { to: ['done'] }, done: {} } },
			tags: { kind: 'text', many: true }, meta: { kind: 'json', optional: true }, window: { kind: 'period', of: 'date', optional: true },
			salary: { kind: 'money' },
		},
		relations: { assignee: { targets: ['sys_user'], optional: true }, account: { targets: ['accounts'] }, subject: { targets: ['accounts', 'sys_user'] } },
		many: ['lines'],
		masked: ['salary'],
	},
	accounts: { label: ['name'], fields: { name: { kind: 'text' } }, relations: { owner: { targets: ['sys_user'] } } },
	sys_user: { label: ['name'], fields: { name: { kind: 'text' } } },
	job_lines: { label: [], fields: { qty: { kind: 'int' }, amount: { kind: 'money' } }, relations: { job: { targets: ['jobs'], inverse: 'lines' } } },
};
const cond = (path, op, arg = null) => ({ t: 'cond', path, op, arg });

test('every grammar element is a row that lowers to a Where and parses back to the same row', () => {
	const rows = [
		cond('title', 'like', { lit: 'a_b%' }),
		cond('status', 'in', { list: ['scheduled', 'done'] }),
		cond('assignee', 'eq', { lit: 'u1' }),
		cond('assignee', 'eq', { actor: 'id' }),
		cond('assignee', 'isNull'),
		cond('account.owner.name', 'like', { lit: 'bo' }),
		cond('subject:accounts', 'in', { list: ['a1', 'a2'] }),
		cond('scheduled_on', 'during', { range: [{ startOf: 'week' }, { startOf: 'week', shift: 1 }] }),
		cond('scheduled_on', 'during', { range: [{ today: '-7d' }, { today: '+1d' }] }),
		cond('scheduled_on', 'gte', { startOf: 'month', shift: -1 }),
		cond('scheduled_on', 'lt', { today: '-7d' }),
		cond('tags', 'hasAll', { list: ['a', 'b'] }),
		cond('meta', 'contains', { lit: { a: 1 } }),
		cond('window', 'contains', { today: '' }),
		{ t: 'many', rel: 'lines', q: 'some', of: [cond('qty', 'gt', { lit: 2 })] },
		{ t: 'many', rel: 'lines', q: 'none', of: [] },
		{ t: 'many', rel: 'lines', q: 'count', of: [], op: 'gte', n: 3 },
		{ t: 'many', rel: 'lines', q: 'sum', of: [], op: 'gt', n: 100, field: 'amount' },
		{ t: 'group', join: 'or', of: [cond('hours', 'gt', { lit: 3 }), cond('status', 'eq', { lit: 'done' })] },
		{ t: 'group', join: 'and', not: true, of: [cond('title', 'like', { lit: 'x' })] },
	];
	for (const n of rows) {
		const w = toWhere(catalog, 'jobs', n);
		assert.ok(w !== null, JSON.stringify(n));
		assert.deepEqual(fromWhere(catalog, 'jobs', JSON.parse(JSON.stringify(w))), [n], JSON.stringify(w));
	}
	// the shapes decode expects: escaped like, a record in the `is` form, an actor on the FK, calendar bounds, two hops
	assert.equal(likeOf('a_b%\\'), '%a\\_b\\%\\\\%');
	assert.deepEqual(toWhere(catalog, 'jobs', rows[2]), { assignee: { is: { id: { eq: 'u1' } } } });
	assert.deepEqual(toWhere(catalog, 'jobs', rows[3]), { assignee: { eq: { actor: 'id' } } });
	assert.deepEqual(toWhere(catalog, 'jobs', rows[6]), { subject: { accounts: { is: { id: { in: ['a1', 'a2'] } } } } });
	assert.deepEqual(toWhere(catalog, 'jobs', rows[7]), { scheduled_on: { gte: { startOf: 'week' }, lt: { startOf: 'week', shift: 1 } } });
	assert.deepEqual(toWhere(catalog, 'jobs', rows[5]), { account: { is: { owner: { is: { name: { like: '%bo%' } } } } } });
	assert.deepEqual(toWhere(catalog, 'jobs', rows[17]), { lines: { sum: { of: 'amount', gt: 100 } } });
	// an incomplete row is shown but not sent; a masked field, an unknown one and a wrong-kind literal never parse
	assert.equal(toWhere(catalog, 'jobs', cond('title', 'eq')), null);
	for (const bad of [{ salary: { gt: 1 } }, { bogus: { eq: 1 } }, { hours: { eq: 'abc' } }, { status: { eq: 'nope' } }, { status: {} }, { not: {} }, { hours: { isNull: 'yes' } }])
		assert.equal(fromWhere(catalog, 'jobs', bad), null, JSON.stringify(bad));
});

test('sort: nulls last ascending and first descending', () => {
	const rows = [{ id: 'a', n: 2 }, { id: 'b', n: null }, { id: 'c', n: 1 }];
	assert.deepEqual(sortRows(rows, [{ field: 'n', dir: 'asc' }]).map((r) => r.id), ['c', 'a', 'b']);
	assert.deepEqual(sortRows(rows, [{ field: 'n', dir: 'desc' }]).map((r) => r.id), ['b', 'a', 'c']);
});

test('sort: related keys — one hop through unmasked one-relations into read collections; keys nest, and round-trip through the URL', () => {
	const s = sortable(catalog.jobs, true, catalog);
	assert.ok(s.includes('account.name') && s.includes('assignee.name'), s.join());
	assert.ok(!s.includes('account.owner'), 'a target FK is no sort key'); // it would order by an id
	assert.ok(!s.some((f) => f.startsWith('subject')), 'an arc is no hop');
	assert.ok(!sortable({ ...catalog.jobs, masked: ['account'] }, true, catalog).includes('account.name'), 'a masked FK is no hop');
	assert.ok(!sortable(catalog.jobs, true).some((f) => f.includes('.')), 'no catalog, no related keys');
	const keys = [{ field: 'account.name', dir: 'desc' }, { field: 'title', dir: 'asc' }];
	assert.deepEqual(orderOf(keys), [{ account: { name: 'desc' } }, { title: 'asc' }]);
	assert.deepEqual(orderKeys(orderOf(keys)), keys);
	assert.equal(orderText(keys), 'account.name:desc,title:asc');
	assert.deepEqual(parseOrder(orderText(keys), s), { keys, dropped: 0 });
	assert.deepEqual(parseOrder('account.secret:asc', s), { keys: [], dropped: 1 });
	const rows = [{ id: 'a', account: { name: 'b' } }, { id: 'b', account: { name: 'a' } }, { id: 'c', account: null }];
	assert.deepEqual(sortRows(rows, [{ field: 'account.name', dir: 'asc' }]).map((r) => r.id), ['b', 'a', 'c']);
});

// ── mounted views over a scripted bolt ──
/** The condition catalogue the scripted host serves (`filter.options`), for the fixture catalog above. */
const offers = (c) => c !== 'jobs' ? [] : [
	{ label: 'Title', path: [{ k: 'field', name: 'title' }], op: 'like', opLabel: 'contains', kind: 'text' },
	{ label: 'Title', path: [{ k: 'field', name: 'title' }], op: 'eq', opLabel: 'is', kind: 'text' },
	{ label: 'Hours', path: [{ k: 'field', name: 'hours' }], op: 'eq', opLabel: 'is', kind: 'number' },
	{ label: 'Hours', path: [{ k: 'field', name: 'hours' }], op: 'gt', opLabel: 'more than', kind: 'number' },
	{ label: 'Scheduled on', path: [{ k: 'field', name: 'scheduled_on' }], op: 'during', opLabel: 'is within', kind: 'date',
		values: [{ label: 'this week', arg: { range: [{ startOf: 'week' }, { startOf: 'week', shift: 1 }] } }] },
	{ label: 'Status', path: [{ k: 'field', name: 'status' }], op: 'eq', opLabel: 'is', kind: 'state' },
	{ label: 'Status', path: [{ k: 'field', name: 'status' }], op: 'in', opLabel: 'is any of', kind: 'state' },
	{ label: 'Tags', path: [{ k: 'field', name: 'tags' }], op: 'hasAll', opLabel: 'has all of', kind: 'text' },
	{ label: 'Tags', path: [{ k: 'field', name: 'tags' }], op: 'isEmpty', opLabel: 'is empty', kind: 'text' },
	{ label: 'Assignee', path: [{ k: 'field', name: 'assignee' }], op: 'eq', opLabel: 'is', kind: 'record' },
	{ label: 'Assignee › Name', path: [{ k: 'is', rel: 'assignee' }, { k: 'field', name: 'name' }], op: 'like', opLabel: 'contains', kind: 'text' },
	{ label: 'Lines (any) › Qty', path: [{ k: 'some', rel: 'lines' }, { k: 'field', name: 'qty' }], op: 'eq', opLabel: 'is', kind: 'int' },
	{ label: 'Lines (any) › Qty', path: [{ k: 'some', rel: 'lines' }, { k: 'field', name: 'qty' }], op: 'gt', opLabel: 'more than', kind: 'int' },
	{ label: 'Lines (all) › Qty', path: [{ k: 'every', rel: 'lines' }, { k: 'field', name: 'qty' }], op: 'gt', opLabel: 'more than', kind: 'int' },
	{ label: 'Lines (none) › Qty', path: [{ k: 'none', rel: 'lines' }, { k: 'field', name: 'qty' }], op: 'gt', opLabel: 'more than', kind: 'int' },
	{ label: 'Lines › count', path: [{ k: 'count', rel: 'lines' }], op: 'eq', opLabel: 'is', kind: 'count' },
	{ label: 'Lines › count', path: [{ k: 'count', rel: 'lines' }], op: 'gte', opLabel: 'at least', kind: 'count' },
	{ label: 'Lines › total amount', path: [{ k: 'agg', rel: 'lines', fn: 'sum', of: 'amount' }], op: 'gt', opLabel: 'more than', kind: 'money' },
];
function scripted(extra = {}) {
	const reads = [];
	const q = (m, a, value) => ({ read: { m, a }, then: (ok, bad) => Promise.resolve(value).then(ok, bad) });
	const rows = [{ id: 'j1', title: 'One', hours: 2, status: 'done' }];
	const bolt = {
		read: (c, o) => { reads.push({ c, o }); return q('read', [c, o], { rows, next: null }); },
		get: (c, id) => q('get', [c, id], { id, title: 'One', status: 'done' }),
		aggregate: (c, o) => q('aggregate', [c, o], o.by ? { rows: [{ key: { status: 'scheduled' }, count: 0 }, { key: { status: 'done' }, count: 1 }], next: null } : [{ count: 1 }]),
		live: (qq) => ({ current: undefined, error: undefined, subscribe(run) { Promise.resolve(qq).then(run); return () => {}; } }),
		history: (c, id) => q('history', [c, id], { rows: [], next: null }),
		act: async () => ({ kind: 'committed', output: null, records: [] }),
		options: async (c) => ({ fields: offers(c) }),
		fileUrl: () => '', actor: null, locale: 'en', t: (k) => k, approvals: {},
		...extra,
	};
	return { bolt, reads, last: () => reads.filter((r) => r.c === 'jobs').at(-1)?.o };
}
async function show(part, props, bolt, url = '/', cat = catalog) {
	history.replaceState(null, '', url);
	const target = document.createElement('div');
	document.body.append(target);
	const app = mount(Harness, { target, props: { bolt, catalog: cat, part, props } });
	flushSync();
	for (let i = 0; i < 3; i++) { await tick(); await new Promise((r) => setTimeout(r, 0)); flushSync(); }
	return { target, done: () => (unmount(app), target.remove()) };
}
const settle = async () => { for (let i = 0; i < 3; i++) { await tick(); await new Promise((r) => setTimeout(r, 0)); flushSync(); } };
const bad = encodeURIComponent(JSON.stringify({ and: [{ status: { eq: 'done' } }, { bogus: { eq: 1 } }, { hours: { eq: 'abc' } }] }));

test('Table: a link with bad clauses and keys drops them with one notice and applies the rest, never an error state', async () => {
	const s = scripted();
	const v = await show('table', { of: 'jobs', columns: ['title', 'hours'] }, s.bolt, `/?jobs.where=${bad}&jobs.order=hours:desc,meta:asc`);
	assert.deepEqual(s.last().where, { status: { eq: 'done' } });
	assert.deepEqual(s.last().orderBy, [{ hours: 'desc' }]);
	assert.equal(document.querySelectorAll('[data-view-notice]').length, 1);
	assert.equal(document.querySelector('[data-read=error]'), null);
	assert.ok(document.querySelector('tbody tr'), 'the rows still render');
	v.done();
});

test('Table: one sliders popover; by default only the describe input, the builder hidden behind a quiet "Edit conditions"', async () => {
	const s = scripted({ describe: async () => ({ where: { status: { eq: 'done' } }, orderBy: { created_at: 'desc' } }) });
	const v = await show('table', { of: 'jobs', columns: ['title', 'hours'], where: { hours: { gt: 1 } } }, s.bolt);
	assert.equal(document.querySelectorAll('[data-view-trigger]').length, 1);
	assert.ok(document.querySelector('[data-view-trigger] [data-icon=sliders]'));
	document.querySelector('[data-view-trigger]').click();
	flushSync();
	const header = document.querySelector('[data-view-header]');
	assert.ok(header.querySelector('[data-describe] input[placeholder="Describe what to show…"]'));
	// the default state: nothing but the input and the quiet reveal — no builder, no Clear all, no author scope
	assert.equal(document.querySelector('[data-view-details]').open, false);
	assert.equal(document.querySelector('[data-clear]'), null);
	assert.ok(document.querySelector('[data-view-details]'), 'manual conditions are an accordion');
	document.querySelector('[data-show-builder]').click();
	flushSync();
	assert.equal(document.querySelector('[data-view-details]').open, true);
	assert.ok(document.querySelector('[data-view-builder] [data-add-condition]'));
	assert.match(document.querySelector('[data-author-where]').textContent, /Hours before|Hours after|Hours/);
	assert.equal(document.querySelector('[data-author-where] [data-remove]'), null, 'the author scope has no remove');
	// the description becomes editable rows and a sort, ANDed under the author's where
	header.querySelector('[data-describe] input').value = 'done ones, newest first';
	header.querySelector('[data-describe] input').dispatchEvent(new Event('input', { bubbles: true }));
	header.querySelector('[data-describe]').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
	await settle();
	assert.deepEqual(s.last().where, { and: [{ hours: { gt: 1 } }, { status: { eq: 'done' } }] });
	assert.deepEqual(s.last().orderBy, [{ created_at: 'desc' }]);
	assert.ok(document.querySelector('[data-view-applied]'));
	assert.equal(document.querySelectorAll('[data-filter-rows] [data-cond="status"]').length, 1);
	assert.ok(document.querySelector('[data-clear]'), 'conditions exist: Clear all shows');
	// reopened with conditions, the manual accordion is collapsed until requested
	document.querySelector('[data-view-trigger]').click(); flushSync();
	document.querySelector('[data-view-trigger]').click(); flushSync();
	assert.equal(document.querySelector('[data-view-details]').open, false);
	v.done();
});

test('Table: a described relation filter and sort are editable rows ANDed under the author where (rule 16a)', async () => {
	const s = scripted({ describe: async () => ({ where: { and: [{ lines: { some: { qty: { gt: 2 } } } }, { account: { is: { name: { like: '%acme%' } } } }] }, orderBy: { hours: 'desc' } }) });
	const v = await show('table', { of: 'jobs', columns: ['title', 'hours'], where: { status: { eq: 'done' } } }, s.bolt);
	document.querySelector('[data-view-trigger]').click();
	flushSync();
	const form = document.querySelector('[data-describe]');
	form.querySelector('input').value = 'acme jobs with more than 2 of a line, most hours first';
	form.querySelector('input').dispatchEvent(new Event('input', { bubbles: true }));
	form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
	await settle();
	assert.deepEqual(s.last().where, { and: [{ status: { eq: 'done' } }, { and: [{ lines: { some: { qty: { gt: 2 } } } }, { account: { is: { name: { like: '%acme%' } } } }] }] });
	assert.deepEqual(s.last().orderBy, [{ hours: 'desc' }]);
	assert.ok(document.querySelector('[data-filter-rows] [data-many=lines]'), 'the relation group is a row the viewer edits');
	v.done();
});

test('a local array offers its fields to System 1 and keeps manual controls collapsed', async () => {
	let input;
	const s = scripted({ describe: async (collection, text, fields) => {
		input = { collection, text, fields };
		return { where: { number: { gt: 20 } }, orderBy: { name: 'asc' } };
	} });
	const v = await show('table', { of: [{ id: 'a', number: 10, name: 'Amy' }, { id: 'b', number: 30, name: 'Bea' }], columns: ['number', 'name'] }, s.bolt);
	document.querySelector('[data-view-trigger]').click(); flushSync();
	assert.ok(document.querySelector('[data-describe]'));
	assert.equal(document.querySelector('[data-view-details]').open, false);
	const form = document.querySelector('[data-describe]');
	form.querySelector('input').value = 'number above 20, sorted by name';
	form.querySelector('input').dispatchEvent(new Event('input', { bubbles: true }));
	form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
	await settle();
	assert.equal(input.collection, '$local');
	assert.deepEqual(input.fields.map((f) => f.name), ['number', 'name']);
	assert.ok(document.querySelector('[data-view-applied]'));
	assert.equal(document.querySelector('[data-view-details]').open, false);
	v.done();
});

test('Table: a 200-row page renders a window of rows between two spacers in both layouts, keyed by id', async () => {
	const rows = Array.from({ length: 200 }, (_, i) => ({ id: `r${i}`, title: `Row ${i}` }));
	const v = await show('table', { of: rows, columns: ['title'] }, scripted().bolt);
	const wide = document.querySelectorAll('[data-table-wide] tbody tr:not([aria-hidden])');
	const narrow = document.querySelectorAll('[data-table-list] li:not([aria-hidden])');
	assert.ok(wide.length > 0 && wide.length < 200, `wide: ${wide.length} rows mounted`);
	assert.ok(narrow.length > 0 && narrow.length < 200, `narrow: ${narrow.length} rows mounted`);
	assert.match(wide[0].textContent, /Row 0/);
	assert.ok(document.querySelector('[data-table-wide] tbody tr[aria-hidden]'), 'a spacer holds the unmounted rows\' height');
	v.done();
});

test('Table: a related-records row is built in the popover: relation ▸ quantifier, nested conditions indented under it', async () => {
	const s = scripted();
	const v = await show('table', { of: 'jobs', columns: ['title'] }, s.bolt);
	const $ = (sel) => document.querySelector(sel);
	// a Combobox: open its trigger, click the option; the list is portalled to the body
	const pick = async (trigger, value) => { trigger.click(); flushSync(); await tick(); document.querySelector(`[role=option][data-value="${value}"] button`).click(); flushSync(); };
	$('[data-view-trigger]').click(); flushSync();
	$('[data-add-condition]').click(); flushSync();
	$('[data-filter-rows] [data-field-picker]').click(); flushSync();
	assert.equal($('[data-field-list] [data-path=salary]'), null, 'a masked field is never offered');
	$('[data-field-list] [data-path=lines]').click(); flushSync();
	const row = $('[data-many=lines]');
	assert.ok(row);
	assert.equal(row.querySelectorAll(':scope > div:first-child [data-field-picker]').length, 1, 'one compact row');
	row.querySelector('[data-add-nested]').click(); flushSync();
	row.querySelector('[data-nested] [data-field-picker]').click(); flushSync();
	row.querySelector('[data-nested] [data-path=qty]').click(); flushSync();
	await pick(row.querySelector('[data-nested] [data-cond=qty] [role=combobox]'), 'gt');
	const input = row.querySelector('[data-nested] [data-cond=qty] input');
	input.value = '2'; input.dispatchEvent(new Event('input', { bubbles: true })); await settle();
	assert.deepEqual(s.last().where, { lines: { some: { qty: { gt: 2 } } } });
	await pick(row.querySelector('[role=combobox][aria-label=Quantifier]'), 'count'); await settle();
	assert.equal(row.querySelector('[data-nested]'), null, 'count has no nested rows');
	v.done();
});

test('Table: a header never sorts; its menu moves and hides the column, kept per table; a row opens only by its open button', async () => {
	const s = scripted();
	localStorage.removeItem('ui.table.jobs');
	const v = await show('table', { of: 'jobs', columns: ['title', 'hours'], orderBy: { title: 'asc' } }, s.bolt);
	const heads = () => [...document.querySelectorAll('[data-table-wide] th[data-column]')].map((th) => th.dataset.column);
	assert.equal(document.querySelector('[data-sort-header]'), null, 'sorting is the toolbar popover\'s');
	const item = (text) => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === text);
	document.querySelector('[data-column-menu=hours]').click(); flushSync();
	item('Move left').click(); flushSync();
	assert.deepEqual(heads(), ['hours', 'title']);
	document.querySelector('[data-column-menu=title]').click(); flushSync();
	item('Hide column').click(); flushSync();
	assert.deepEqual(heads(), ['hours']);
	assert.deepEqual(JSON.parse(localStorage.getItem('ui.table.jobs')).hidden, ['title']);
	v.done();
	localStorage.removeItem('ui.table.jobs'); // later tables start from the default layout
});

test('Table: initialFilter seeds clearable rows, and a cleared choice survives a reload', async () => {
	const s = scripted();
	const props = { of: 'jobs', columns: ['title'], initialFilter: { status: { eq: 'scheduled' } } };
	let v = await show('table', props, s.bolt);
	assert.deepEqual(s.last().where, { status: { eq: 'scheduled' } });
	document.querySelector('[data-view-trigger]').click(); flushSync();
	document.querySelector('[data-clear]').click(); await settle();
	assert.equal(s.last().where, undefined);
	const url = location.pathname + location.search;
	assert.match(url, /jobs\.where=%7B%7D/);
	v.done();
	v = await show('table', props, s.bolt, url);
	assert.equal(s.last().where, undefined);
	v.done();
});

test('Table: a relative-date filter stays live with a refresh, as the hub requires of a clock read (rule 64)', async () => {
	const lives = [];
	const s = scripted();
	const live = s.bolt.live;
	s.bolt.live = (qq, o) => { lives.push({ read: qq.read, o }); return live(qq, o); };
	const w = encodeURIComponent(JSON.stringify({ scheduled_on: { gte: { today: '-6d' }, lt: { today: '+1d' } } }));
	const v = await show('table', { of: 'jobs', columns: ['title'] }, s.bolt, `/?jobs.where=${w}`);
	const clock = lives.filter((l) => JSON.stringify(l.read).includes('today'));
	assert.ok(clock.length > 0);
	for (const l of clock) assert.match(l.o?.every ?? '', /^\d+(s|min|h|d)$/, JSON.stringify(l.o)); // the hub's duration form
	v.done();
});

test('Board: the viewer sort orders the cards within each lane and the lanes keep their order', async () => {
	const s = scripted();
	const v = await show('board', { of: 'jobs', by: 'status', card: ['title'] }, s.bolt, '/?jobs.order=hours:desc');
	const lanes = [...document.querySelectorAll('[data-lane]')].map((l) => l.getAttribute('data-lane'));
	assert.deepEqual(lanes, ['"scheduled"', '"done"']);
	const laneReads = s.reads.filter((r) => r.c === 'jobs');
	assert.ok(laneReads.length >= 2);
	for (const r of laneReads) assert.deepEqual(r.o.orderBy, [{ hours: 'desc' }]);
	assert.equal(document.querySelectorAll('[data-view-trigger]').length, 1);
	v.done();
});

test('record sheet: one header, titled with the collection label', async () => {
	const s = scripted();
	const v = await show('record', { of: 'jobs', id: 'j1' }, s.bolt);
	const dialog = document.querySelector('[role=dialog]');
	assert.equal(dialog.querySelectorAll('h2').length, 1);
	assert.equal(dialog.querySelector('h2').textContent, 'Jobs');
	assert.ok(dialog.querySelector('header [data-record-head]'), 'the record head is the sheet header');
	v.done();
});

// ── lists: relation labels in the same read, the default and a custom cell, lanes that load as they scroll ──
const relCatalog = {
	jobs: { label: ['title'], fields: { title: { kind: 'text' }, done: { kind: 'bool' } }, relations: { account: { targets: ['accounts'] } }, many: ['lines'] },
	accounts: { label: ['name'], fields: { name: { kind: 'text' } } },
	job_lines: { label: ['name'], fields: { name: { kind: 'text' } }, relations: { job: { targets: ['jobs'], inverse: 'lines' } } },
};
const relRows = [{ id: 'j1', title: 'One', done: true, account: { id: 'a1', name: 'Acme' },
	lines: [{ id: 'l1', name: 'Pipe' }, { id: 'l2', name: 'Valve' }, { id: 'l3', name: 'Seal' }] }];

test('listSelect/unref: a one- and a many-relation read their labels in the one statement; the row keeps ids and $refs', () => {
	assert.deepEqual(listSelect(relCatalog, 'jobs', ['title', 'account', 'lines']), {
		title: true, done: true, account: { select: { name: true } }, lines: { select: { name: true }, limit: MANY_SHOWN + 1 } });
	const [r] = unref(relCatalog, 'jobs', ['account', 'lines'], relRows);
	assert.equal(r.account, 'a1');
	assert.deepEqual(r.lines, ['l1', 'l2', 'l3']);
	assert.deepEqual(r.$refs.account, { of: 'accounts', text: 'Acme' });
	assert.deepEqual(r.$refs.lines.items.map((i) => i.text), ['Pipe', 'Valve', 'Seal']);
	assert.equal(r.$refs.lines.of, 'job_lines');
	const many = unref(relCatalog, 'jobs', ['lines'], [{ id: 'j2', lines: Array.from({ length: MANY_SHOWN + 1 }, (_, i) => ({ id: `l${i}`, name: `L${i}` })) }])[0];
	assert.equal(many.$refs.lines.items.length, MANY_SHOWN);
	assert.equal(many.$refs.lines.more, true);
});

test('Table: a relation cell shows the label with a single- or multi-link glyph, never an id; a label opens that record', async () => {
	const s = scripted({ read: (c, o) => { s.reads.push({ c, o }); return { read: { m: 'read', a: [c, o] }, then: (ok, bad) => Promise.resolve({ rows: relRows, next: null }).then(ok, bad) }; } });
	const v = await show('table', { of: 'jobs', columns: ['title', 'account', 'lines'] }, s.bolt, '/', relCatalog);
	assert.equal(s.reads.filter((r) => r.c !== 'jobs').length, 0, 'no read per related record');
	assert.deepEqual(s.last().select.lines, { select: { name: true }, limit: MANY_SHOWN + 1 });
	const row = document.querySelector('[data-table-wide] tbody tr:not([aria-hidden])');
	const one = row.querySelector('[data-ref=one]');
	assert.ok(one.querySelector('[data-icon=link]'));
	assert.equal(one.textContent.trim(), 'Acme');
	assert.doesNotMatch(row.textContent, /\ba1\b|\bl1\b/);
	const many = row.querySelector('[data-ref=many]');
	assert.ok(many.querySelector('[data-icon=links]'));
	assert.match(many.textContent, /Pipe/);
	assert.equal(many.querySelector('[data-ref-more]').textContent.trim(), '+2');
	one.querySelector('[data-ref-open]').click();
	assert.deepEqual(new URL(location.href).searchParams.getAll('record'), ['accounts/a1']);
	v.done();
});

test('Table: a column\'s custom cell renderer gets the row and value; other cells use the kind\'s default renderer', async () => {
	const { createRawSnippet } = await import('svelte');
	const cell = createRawSnippet((x) => ({ render: () => `<b data-custom>${x().row.id}:${x().value}</b>` }));
	const s = scripted({ read: (c, o) => ({ read: { m: 'read', a: [c, o] }, then: (ok, bad) => Promise.resolve({ rows: relRows, next: null }).then(ok, bad) }) });
	const v = await show('table', { of: 'jobs', columns: [{ field: 'title', cell }, 'done'] }, s.bolt, '/', relCatalog);
	const row = document.querySelector('[data-table-wide] tbody tr:not([aria-hidden])');
	assert.equal(row.querySelector('[data-custom]').textContent, 'j1:One');
	assert.doesNotMatch(row.textContent, /true/, 'a boolean is drawn by its kind, not printed');
	v.done();
});

test('Board: each lane reads its first page by its condition; nearing the lane end reads the next by its cursor', async () => {
	const seen = [];
	globalThis.IntersectionObserver = class { constructor(cb) { this.cb = cb; seen.push(this); } observe(el) { this.el = el; } disconnect() {} };
	// page 1 answers a cursor; page 2 is read live as every row up to it (pageRead), and is the lane's last
	const s = scripted({ read: (c, o) => { s.reads.push({ c, o });
		const rows = Array.from({ length: o.limit ?? 1 }, (_, i) => ({ id: `${JSON.stringify(o.where)}-${i}`, title: 'x' }));
		return { read: { m: 'read', a: [c, o] }, then: (ok, bad) => Promise.resolve({ rows, next: (o.limit ?? 1) >= 2 ? null : 'c1' }).then(ok, bad) }; } });
	const v = await show('board', { of: 'jobs', by: 'status', card: ['title'], pageSize: 1 }, s.bolt);
	const lane = document.querySelector('[data-lane=\'"done"\']');
	assert.ok(s.reads.some((r) => JSON.stringify(r.o.where) === JSON.stringify({ status: { eq: 'done' } }) && r.o.limit === 1), 'a lane reads by its lane condition, one page');
	assert.ok(lane.querySelector('[data-lane-more]'));
	const io = seen.find((x) => lane.contains(x.el));
	io.cb([{ isIntersecting: true }]);
	await settle();
	assert.ok(s.reads.some((r) => JSON.stringify(r.o.where) === JSON.stringify({ status: { eq: 'done' } }) && r.o.limit === 2), 'the next page, kept live');
	assert.equal(lane.querySelectorAll('[role=listitem]').length, 2);
	assert.equal(lane.querySelector('[data-lane-more]'), null, 'the lane ends');
	delete globalThis.IntersectionObserver;
	v.done();
});

test('Board: `columns` lays the lanes out in a grid of that many columns; unset is the scrolling reel', async () => {
	const s = scripted();
	const reel = await show('board', { of: 'jobs', by: 'status', card: ['title'] }, s.bolt);
	assert.match(document.querySelector('[data-lane=\'"done"\']').parentElement.className, /overflow-x-auto/);
	reel.done();
	const grid = await show('board', { of: 'jobs', by: 'status', card: ['title'], columns: 2 }, s.bolt);
	const lanes = document.querySelector('[data-view=board] [role=list]').parentElement;
	assert.equal(lanes.style.gridTemplateColumns, 'repeat(2, minmax(0, 1fr))');
	assert.equal(document.querySelectorAll('[data-view=board] [role=list]').length, 2, 'two lanes a row');
	grid.done();
});

test('Table: `/` lists the search indexes and never filters; /semantic reads by meaning, a typed similarity or query swaps in its input (L-BOLT-495)', async () => {
	const similar = [];
	const asked = [];
	const s = scripted({ similar: (c, n, input, o) => { similar.push({ c, n, input, o }); return { read: { m: 'similar', a: [c, n, input, o] }, then: (ok) => Promise.resolve([]).then(ok) }; },
		query: (n, input) => { asked.push({ n, input }); return { read: { m: 'query', a: [n, input] }, then: (ok) => Promise.resolve([{ job: 'j1', score: 0.4 }]).then(ok) }; } });
	const cat = { ...catalog, jobs: { ...catalog.jobs, search: ['title'], semantic: true, similarity: {
		near: { description: 'Jobs near these hours', input: { hours: { kind: 'number' } } },
		pdq: { description: 'Raw', input: { vector: { kind: 'list', of: { kind: 'number' } } } } },
		queries: { closest: { description: 'Jobs closest in hours', input: { hours: { kind: 'number' } },
			output: { kind: 'list', of: { kind: 'object', fields: { job: { kind: 'id', of: 'jobs' }, score: { kind: 'number' } } } } } } } };
	const v = await show('table', { of: 'jobs', columns: ['title', 'hours'] }, s.bolt, '/', cat);
	// the search is an icon: its popover opens focused on the box, naming the fields searched and the `/` commands
	assert.equal(document.querySelector('[data-search]'), null, 'no box until the icon is clicked');
	document.querySelector('[data-search-toggle]').click(); flushSync(); await tick();
	assert.equal(document.activeElement, document.querySelector('[data-search]'), 'the box is focused');
	assert.match(document.querySelector('[data-search-fields]').textContent, /Title/);
	assert.deepEqual([...document.querySelectorAll('[data-search-command]')].map((b) => b.dataset.searchCommand), ['semantic', 'near', 'pdq', 'closest']);
	const type = (text) => { const i = document.querySelector('[data-search]'); i.value = text; i.dispatchEvent(new Event('input', { bubbles: true })); flushSync(); };
	type('/');
	assert.deepEqual([...document.querySelectorAll('[data-search-option]')].map((b) => [b.dataset.searchOption, b.disabled]), [['semantic', false], ['near', false], ['pdq', true], ['closest', false]]);
	type('/zz');
	assert.ok(document.querySelector('[data-search-none]'), 'a `/` matching no index says so');
	await new Promise((r) => setTimeout(r, 350));
	await settle();
	assert.equal(s.last().search, undefined, 'a `/…` picking an index is never a search term');
	type('/semantic ');
	assert.ok(document.querySelector('[data-search-index=semantic]'));
	type('lamp');
	await new Promise((r) => setTimeout(r, 350));
	await settle();
	assert.equal(s.last().search, '/semantic lamp');
	type('');
	document.querySelector('[data-search]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }));
	flushSync();
	assert.equal(document.querySelector('[data-search-index]'), null, 'Backspace on an empty box is back to plain search');
	type('/');
	document.querySelector('[data-search-option=near]').click();
	await settle();
	assert.equal(document.querySelector('[data-search]'), null, 'the text box gives way to the index input');
	const hours = document.querySelector('[data-similar-input=near] [data-similar-field=hours] input');
	hours.value = '3';
	hours.dispatchEvent(new Event('input', { bubbles: true }));
	flushSync();
	document.querySelector('[data-similar-input]').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
	await settle();
	assert.deepEqual(similar.at(-1).n, 'near');
	assert.deepEqual(similar.at(-1).input, { hours: 3 });
	// a named query: its input, called through `query`, its `id`-of-jobs output read back as the table's rows
	document.querySelector('[data-search-index] button').click();
	flushSync();
	type('/');
	document.querySelector('[data-search-option=closest]').click();
	await settle();
	const q = document.querySelector('[data-similar-input=closest] [data-similar-field=hours] input');
	q.value = '2';
	q.dispatchEvent(new Event('input', { bubbles: true }));
	flushSync();
	document.querySelector('[data-similar-input]').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
	await settle();
	assert.deepEqual(asked.at(-1), { n: 'jobs.closest', input: { hours: 2 } });
	assert.deepEqual(s.last().where, { id: { in: ['j1'] } });
	v.done();
});
