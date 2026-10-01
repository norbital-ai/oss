// @ts-nocheck -- executed directly by Node with --experimental-strip-types.
// Kit gaps found migrating the 0.0.1 templates: Form's read-only mode, a toolbar item's per-selection disabled reason,
// the record row in a custom field's view, and representations loaded on first use.
import './dom.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
const { flushSync, mount, tick, unmount } = await import('svelte');
const { default: Harness } = await import('./packaging-harness.svelte');
const { default: Renderer } = await import('./packaging-renderer.svelte');
const { default: Representation } = await import('./packaging-representation.svelte');

const catalog = { jobs: { label: ['title'], fields: { title: { kind: 'text' }, crew: { kind: 'text', optional: true }, sign: { kind: 'custom', of: 'sign', optional: true } },
	update: { columns: ['title', 'crew'] } } };
const JOB = { id: 'j1', revision: 1, title: 'Paint', crew: 'B' };
const q = (v, m, a) => Object.assign(Promise.resolve(v), { read: { m, a } });
const bolt = {
	t: (k) => k, locale: 'en', actor: null,
	read: (c, o) => q({ rows: [JOB], next: null }, 'read', [c, o]),
	get: (c, id) => q(id === 'j1' ? JOB : null, 'get', [c, id]),
	aggregate: () => q([{ count: 1 }], 'aggregate', []),
	history: () => q([], 'history', []),
	live: (x) => { let v; x.then((r) => (v = r)); return { get current() { return v; }, error: undefined, subscribe(run) { x.then((r) => run(r)); return () => {}; } }; },
	act: async () => ({ kind: 'committed', output: null, records: [] }),
	fileUrl: () => '', approvals: {},
};
const mounted = [];
test.afterEach(() => { while (mounted.length > 0) mounted.pop()(); });
async function show(props) {
	const target = document.createElement('div');
	document.body.append(target);
	const app = mount(Harness, { target, props: { bolt, catalog, ...props } });
	flushSync();
	for (let i = 0; i < 5; i++) { await tick(); await new Promise((r) => setTimeout(r, 0)); }
	const done = () => { if (target.isConnected) { unmount(app); target.remove(); } };
	mounted.push(done);
	return { target, done };
}

test('a read-only Form shows every value as copyable text, no field chrome, no submit', async () => {
	const editable = await show({ part: 'form', props: { of: 'jobs', id: 'j1', record: JOB } });
	assert.equal(editable.target.querySelectorAll('button[type=submit]').length, 1);
	editable.done();
	const view = await show({ part: 'form', props: { of: 'jobs', id: 'j1', record: JOB, readonly: true } });
	assert.equal(view.target.querySelectorAll('button[type=submit]').length, 0); // counts, not nodes: a failing assert would inspect the DOM
	assert.equal(view.target.querySelectorAll('input, textarea, [role=combobox], [data-form-footer]').length, 0);
	assert.equal(view.target.querySelector('[data-field=title][data-readonly]')?.textContent.includes('Paint'), true);
	assert.equal(view.target.querySelector('[data-field=title] button')?.getAttribute('aria-label'), 'Copy');
	view.done();
});

const ROW = { id: 'r1', revision: 1, title: 'Paint', paid: true, grade: 'senior_staff', note: null, owner: 'j1' };
const readable = { jobs: catalog.jobs, rows: { label: ['title'], fields: {
	title: { kind: 'text' }, paid: { kind: 'bool' }, grade: { kind: 'enum', values: ['senior_staff', 'junior'] }, note: { kind: 'text', optional: true } },
	relations: { owner: { targets: ['jobs'] } } } };

test('an update the viewer cannot make is readonly by itself: enums by label, booleans Yes/No, refs by label, empty as a dash', async () => {
	const v = await show({ part: 'form', catalog: readable, props: { of: 'rows', id: 'r1', record: ROW } });
	const text = (f) => v.target.querySelector(`[data-field=${f}][data-readonly]`)?.textContent ?? '';
	assert.equal(v.target.querySelectorAll('input, button[type=submit]').length, 0);
	assert.ok(text('grade').includes('Senior staff'));
	assert.ok(text('paid').includes('Yes'));
	assert.ok(text('note').includes('—'));
	assert.ok(text('owner').includes('Paint') && !text('owner').includes('j1'));
	// no prop lifts the engine's readonly
	const lifted = await show({ part: 'form', catalog: readable, props: { of: 'rows', id: 'r1', record: ROW, readonly: false } });
	assert.equal(lifted.target.querySelectorAll('input').length, 0);
	v.done();
	lifted.done();
});

test('a disabled Form keeps its editors, muted and inert, with the submit disabled', async () => {
	const v = await show({ part: 'form', props: { of: 'jobs', id: 'j1', record: JOB, disabled: true } });
	const inputs = [...v.target.querySelectorAll('input')];
	assert.ok(inputs.length > 0 && inputs.every((i) => i.disabled));
	assert.equal(v.target.querySelector('button[type=submit]').disabled, true);
	assert.equal(v.target.querySelectorAll('[data-readonly]').length, 0);
	v.done();
});

