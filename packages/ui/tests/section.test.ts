// @ts-nocheck -- executed directly by Node with --experimental-strip-types.
// Progressive disclosure: a titled section collapses from its heading, remembers the viewer's choice, shows a summary
// while closed, opens itself over an error, and keeps its fields mounted so a collapsed field still saves.
import './dom.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
const { flushSync, mount, tick, unmount } = await import('svelte');
const { default: Harness } = await import('./section-harness.svelte');

const catalog = {
	jobs: {
		label: ['title'],
		fields: { title: { kind: 'text' }, notes: { kind: 'text', optional: true }, kind: { kind: 'enum', values: ['a', 'b'], optional: true } },
		create: { columns: ['title', 'notes', 'kind'] },
	},
};
const settle = async () => { for (let i = 0; i < 5; i++) { flushSync(); await tick(); await new Promise((r) => setTimeout(r, 0)); } flushSync(); };
const mounted = [];
test.afterEach(() => { while (mounted.length > 0) mounted.pop()(); localStorage.clear(); });
async function show(act = async () => ({ kind: 'committed', output: null, records: [] })) {
	const sent = [];
	const bolt = {
		t: (k) => k, locale: 'en', actor: null, fileUrl: () => '', approvals: {},
		read: () => Promise.resolve({ rows: [], next: null }), get: () => Promise.resolve(null),
		act: async (c, input) => { sent.push([c, input]); return act(c, input); },
	};
	const target = document.createElement('div');
	document.body.append(target);
	const app = mount(Harness, { target, props: { bolt, catalog } });
	await settle();
	mounted.push(() => { unmount(app); target.remove(); });
	return { target, sent };
}
const section = (t, name) => t.querySelector(`[data-section="${name}"]`);
const header = (t, name) => section(t, name).querySelector('h3 button');
const body = (t, name) => t.querySelector(`#${CSS.escape(header(t, name).getAttribute('aria-controls'))}`);
const type = (t, field, value) => {
	const input = t.querySelector(`[data-field=${field}] input, [data-field=${field}] textarea`);
	input.value = value;
	input.dispatchEvent(new Event('input', { bubbles: true }));
};

test('the heading is a button that toggles the body; aria-expanded and aria-controls follow', async () => {
	const { target } = await show();
	const b = header(target, 'Job');
	assert.equal(b.type, 'button', 'a native button: Enter and Space work');
	assert.equal(b.getAttribute('aria-expanded'), 'true');
	assert.equal(body(target, 'Job').hidden, false);
	b.click();
	flushSync();
	assert.equal(b.getAttribute('aria-expanded'), 'false');
	assert.equal(body(target, 'Job').hidden, true);
	assert.ok(target.querySelector('[data-field=title]'), 'collapsed, the field stays mounted');
});

test('defaultOpen={false} starts closed with its summary in the heading; opening hides the summary', async () => {
	const { target } = await show();
	const b = header(target, 'Notes');
	assert.equal(b.getAttribute('aria-expanded'), 'false');
	assert.equal(section(target, 'Notes').querySelector('[data-section-summary]').textContent, 'Not set');
	assert.equal(section(target, 'Job').querySelector('[data-section-summary]'), null, 'an open section shows no summary');
	b.click();
	flushSync();
	assert.equal(section(target, 'Notes').querySelector('[data-section-summary]'), null);
});

test('the viewer\'s choice is remembered per collection and section', async () => {
	const first = await show();
	header(first.target, 'Notes').click();
	header(first.target, 'Job').click();
	flushSync();
	assert.equal(localStorage.getItem('norbital.section:jobs:Notes'), '1');
	mounted.pop()();
	const again = await show();
	assert.equal(header(again.target, 'Notes').getAttribute('aria-expanded'), 'true');
	assert.equal(header(again.target, 'Job').getAttribute('aria-expanded'), 'false');
});

test('storage that throws: sections still render and toggle', async () => {
	const real = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
	Object.defineProperty(globalThis, 'localStorage', { get() { throw new Error('blocked'); }, configurable: true });
	try {
		const { target } = await show();
		header(target, 'Notes').click();
		flushSync();
		assert.equal(header(target, 'Notes').getAttribute('aria-expanded'), 'true');
	} finally {
		Object.defineProperty(globalThis, 'localStorage', real);
	}
});

test('a section that does not opt in, or opts out of collapsing, stays open', async () => {
	const { target } = await show();
	assert.equal(header(target, 'Job').getAttribute('aria-expanded'), 'true');
	assert.equal(section(target, 'Fixed').querySelector('h3 button'), null, 'collapsible={false}: no toggle');
	assert.equal(section(target, 'Fixed').querySelector('[hidden]'), null);
});

test('a collapsed section with a field error opens itself', async () => {
	const { target } = await show(async () => ({ kind: 'refused', code: 'check', message: 'Too long', field: 'notes' }));
	type(target, 'title', 'Paint');
	flushSync();
	assert.equal(header(target, 'Notes').getAttribute('aria-expanded'), 'false');
	target.querySelector('form').requestSubmit();
	await settle();
	assert.equal(header(target, 'Notes').getAttribute('aria-expanded'), 'true');
	assert.equal(body(target, 'Notes').hidden, false);
	assert.match(section(target, 'Notes').textContent, /Too long/);
});

test('a form with collapsed sections still saves every field', async () => {
	const { target, sent } = await show();
	type(target, 'title', 'Paint');
	type(target, 'notes', 'Back door');
	header(target, 'Job').click();
	flushSync();
	assert.equal(body(target, 'Job').hidden, true);
	assert.equal(body(target, 'Notes').hidden, true);
	target.querySelector('form').requestSubmit();
	await settle();
	assert.equal(sent.length, 1);
	assert.equal(sent[0][0], 'jobs.create');
	assert.equal(sent[0][1].title, 'Paint');
	assert.equal(sent[0][1].notes, 'Back door');
});
