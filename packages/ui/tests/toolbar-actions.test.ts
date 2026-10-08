// @ts-nocheck -- executed directly by Node with --experimental-strip-types.
// The toolbar's ⚡ menu: an author item is an icon, a name, a description and its handler; the menu keeps each row's
// state (pending, done, failed in place and as a toast) and wires a collection's pipeline feeds in by itself.
import './dom.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
const { flushSync, mount, tick, unmount } = await import('svelte');
const { default: Harness } = await import('./view-harness.svelte');
const { toasts } = await import('../src/toast/toast.svelte.ts');

const mounted = [];
const settle = async () => { for (let i = 0; i < 3; i++) { flushSync(); await tick(); await new Promise((r) => setTimeout(r, 0)); } flushSync(); };
test.afterEach(() => { while (mounted.length) mounted.pop()(); document.body.replaceChildren(); toasts.splice(0); });

function fakeBolt(extra = {}) {
	const started = [];
	const bolt = {
		locale: 'en', actor: null, t: (k) => k, approvals: {}, fileUrl: () => '',
		read: () => Object.assign(Promise.resolve({ rows: [], next: null }), { read: { m: 'read', a: [] } }),
		live: (x) => { let v; x.then((r) => (v = r)); return { get current() { return v; }, error: undefined, subscribe(run) { x.then((r) => run(r)); return () => {}; } }; },
		aggregate: () => Object.assign(Promise.resolve([{ count: 0 }]), { read: { m: 'aggregate', a: [] } }),
		act: async () => ({ kind: 'committed', output: null, records: [] }),
		start: (automation, input) => {
			started.push({ automation, input });
			const outcome = Promise.resolve({ kind: 'committed', output: null, records: [] });
			return { id: `run-${started.length}`, automation, then: (ok, bad) => outcome.then(ok, bad) };
		},
		...extra,
	};
	return { bolt, started };
}
async function show({ actions, catalog = {}, of = [{ id: 'a', name: 'Ada' }], upload, bolt = fakeBolt().bolt, context }) {
	const target = document.createElement('div'); document.body.append(target);
	const app = mount(Harness, { target, props: { bolt, catalog, upload, part: 'table', props: {
		of, columns: ['name'], toolbar: { title: false, search: false, filter: false, export: false, new: false, ...(actions === undefined ? {} : { actions }), ...(context === undefined ? {} : { context }) } } } });
	mounted.push(() => { unmount(app); target.remove(); }); await settle();
	return target;
}
const open = async () => { document.querySelector('[data-view-actions]').click(); await settle(); };
const row = (key) => document.querySelector(`[data-view-menu] [data-menu-item="${key}"]`);
const press = async (key) => { row(key).querySelector('button').click(); await settle(); };
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

test('a row shows its icon tile, name, description and one button named for it', async () => {
	await show({ actions: [{ icon: 'lucide:check', name: 'Settle', description: 'Mark the dues paid', run: () => {} }] });
	await open();
	const r = row('item:Settle');
	assert.ok(r.textContent.includes('Settle') && r.textContent.includes('Mark the dues paid'));
	assert.equal(r.querySelector('button').getAttribute('aria-label'), 'Settle');
	assert.equal(r.querySelector('button').textContent.trim(), 'Run');
});

test('a pending handler spins and disables its row, then says done; the menu stays open', async () => {
	const d = deferred();
	let calls = 0;
	await show({ actions: [{ icon: 'lucide:check', name: 'Settle', run: () => (calls++, d.promise) }] });
	await open(); await press('item:Settle');
	assert.equal(row('item:Settle').dataset.status, 'pending');
	assert.equal(row('item:Settle').querySelector('button').disabled, true);
	assert.ok(row('item:Settle').querySelector('[role=status]'), 'a spinner');
	assert.equal(document.querySelector('[data-view-actions]').getAttribute('aria-busy'), 'true');
	d.resolve(); await settle();
	assert.equal(row('item:Settle').dataset.status, 'done');
	assert.ok(row('item:Settle').querySelector('button').textContent.includes('Done'));
	assert.equal(calls, 1);
});

