// @ts-nocheck -- executed directly by Node with --experimental-strip-types.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
	and, compact, countOf, flat, heldChanges, label, like, matrixCells, msg, pivotGrid, progressOf, rangeText, searchRows,
	readState, readTableState, rowsOps, runFiles, series, show, writeTableState, cellKey, failed, pageRead, heavySelect, listSelect, unref, refOf,
} from '../src/views/model.ts';
import { guided, narrator, observe, HOLD_MS, target } from '../src/views/capture/capture.ts';

const bolt = { t: (k: string) => k };

test('no grant is a state of its own, never an empty page', () => {
	assert.deepEqual(readState(undefined, { code: 'forbidden', message: 'x' }), { kind: 'noAccess' });
	assert.deepEqual(readState({ rows: [], next: null }, undefined), { kind: 'ready', value: { rows: [], next: null } });
	assert.deepEqual(readState(undefined, undefined), { kind: 'loading' });
	assert.equal(readState(undefined, { code: 'tooLarge', message: 'big' }).kind, 'error');
	assert.deepEqual(failed(Object.assign(new Error('no'), { code: 'forbidden' })), { kind: 'noAccess' });
});

test('table cursor and search round-trip through the URL', () => {
	const p = writeTableState(new URLSearchParams('other=1'), 'quotes', { after: 'c1', q: 'acme' });
	assert.equal(p.get('other'), '1');
	assert.deepEqual(readTableState(p, 'quotes'), { after: 'c1', q: 'acme' });
	assert.equal(writeTableState(p, 'quotes', { after: null, q: '' }).toString(), 'other=1');
	assert.equal(and(undefined, {}, null), undefined);
	assert.deepEqual(and({ a: { eq: 1 } }, { b: { eq: 2 } }), { and: [{ a: { eq: 1 } }, { b: { eq: 2 } }] });
	assert.deepEqual(compact({ a: 1, b: undefined }), { a: 1 });
	assert.equal(like(3, '7'), 7);
	assert.deepEqual(searchRows([{ id: 'a', name: 'Acme' }, { id: 'b', name: 'Beta' }], 'ac', ['name']).map((r) => r.id), ['a']);
});

test('a later page stays live: one live read of every row up to it, sliced to its own', async () => {
	const lived = [];
	const fake = { live: (q) => { lived.push(q.read.a[1]); const v = { rows: Array.from({ length: q.read.a[1].limit }, (_, i) => ({ id: String(i) })), next: 'n' };
		return { current: v, error: undefined, subscribe: (run) => { run(v); return () => {}; } }; } };
	const read = (limit, after) => Object.assign(Promise.resolve({ rows: [{ id: 'once' }], next: null }), { read: { m: 'read', a: ['c', after === undefined ? { limit } : { limit, after }] } });
	assert.equal(pageRead(fake, read, 25, 0, null).current.rows.length, 25);
	const third = pageRead(fake, read, 25, 2, 'c2');
	assert.deepEqual(lived.at(-1), { limit: 75 });
	assert.deepEqual(third.current.rows.map((r) => r.id), Array.from({ length: 25 }, (_, i) => String(50 + i)));
	const restored = pageRead(fake, read, 25, null, 'c9'); // a cursor from the URL without its index: read once
	assert.equal(lived.length, 2);
	await new Promise((r) => setTimeout(r, 0));
	assert.equal(restored.current.rows[0].id, 'once');
});

test('range and count', () => {
	assert.equal(rangeText(bolt, 25, 25, 312), 'rows 26–50 of 312');
	assert.equal(rangeText(bolt, 0, 0, null), 'No rows');
	assert.equal(rangeText(bolt, 0, 1, 0), 'rows 1–1'); // a live row ahead of the 30 s count
	assert.equal(countOf([{ count: 12 }]), 12);
	assert.equal(countOf({ count: '7' }), 7);
	assert.equal(msg({ t: (k) => k === 'ui.table.next' ? 'Suivant' : k }, 'table.next', 'Next'), 'Suivant');
	assert.equal(label(bolt, 'leave_entries', 'start_part'), 'Start part');
});

