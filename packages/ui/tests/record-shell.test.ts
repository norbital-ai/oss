// @ts-nocheck -- executed directly by Node with --experimental-strip-types.
// The record shell's header chrome: the history scrubber (a past revision shows read-only, then back to current), the
// record/approval toggle while the row is held, and no per-field history or History tab.
import './dom.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
const { flushSync, mount, tick, unmount } = await import('svelte');
const { default: Harness } = await import('./view-harness.svelte');

const catalog = { jobs: { label: ['title'], fields: { title: { kind: 'text' }, crew: { kind: 'text', optional: true } }, update: { columns: ['title', 'crew'] } } };
const LIVE = { id: 'j1', revision: 3, title: 'Paint v3', crew: 'B' };
const PAST = { 1: { id: 'j1', revision: 1, title: 'Paint', crew: null }, 2: { id: 'j1', revision: 2, title: 'Paint v2', crew: null, updated_at: '2026-09-02T00:00:00.000Z' } };
const HISTORY = [
	{ revision: 1, at: '2026-09-01T00:00:00.000Z', actor: { kind: 'member', id: 'u1' }, changed: { title: 'Paint' } },
	{ revision: 2, at: '2026-09-02T00:00:00.000Z', actor: { kind: 'system', id: 'run1' }, changed: { title: 'Paint v2', updated_at: 'x' } },
	{ revision: 3, at: '2026-09-03T00:00:00.000Z', actor: { kind: 'member', id: 'u1' }, changed: { title: 'Paint v3', crew: 'B' } },
];
const q = (v, m, a) => Object.assign(Promise.resolve(v), { read: { m, a } });
function fake(live) {
	const calls = { gets: [], history: 0 };
	const bolt = {
		t: (k) => k, locale: 'en', actor: null,
		read: (c, o) => q({ rows: [], next: null }, 'read', [c, o]),
		get: (c, id, select, options) => {
			calls.gets.push({ c, id, revision: options?.revision });
			return q(c === 'sys_user' ? { name: 'Ada' } : options?.revision !== undefined ? PAST[options.revision] ?? null : live, 'get', [c, id]);
		},
		aggregate: () => q([], 'aggregate', []),
		history: () => (calls.history++, q(HISTORY, 'history', [])),
		live: (x) => { let v; x.then((r) => (v = r)); return { get current() { return v; }, error: undefined, subscribe(run) { x.then((r) => run(r)); return () => {}; } }; },
		act: async () => ({ kind: 'committed', output: null, records: [] }),
		fileUrl: () => '', approvals: { get: async () => null },
	};
	return { bolt, calls };
}
const settle = async () => { flushSync(); for (let i = 0; i < 5; i++) { await tick(); await new Promise((r) => setTimeout(r, 0)); } };
const mounted = [];
test.afterEach(() => { while (mounted.length > 0) mounted.pop()(); });
async function show(live) {
	const { bolt, calls } = fake(live);
	const target = document.createElement('div');
	document.body.append(target);
	const app = mount(Harness, { target, props: { bolt, catalog, part: 'record', props: { of: 'jobs', id: 'j1' } } });
	await settle();
	mounted.push(() => { unmount(app); target.remove(); });
	return { target, calls, slider: () => target.querySelector('header [data-record-timeline] [role=slider]') };
}
const key = async (el, k) => { el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })); await settle(); };
const edit = (t) => [...t.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Edit');

test('the scrubber sits in the sheet header; no per-field history and no History tab', async () => {
	const v = await show(LIVE);
	const s = v.slider();
	assert.ok(s, 'the scrubber is in the sheet header');
	assert.equal(s.getAttribute('aria-valuemax'), '3');
	assert.equal(s.getAttribute('aria-valuenow'), '3');
	assert.equal(v.target.querySelector('[data-field-history]'), null);
	assert.equal([...v.target.querySelectorAll('[role=tab]')].some((t) => /history/i.test(t.textContent)), false);
	assert.equal(v.calls.history, 0, 'history loads lazily');
});

test('a past revision shows read-only, then End returns to the live, editable record', async () => {
	const v = await show(LIVE);
	assert.ok(edit(v.target));
	await key(v.slider(), 'ArrowLeft');
	assert.ok(v.calls.gets.some((g) => g.c === 'jobs' && g.revision === 2), 'read as of revision 2');
	assert.ok(v.target.querySelector('[data-record-past]'));
	assert.ok(v.target.querySelector('fieldset[disabled]'));
	assert.match(v.target.querySelector('[data-field=title]').textContent, /Paint v2/);
	assert.equal(edit(v.target), undefined, 'no Edit on a past revision');
	assert.equal(v.slider().getAttribute('aria-valuenow'), '2');
	await key(v.slider(), 'End');
	assert.equal(v.target.querySelector('[data-record-past]'), null);
	assert.equal(v.target.querySelector('fieldset[disabled]'), null);
	assert.match(v.target.querySelector('[data-field=title]').textContent, /Paint v3/);
	assert.ok(edit(v.target));
});

test('hover loads the history once and the card says when, who and what changed', async () => {
	const v = await show(LIVE);
	const strip = v.target.querySelector('[data-record-timeline]');
	strip.dispatchEvent(new PointerEvent('pointerenter'));
	strip.dispatchEvent(new PointerEvent('pointerenter'));
	await settle();
	await key(v.slider(), 'ArrowLeft');
	const card = v.target.querySelector('[data-timeline-card="2"]');
	assert.ok(card);
	assert.equal(v.calls.history, 1);
	assert.match(card.textContent, /Automation/);
	assert.match(card.textContent, /Title/);
	assert.doesNotMatch(card.textContent, /Updated at/);
});

test('a held record: the header toggles between the record and its approval', async () => {
	const v = await show({ ...LIVE, approval_id: 'r1' });
	const approval = v.target.querySelector('header [data-record-pane=approval]');
	assert.ok(approval);
	assert.equal(v.target.querySelector('header [data-record-pane=record]').getAttribute('aria-pressed'), 'true');
	approval.click();
	await settle();
	assert.equal(approval.getAttribute('aria-pressed'), 'true');
	assert.ok(v.target.querySelector('fieldset.hidden'), 'the record body is hidden, still mounted');
	assert.ok(v.target.querySelector('[data-read=notFound], [data-view=approval]'), 'the approval panel shows');
	assert.equal([...v.target.querySelectorAll('[role=tab]')].some((t) => /approval/i.test(t.textContent)), false);
});

test('every stored record: both toggles and a one-tick scrubber on revision 1; approval says there is none', async () => {
	const v = await show({ ...LIVE, revision: 1 });
	assert.ok(v.target.querySelector('header [data-record-pane=record]'));
	const approval = v.target.querySelector('header [data-record-pane=approval]');
	assert.ok(approval);
	assert.equal(approval.querySelector('.bg-brand'), null, 'no pending dot without a held request');
	assert.equal(v.slider().getAttribute('aria-valuemax'), '1');
	v.slider().focus();
	await settle();
	assert.match(v.target.querySelector('[data-timeline-card="1"]')?.textContent ?? '', /Created/);
	approval.click();
	await settle();
	assert.match(v.target.textContent, /No approval on this record/);
});