test('a rejected handler shows its error in place and as a toast, and can run again', async () => {
	let fail = true;
	await show({ actions: [{ icon: 'lucide:check', name: 'Settle', description: 'Mark paid', run: async () => { if (fail) throw new Error('Ledger is locked'); } }] });
	await open(); await press('item:Settle');
	assert.equal(row('item:Settle').dataset.status, 'failed');
	assert.equal(row('item:Settle').querySelector('[data-menu-error]').textContent, 'Ledger is locked');
	assert.deepEqual(toasts.map((t) => [t.tone, t.text]), [['error', 'Ledger is locked']]);
	fail = false; await press('item:Settle');
	assert.equal(row('item:Settle').dataset.status, 'done');
	assert.equal(row('item:Settle').querySelector('[data-menu-error]'), null);
});

test('an outcome is toasted; a refusal is the row\'s error', async () => {
	await show({ actions: [
		{ icon: 'lucide:check', name: 'Hold', run: async () => ({ kind: 'committed', output: null, records: [] }) },
		{ icon: 'lucide:x', name: 'Release', run: async () => ({ kind: 'refused', code: 'rule', message: 'Already paid' }) },
	] });
	await open(); await press('item:Hold'); await press('item:Release');
	assert.equal(row('item:Hold').dataset.status, 'done');
	assert.equal(row('item:Release').dataset.status, 'failed');
	assert.equal(row('item:Release').querySelector('[data-menu-error]').textContent, 'Already paid');
	assert.deepEqual(toasts.map((t) => t.tone), ['success', 'error']);
});

test('a handler returning a run handle shows the run under the toolbar and closes the menu', async () => {
	const { bolt, started } = fakeBolt();
	const target = await show({ bolt, actions: [{ icon: 'lucide:refresh-cw', name: 'Refresh', run: () => bolt.start('refresh', {}) }] });
	await open(); await press('item:Refresh');
	assert.deepEqual(started, [{ automation: 'refresh', input: {} }]);
	assert.equal(document.querySelector('[data-view-menu]'), null);
	assert.ok(target.querySelector('[data-run="run-1"]'), 'the run\'s status');
	assert.deepEqual(toasts, [], 'the run says its own success');
});

test('a handler returning nothing closes the menu (it opened its own surface)', async () => {
	let opened = false;
	await show({ actions: [{ icon: 'lucide:x', name: 'Waive', run: () => { opened = true; } }] });
	await open(); await press('item:Waive');
	assert.equal(opened, true);
	assert.equal(document.querySelector('[data-view-menu]'), null);
});

test('a collection\'s import and export pipelines are rows of their own, run through the menu', async () => {
	const { bolt, started } = fakeBolt();
	const catalog = { jobs: { label: ['name'], fields: { name: { kind: 'text' } }, pipeline: { import: 'Jobs from a JSON file', export: 'Every job as JSON' } } };
	const uploads = [];
	const upload = async (file, field) => (uploads.push(field), { id: 'f1', name: file.name, mime: 'application/json' });
	const target = await show({ bolt, catalog, of: 'jobs', upload });
	await open();
	assert.ok(row('import').textContent.includes('Jobs from a JSON file'));
	await press('export-feed');
	assert.deepEqual(started, [{ automation: 'jobs.pipeline', input: { mode: 'export' } }]);
	const input = target.querySelector('[data-view-import]');
	Object.defineProperty(input, 'files', { value: [new File(['[]'], 'jobs.json', { type: 'application/json' })], configurable: true });
	input.dispatchEvent(new Event('change', { bubbles: true })); await settle();
	assert.deepEqual(uploads, ['jobs.$import']);
	assert.deepEqual(started.at(-1), { automation: 'jobs.pipeline', input: { mode: 'import', file: 'f1' } });
	assert.equal(target.querySelectorAll('[data-run]').length, 2);
});