test('values display by shape; masks are locked', () => {
	assert.equal(show({ $masked: true }), '•••');
	assert.equal(show({ $dec: '1234.5' }, 'en'), '1,234.5');
	assert.equal(show({ from: { $d: '2026-01-01' }, to: null }), '2026-01-01 – …');
	assert.equal(show({ id: 'f', name: 'a.pdf', mime: 'application/pdf' }), 'a.pdf');
	// `$bolt` decodes the wire: std's Decimal (no own fields, toJSON its text) and an instant's ISO text
	const dec = new (class { toJSON() { return '1234.5'; } })() as never;
	assert.equal(show(dec, 'en'), '1,234.5');
	assert.equal(pivotGrid([{ key: { k: 'a' }, sum: { amount: dec } }], 'k', undefined, { sum: 'amount' }).total, 1234.5);
	assert.equal(show('2026-01-02T03:04:05.000Z', 'en'), new Date('2026-01-02T03:04:05.000Z').toLocaleString('en', { dateStyle: 'medium', timeStyle: 'short' }));
});

test('Rows sends explicit ops; a delete is only what the viewer removed', () => {
	const loaded = [{ id: '1', qty: 1 }, { id: '2', qty: 2 }, { id: '3', qty: 3 }];
	const current = [{ id: '1', qty: 5 }, { id: '3', qty: 3 }, { qty: 9 }];
	assert.deepEqual(rowsOps(loaded, current, ['2']), { create: [{ qty: 9 }], update: [{ target: '1', set: { qty: 5 } }], delete: ['2'] });
	assert.deepEqual(rowsOps(loaded, current, []), { create: [{ qty: 9 }], update: [{ target: '1', set: { qty: 5 } }] });
});

test('a heavy column widens the list read to the default row plus it', () => {
	const ex = { label: ['name'], fields: { name: { kind: 'text' }, doc: { kind: 'file' }, raw: { kind: 'json' }, 'a.b': { kind: 'int' } }, relations: { owner: { targets: ['people'] } } };
	assert.equal(heavySelect(ex, ['name']), undefined);
	assert.equal(heavySelect(undefined, ['doc']), undefined);
	assert.deepEqual(heavySelect(ex, ['created_at', 'doc']), { name: true, owner: true, created_at: true, doc: true });
});

test('a FK column reads its target label in the page read and shows it beside the id', () => {
	const cat = {
		orders: { label: ['no'], fields: { no: { kind: 'text' }, customer: { kind: 'text' }, spec: { kind: 'json' } }, relations: { customer: { targets: ['customers'] }, arc: { targets: ['a', 'b'] } } },
		customers: { label: ['name', 'code', 'secret'], fields: { name: { kind: 'text' }, code: { kind: 'text' } } },
	};
	assert.equal(listSelect(cat, 'orders', ['no', 'arc']), undefined); // an arc keeps the plain read
	assert.deepEqual(listSelect(cat, 'orders', ['no', 'customer']), { no: true, customer: { select: { name: true, code: true } }, arc: true });
	assert.deepEqual(listSelect(cat, 'orders', ['customer'], []), undefined); // an authored cell keeps the id
	const [a, b] = unref(cat, 'orders', ['customer'], [{ id: 'o1', customer: { id: 'c1', name: 'Acme', code: 'A1' } }, { id: 'o2', customer: null }]);
	assert.equal(a.customer, 'c1');
	assert.deepEqual(refOf(a, 'customer'), { of: 'customers', text: 'Acme · A1' });
	assert.equal(b.customer, null);
	assert.equal(refOf(b, 'customer'), undefined);
});