test('the form mode reaches every Field by context; a Field overrides it; a Fieldset reaches a bare input', async () => {
	const v = await show({ part: 'controls', props: { record: JOB, readonly: true, override: false, group: 'readonly' } });
	assert.ok(v.target.querySelector('[data-field=title][data-readonly]'));
	assert.equal(v.target.querySelector('[data-field=crew] input')?.value, 'B');
	assert.equal(v.target.querySelectorAll('[data-bare] input').length, 0);
	assert.ok(v.target.querySelector('[data-bare] [data-readonly]')?.textContent.includes('bare'));
	v.done();
	const off = await show({ part: 'controls', props: { record: JOB, disabled: true, group: 'disabled' } });
	assert.equal(off.target.querySelector('[data-field=title] input')?.disabled, true);
	assert.equal(off.target.querySelector('[data-bare] input')?.disabled, true);
	off.done();
});

test('a toolbar item says why it cannot run over the current selection', async () => {
	const why = (ids) => ids.length === 0 ? 'Pick a job first' : null;
	const v = await show({ part: 'table', props: { of: 'jobs', columns: ['title'], toolbar: { actions: [{ action: 'jobs.close', label: 'Close', disabled: why }] } } });
	// the item lives in the toolbar's actions menu (portalled to the body)
	v.target.querySelector('[data-view-actions]').click();
	for (let i = 0; i < 3; i++) { flushSync(); await tick(); }
	const item = () => [...document.querySelectorAll('[data-view-menu] button')].find((b) => b.textContent.includes('Close'));
	assert.equal(item().disabled, true);
	assert.equal(item().getAttribute('title'), 'Pick a job first');
	const box = v.target.querySelector('tbody input[type=checkbox]');
	box.checked = true;
	box.dispatchEvent(new Event('change', { bubbles: true }));
	flushSync();
	const button = item();
	assert.equal(button.disabled, false);
	assert.equal(button.getAttribute('title'), null);
	v.done();
});

test('a custom field renderer receives the record row beside its value', async () => {
	const v = await show({ part: 'show', customFields: { sign: { shape: { kind: 'text' }, renderer: Renderer } },
		props: { kind: { kind: 'custom', of: 'sign' }, value: 'ok', name: 'sign', row: JOB } });
	assert.deepEqual(JSON.parse(v.target.querySelector('[data-renderer=show]').getAttribute('data-row')), JOB);
	v.done();
});

test('a representation loads on first use, for a page-level RecordShell too', async () => {
	let loads = 0;
	const representations = { jobs: () => (loads++, Promise.resolve({ default: Representation })) };
	const v = await show({ part: 'record', representations, props: { of: 'jobs', id: 'j1' } });
	assert.equal(v.target.querySelector('[data-representation=update]')?.textContent, 'Paint');
	assert.equal(loads, 1);
	v.done();
});

test('a local array\'s boolean column is a check or a cross icon, not a glyph in text', async () => {
	const { addIcon } = await import('@iconify/svelte'); // offline: the icons the cell draws, so it renders synchronously
	for (const name of ['lucide:check', 'lucide:x']) addIcon(name, { body: '<path d="M0 0"/>' });
	const v = await show({ part: 'table', props: { of: [{ id: 'a', name: 'Ada', admin: true }, { id: 'b', name: 'Bo', admin: false }], columns: ['name', 'admin'] } });
	assert.deepEqual([...v.target.querySelectorAll('tbody svg[aria-label]')].map((x) => x.getAttribute('aria-label')), ['Yes', 'No']);
	assert.equal(/[✓✗]/.test(v.target.querySelector('tbody').textContent), false);
});

test('two or more row actions fold into one menu in the grid; a single action stays a button', async () => {
	const rows = [{ id: 'a', name: 'Ada' }];
	const two = await show({ part: 'table', props: { of: rows, columns: ['name'], actions: [{ action: 'x.reassign', label: 'Reassign' }, { action: 'x.cancel', label: 'Cancel' }] } });
	const cell = two.target.querySelector('tbody [data-row-actions]');
	assert.ok(cell.querySelector('[data-row-menu]'), 'one menu trigger');
	assert.equal(/Reassign|Cancel/.test(cell.textContent), false, 'the labels live in the menu, not the cell');
	two.done();
	const one = await show({ part: 'table', props: { of: rows, columns: ['name'], actions: [{ action: 'x.cancel', label: 'Cancel' }] } });
	assert.equal(one.target.querySelector('tbody [data-row-actions] [data-row-menu]'), null);
	assert.match(one.target.querySelector('tbody [data-row-actions]').textContent, /Cancel/);
	one.done();
});

test('the toolbar row: title, ⓘ and every widget flush left in that order; only New is pushed right', async () => {
	const v = await show({ part: 'table', props: { of: 'jobs', columns: ['title'], toolbar: { title: 'Jobs', description: 'All jobs', new: () => {},
		actions: [{ run: () => {}, label: 'Recount' }] } } });
	const row = v.target.querySelector('[data-view-title]').parentElement;
	const marks = [...row.children].map((el) => ['data-view-title', 'data-view-about', 'data-search-toggle', 'data-view-trigger', 'data-view-actions', 'data-view-new']
		.find((a) => el.hasAttribute(a) || el.querySelector(`[${a}]`) !== null) ?? el.tagName);
	assert.deepEqual(marks, ['data-view-title', 'data-view-about', 'data-search-toggle', 'data-view-trigger', 'data-view-actions', 'data-view-new']);
	// nothing stretches between the widgets: the create slot alone takes the free space, so a wrap keeps it at the row's end
	const pushers = [...row.children].filter((el) => /(^|\s)(ml-auto|flex-1|grow)(\s|$)/.test(el.getAttribute('class') ?? ''));
	assert.deepEqual(pushers.map((el) => el.hasAttribute('data-view-new')), [true]);
	assert.equal(row.querySelector('[data-view-new]').getAttribute('aria-label'), 'New');
	v.done();
});