test('an import run is watched to its end: warnings wait in the menu, "Accept and import" re-submits the file, the counts are toasted', async () => {
	const rows = new Map(), subs = new Set();
	const set = (id, row) => { rows.set(id, { id, automation: 'jobs.pipeline', ...row }); for (const s of subs) s(); };
	const runs = (automation, { where }) => {
		const id = where.id.eq;
		const page = () => ({ rows: rows.has(id) ? [rows.get(id)] : [], next: null });
		return { get current() { return page(); }, error: undefined, subscribe(run) { const s = () => run(page()); subs.add(s); s(); return () => subs.delete(s); } };
	};
	const { bolt, started } = fakeBolt({ runs });
	const catalog = { jobs: { label: ['name'], fields: { name: { kind: 'text' } }, pipeline: { import: 'Jobs from a sheet' } } };
	const target = await show({ bolt, catalog, of: 'jobs', upload: async (file) => ({ id: 'f1', name: file.name, mime: file.type }) });
	await open();
	assert.ok(row('template'), 'the template row comes with the import');
	await press('template');
	assert.deepEqual(started.at(-1), { automation: 'jobs.pipeline', input: { mode: 'template' } });
	const input = target.querySelector('[data-view-import]');
	Object.defineProperty(input, 'files', { value: [new File(['x'], 'jobs.xlsx')], configurable: true });
	input.dispatchEvent(new Event('change', { bubbles: true })); await settle();
	assert.deepEqual(started.at(-1), { automation: 'jobs.pipeline', input: { mode: 'import', file: 'f1' } });
	const first = `run-${started.length}`;
	set(first, { status: 'running' }); await settle();
	assert.equal(document.querySelector('[data-view-actions]').getAttribute('aria-busy'), 'true');
	set(first, { status: 'succeeded', result: { applied: false, findings: [{ row: 3, column: 'Day', message: 'a holiday', severity: 'warn' }] } }); await settle();
	assert.ok(document.querySelector('[data-view-menu]'), 'the menu opens on findings');
	assert.equal(row('import').dataset.status, 'review');
	assert.match(document.querySelector('[data-import-findings]').textContent, /Row 3 · Day: a holiday/);
	document.querySelector('[data-import-accept]').click(); await settle();
	assert.deepEqual(started.at(-1), { automation: 'jobs.pipeline', input: { mode: 'import', file: 'f1', accept: true } });
	set(`run-${started.length}`, { status: 'succeeded', result: { applied: true, created: 2, updated: 1, deleted: 0, findings: [] } }); await settle();
	assert.equal(row('import').dataset.status, 'done');
	assert.deepEqual(toasts.map((t) => [t.tone, t.text]), [['success', '2 created, 1 updated, 0 deleted']]);
});

test('an import whose findings refuse says nothing was imported, lists them, and offers no accept', async () => {
	const rows = new Map();
	const runs = (automation, { where }) => ({ current: undefined, error: undefined, subscribe(run) { run({ rows: rows.has(where.id.eq) ? [rows.get(where.id.eq)] : [], next: null }); return () => {}; } });
	rows.set('run-1', { id: 'run-1', automation: 'jobs.pipeline', status: 'succeeded', result: { applied: false, findings: [{ row: 2, column: 'hours', message: 'expected an integer', severity: 'refuse' }] } });
	const { bolt } = fakeBolt({ runs });
	const catalog = { jobs: { label: ['name'], fields: { name: { kind: 'text' } }, pipeline: { import: 'Jobs from a sheet' } } };
	const target = await show({ bolt, catalog, of: 'jobs', upload: async (file) => ({ id: 'f1', name: file.name, mime: file.type }) });
	const input = target.querySelector('[data-view-import]');
	Object.defineProperty(input, 'files', { value: [new File(['x'], 'jobs.xlsx')], configurable: true });
	input.dispatchEvent(new Event('change', { bubbles: true })); await settle();
	assert.equal(row('import').dataset.status, 'failed');
	assert.match(row('import').querySelector('[data-menu-error]').textContent, /Nothing was imported/);
	assert.match(document.querySelector('[data-import-findings]').textContent, /Row 2 · hours: expected an integer/);
	assert.equal(document.querySelector('[data-import-accept]'), null);
	assert.equal(toasts.at(-1).tone, 'error');
});

test("the toolbar's context rides on the pipeline's template and import runs", async () => {
	const { bolt, started } = fakeBolt();
	const catalog = { jobs: { label: ['name'], fields: { name: { kind: 'text' } }, pipeline: { import: 'Jobs from a sheet' } } };
	const target = await show({ bolt, catalog, of: 'jobs', context: { company_id: 'c1' }, upload: async (file) => ({ id: 'f1', name: file.name, mime: file.type }) });
	await open(); await press('template');
	assert.deepEqual(started.at(-1), { automation: 'jobs.pipeline', input: { mode: 'template', context: { company_id: 'c1' } } });
	const input = target.querySelector('[data-view-import]');
	Object.defineProperty(input, 'files', { value: [new File(['x'], 'jobs.xlsx')], configurable: true });
	input.dispatchEvent(new Event('change', { bubbles: true })); await settle();
	assert.deepEqual(started.at(-1), { automation: 'jobs.pipeline', input: { mode: 'import', file: 'f1', context: { company_id: 'c1' } } });
});