test('Matrix buckets items per row and column; a relation column reads its id', () => {
	const cells = matrixCells([{ id: 'i1', employee: 'e1', day: { $d: '2026-09-01' } }, { id: 'i2', employee: 'e1', day: { $d: '2026-09-01' } }, { id: 'i3', employee: { collection: 'employees', id: 'e2' }, day: { $d: '2026-09-02' } }], 'employee', 'day');
	assert.deepEqual(cells.get(cellKey('e1', '2026-09-01'))?.map((r) => r.id), ['i1', 'i2']);
	assert.deepEqual(cells.get(cellKey('e2', '2026-09-02'))?.map((r) => r.id), ['i3']);
});

test('Pivot and Chart read aggregate rows', () => {
	const agg = [
		{ key: { region: 'N', stage: 'won' }, sum: { amount: { $dec: '10' } } },
		{ key: { region: 'N', stage: 'lost' }, sum: { amount: { $dec: '5' } } },
		{ key: { region: 'S', stage: 'won' }, sum: { amount: { $dec: '2.5' } } },
	];
	assert.deepEqual(flat(agg[0]), { region: 'N', stage: 'won', 'sum.amount': 10 });
	const g = pivotGrid(agg, 'region', 'stage', { sum: 'amount' });
	assert.deepEqual([g.rowKeys, g.colKeys, g.at('S', 'lost'), g.rowTotal('N'), g.colTotal('won'), g.total], [['N', 'S'], ['won', 'lost'], 0, 15, 12.5, 17.5]);
	assert.deepEqual(series({ rows: [{ key: { month: { $d: '2026-01-01' } }, count: 4 }], next: null }, 'month', ['count']), [{ month: '2026-01-01', count: 4 }]);
});

test('the approval view diffs the held revisions against the restore point', () => {
	// `bolt.history` as the host answers it: the hold revision carries the full pre-image, then the held writes
	const history = [
		{ revision: 1, approval_id: null, cause: 'seed', changed: { status: 'draft', amount: 10, note: null } },
		{ revision: 2, approval_id: null, cause: 'direct', changed: { amount: 12 } },
		{ revision: 2, approval_id: 'r1', cause: 'hold', changed: { id: 'x', status: 'draft', amount: 12, note: null, revision: 2 } },
		{ revision: 3, approval_id: 'r1', cause: 'direct', changed: { status: 'submitted', approval_id: 'r1' } },
		// a participant's edit rides the request; a field set back to its restore-point value is no change
		{ revision: 3, approval_id: 'r1', cause: 'hold', changed: { id: 'x', status: 'submitted', amount: 12, note: null, revision: 3 } },
		{ revision: 4, approval_id: 'r1', cause: 'direct', changed: { amount: 20, note: 'n' } },
		{ revision: 4, approval_id: 'r1', cause: 'hold', changed: { id: 'x', status: 'submitted', amount: 20, note: 'n', revision: 4 } },
		{ revision: 5, approval_id: 'r1', cause: 'direct', changed: { note: null } },
	];
	assert.deepEqual(heldChanges(history, 'r1'), [{ field: 'status', before: 'draft', held: 'submitted' }, { field: 'amount', before: 12, held: 20 }]);
	// a row the request created: its hold snapshot is null, so every field was nothing before
	assert.deepEqual(heldChanges([{ revision: 0, approval_id: 'r2', cause: 'hold', changed: null }, { revision: 1, approval_id: 'r2', cause: 'direct', changed: { id: 'y', status: 'new' } }], 'r2'),
		[{ field: 'status', before: null, held: 'new' }]);
	assert.deepEqual(heldChanges(history, 'other'), []);
});

test('run progress and returned files', () => {
	assert.equal(progressOf({ progress: { done: 1, total: 4 } }), 0.25);
	assert.equal(progressOf({ progress: 50 }), 0.5);
	assert.equal(progressOf({}), null);
	const f = { id: 'f1', name: 'bank.csv', mime: 'text/csv' };
	assert.deepEqual(runFiles({ result: { files: [f], count: 1 } }), [f]);
	assert.deepEqual(runFiles({ result: f }), [f]);
});

