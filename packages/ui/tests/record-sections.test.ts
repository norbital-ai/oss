// @ts-nocheck -- executed directly by Node with --experimental-strip-types.
// RecordShell `sections`: the generated record view (read, edit, create) grouped into collapsible Sections in the
// declared order; unlisted fields follow untitled; collapsed fields still save; no `sections` is the flat grid.
import './dom.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
const { flushSync, mount, tick, unmount } = await import('svelte');
const { default: Harness } = await import('./view-harness.svelte');

const catalog = {
	jobs: {
		label: ['title'],
		fields: { title: { kind: 'text' }, crew: { kind: 'text', optional: true }, notes: { kind: 'text', optional: true }, site: { kind: 'text', optional: true } },
		update: { columns: ['title', 'crew', 'notes', 'site'] },
		create: { columns: ['title', 'crew', 'notes', 'site'] },
	},
};
const ROW = { id: 'j1', revision: 1, title: 'Paint', crew: 'B', notes: 'Back door', site: 'North' };
const SECTIONS = [
	{ name: 'core', title: 'Job', fields: ['site', 'title'] },
	{ name: 'more', title: 'More', fields: ['notes', 'nope'], defaultOpen: false, summary: (r) => `Notes: ${r.notes ?? '—'}` },
];
const settle = async () => { for (let i = 0; i < 5; i++) { flushSync(); await tick(); await new Promise((r) => setTimeout(r, 0)); } flushSync(); };
const mounted = [];
test.afterEach(() => { while (mounted.length > 0) mounted.pop()(); localStorage.clear(); });
async function show(props) {
	const sent = [];
	const warned = [];
	const warn = console.warn;
	console.warn = (m) => warned.push(String(m));
	const bolt = {
		t: (k) => k, locale: 'en', actor: null, fileUrl: () => '', approvals: { get: async () => null },
		read: () => Promise.resolve({ rows: [], next: null }), get: (c) => Promise.resolve(c === 'jobs' ? ROW : null),
		aggregate: () => Promise.resolve([]), history: () => Promise.resolve([]),
		live: (x) => { let v; x.then((r) => (v = r)); return { get current() { return v; }, error: undefined, subscribe(run) { x.then((r) => run(r)); return () => {}; } }; },
		act: async (c, input) => { sent.push([c, input]); return { kind: 'committed', output: null, records: [] }; },
	};
	const target = document.createElement('div');
	document.body.append(target);
	const app = mount(Harness, { target, props: { bolt, catalog, part: 'record', props: { of: 'jobs', ...props } } });
	await settle();
	console.warn = warn;
	mounted.push(() => { unmount(app); target.remove(); });
	return { target, sent, warned };
}
const section = (t, name) => t.querySelector(`[data-section="${name}"]`);
const fieldsIn = (el) => [...el.querySelectorAll('[data-field]')].map((f) => f.dataset.field);
const edit = (t) => [...t.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Edit');

test('read: fields group into sections in the declared order; unlisted fields follow untitled; unknown names warn', async () => {
	const { target, warned } = await show({ id: 'j1', sections: SECTIONS });
	const all = [...target.querySelectorAll('[data-view=record-generated] > section')];
	assert.equal(all.length, 3);
	assert.deepEqual(fieldsIn(section(target, 'core')), ['site', 'title']);
	assert.deepEqual(fieldsIn(section(target, 'more')), ['notes']);
	assert.deepEqual(fieldsIn(all[2]), ['crew'], 'nothing disappears');
	assert.equal(all[2].querySelector('h3'), null, 'the rest is untitled');
	assert.equal(all[2].dataset.open, 'true');
	assert.ok(warned.some((w) => /nope/.test(w)));
});

test('read: defaultOpen false starts closed, its summary a function of the row', async () => {
	const { target } = await show({ id: 'j1', sections: SECTIONS });
	assert.equal(section(target, 'more').querySelector('h3 button').getAttribute('aria-expanded'), 'false');
	assert.equal(section(target, 'more').querySelector('[data-section-summary]').textContent, 'Notes: Back door');
	assert.ok(section(target, 'more').querySelector('[data-field=notes]'), 'collapsed, still mounted');
});

test('a string summary shows while closed', async () => {
	const { target } = await show({ id: 'j1', sections: [{ name: 'more', title: 'More', fields: ['notes'], defaultOpen: false, summary: 'Optional' }] });
	assert.equal(section(target, 'more').querySelector('[data-section-summary]').textContent, 'Optional');
});

test('edit: the form is sectioned and a collapsed field still saves', async () => {
	const { target, sent } = await show({ id: 'j1', sections: SECTIONS });
	edit(target).click();
	await settle();
	const form = target.querySelector('form');
	assert.deepEqual(fieldsIn(section(form, 'core')), ['site', 'title']);
	const footer = form.querySelector('[data-form-footer]');
	assert.equal(form.lastElementChild, footer, 'the footer ends the form');
	assert.equal(form.querySelector('[data-form-body]').contains(footer), false, 'the footer stays outside the scrolling fields');
	assert.equal(section(form, 'more').querySelector('h3 button').getAttribute('aria-expanded'), 'false');
	const notes = form.querySelector('[data-field=notes] input, [data-field=notes] textarea');
	notes.value = 'Front gate';
	notes.dispatchEvent(new Event('input', { bubbles: true }));
	await settle();
	assert.equal(section(form, 'more').querySelector('[data-section-summary]').textContent, 'Notes: Front gate', 'the summary reads the draft');
	form.requestSubmit();
	await settle();
	assert.equal(sent.length, 1);
	assert.deepEqual(sent[0][1], { target: 'j1', set: { notes: 'Front gate' } });
});

test('create: sections apply to the generated create form', async () => {
	const { target } = await show({ mode: 'create', sections: SECTIONS });
	const form = target.querySelector('form');
	assert.deepEqual(fieldsIn(section(form, 'core')), ['site', 'title']);
	const footer = form.querySelector('[data-form-footer]');
	assert.equal(form.lastElementChild, footer, 'the footer ends the form');
	assert.equal(form.querySelector('[data-form-body]').contains(footer), false, 'the footer stays outside the scrolling fields');
	assert.deepEqual(fieldsIn(form.querySelectorAll('[data-form-body] > div > section')[2]), ['crew']);
});

test('no sections: the flat grid, unchanged', async () => {
	const { target } = await show({ id: 'j1' });
	assert.equal(target.querySelector('section[data-section]'), null);
	assert.deepEqual(fieldsIn(target.querySelector('[data-view=record-generated]')), ['title', 'crew', 'notes', 'site']);
	edit(target).click();
	await settle();
	assert.equal(target.querySelector('form section'), null);
});