test('guided capture takes a pose only after a steady hold with a descriptor', () => {
	let s = guided(['straight', 'left']);
	const straight = { angle: { yaw: 0, pitch: 0 }, embedding: true };
	s = observe(s, straight, 0).state;
	assert.equal(observe(s, straight, HOLD_MS - 1).capture, null);
	assert.equal(observe(s, { ...straight, embedding: false }, HOLD_MS).state.heldSince, null);
	const step = observe(s, straight, HOLD_MS);
	assert.equal(step.capture, 'straight');
	assert.equal(target(step.state), 'left');
	// the person's left is negative yaw
	const left = observe(observe(step.state, { angle: { yaw: -0.4, pitch: 0 }, embedding: true }, 0).state, { angle: { yaw: -0.4, pitch: 0 }, embedding: true }, HOLD_MS);
	assert.equal(left.capture, 'left');
	assert.equal(target(left.state), null);
});

test('the narrator plays one clip at a time, skips missing clips, and evicts old phrases', async () => {
	const played = [];
	const clips = [];
	const play = (url) => { played.push(url); let done; const p = new Promise((r) => (done = r)); clips.push(done); return { done: p, stop: () => done('stopped') }; };
	const n = narrator(play, { a: { en: 'a.mp3' }, b: { en: 'b.mp3' }, c: { en: 'c.mp3' }, d: { en: 'd.mp3' } }, { locale: 'en' });
	n.say('a'); n.say('a'); n.say('b'); n.say('c'); n.say('d'); n.say('nothing');
	assert.deepEqual(played, ['a.mp3']);
	clips[0]('played');
	await new Promise((r) => setTimeout(r, 0));
	assert.deepEqual(played, ['a.mp3', 'd.mp3']);
	clips[1]('missing');
	await new Promise((r) => setTimeout(r, 0));
	n.say('d');
	assert.deepEqual(played, ['a.mp3', 'd.mp3']);
	assert.ok(n.missing.has('d.mp3'));
});

test('the record scrubber: history as checkpoints, and a ruler that compresses but keeps the playhead', async () => {
	const { checkpoints, tickAt, tickOf, drawnTicks } = await import('../src/views/model.ts');
	const history = [
		{ revision: 2, at: '2026-09-02T00:00:00.000Z', actor: { kind: 'system', id: 'run1' }, changed: { status: 'done', updated_at: 'x', revision: 2 } },
		{ revision: 1, at: '2026-09-01T00:00:00.000Z', actor: { kind: 'member', id: 'u1' }, changed: { title: 'Paint', id: 'j1' } },
		{ revision: 3, at: null, actor: null, changed: null },
	];
	assert.deepEqual(checkpoints(history), [
		{ revision: 1, at: '2026-09-01T00:00:00.000Z', actor: { kind: 'member', id: 'u1' }, fields: ['title'] },
		{ revision: 2, at: '2026-09-02T00:00:00.000Z', actor: { kind: 'system', id: 'run1' }, fields: ['status'] },
		{ revision: 3, at: null, actor: null, fields: [] },
	]);
	assert.deepEqual(checkpoints(null), []);
	assert.equal(tickAt(1, 5), 0);
	assert.equal(tickAt(5, 5), 100);
	assert.equal(tickAt(1, 1), 100);
	assert.equal(tickOf(0, 5), 1);
	assert.equal(tickOf(1, 5), 5);
	assert.equal(tickOf(0.5, 5), 3);
	assert.equal(tickOf(-2, 5), 1);
	assert.deepEqual(drawnTicks(4, 120), [1, 2, 3, 4]);
	const many = drawnTicks(1000, 100, 437);
	assert.ok(many.length <= 102);
	assert.ok(many.includes(1) && many.includes(1000) && many.includes(437));
});
