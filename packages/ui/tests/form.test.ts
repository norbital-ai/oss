import assert from 'node:assert/strict';
import test from 'node:test';
import './resolve.ts';

const d = await import('../src/form/draft.ts');

const exposure = {
	label: ['title'],
	fields: {
		title: { kind: 'text' }, total: { kind: 'money', currency: 'SGD' }, note: { kind: 'text', optional: true },
		status: { kind: 'state', initial: 'draft', states: { draft: { to: ['submitted'] }, submitted: { edit: ['note'] } } }
	},
	relations: { account: { targets: ['accounts'] } },
	create: { columns: ['title', 'total', 'note', 'account'] },
	update: { columns: ['title', 'total', 'note'] },
	actions: { hire: { input: { name: { kind: 'text' }, start: { kind: 'date' } } }, close: { input: { reason: { kind: 'text', optional: true } }, target: 'record' } }
} as const;
const text = { pendingApproval: 'held', conflict: 'conflict', unknown: 'unknown' };

test('a create form is the create allowlist, relations as pickers', () => {
	const spec = d.formSpec('quotes', exposure, 'create')!;
	assert.equal(spec.callable, 'quotes.create');
	assert.deepEqual(spec.fields.map((f) => f.name), ['title', 'total', 'note', 'account']);
	assert.deepEqual(spec.fields[3]!.kind, { kind: 'id', of: 'accounts' });
	assert.equal(d.formSpec('quotes', { ...exposure, create: undefined }, 'create'), null);
	assert.equal(d.formSpec('quotes', undefined, 'create'), null);
});

test('an update sends only changed fields; nothing changed sends nothing', () => {
	const spec = d.formSpec('quotes', exposure, 'update', 'q1')!;
	const base = d.startValues(spec, { id: 'q1', title: 'A', total: { $dec: '10.00' }, note: null });
	assert.deepEqual(base, { title: 'A', total: '10.00', note: null });
	assert.equal(d.payload(spec, base, base), null);
	assert.deepEqual(d.payload(spec, base, { ...base, note: 'x' }), { target: 'q1', set: { note: 'x' } });
});

test('a create omits nulls so defaults apply; an action wraps a record target', () => {
	const create = d.formSpec('quotes', exposure, 'create')!;
	assert.deepEqual(d.payload(create, {}, { title: 'A', total: '1', note: null, account: 'a1' }), { title: 'A', total: '1', account: 'a1' });
	const hire = d.formSpec({ action: 'quotes.hire' }, exposure, 'create')!;
	assert.deepEqual(d.payload(hire, {}, { name: 'N', start: '2026-01-01' }), { name: 'N', start: '2026-01-01' });
	const close = d.formSpec({ action: 'quotes.close' }, exposure, 'create', 'q1')!;
	assert.equal(close.callable, 'quotes.close');
	assert.deepEqual(d.payload(close, {}, { reason: null }), { target: 'q1', input: {} });
});

test('advisory check blocks what decode would refuse, by path', () => {
	const spec = d.formSpec('quotes', exposure, 'create')!;
	const problems = d.check(spec, { title: null, total: 'abc', note: null, account: 'a1' });
	assert.deepEqual([...problems], [['title', 'is required'], ['total', 'expected a decimal']]);
});

test('a refusal lands on its field; an unowned one on the form; the draft is kept', () => {
	const spec = d.formSpec('quotes', exposure, 'update', 'q1')!;
	const base = { title: 'A', total: '1', note: null }, sent = { ...base, total: '2' };
	const onField = d.settle(spec, base, sent, { kind: 'refused', code: 'check', message: 'Too small', field: 'total' }, text);
	assert.equal(onField.draft, null);
	assert.deepEqual([...onField.errors], [['total', 'Too small']]);
	assert.equal(onField.notice, null);
	const onForm = d.settle(spec, base, sent, { kind: 'refused', code: 'forbidden', message: 'No', field: 'secret' }, text);
	assert.deepEqual(onForm.notice, { tone: 'danger', text: 'No' });
	assert.equal(onForm.newKey, true);
});

test('committed: an update re-bases on what was sent; a create resets to defaults', () => {
	const upd = d.formSpec('quotes', exposure, 'update', 'q1')!;
	const s = d.settle(upd, { title: 'A', total: '1', note: null }, { title: 'B', total: '1', note: null }, { kind: 'committed', output: null, records: [] }, text);
	assert.equal(s.draft, null);
	assert.deepEqual(s.base, { title: 'B', total: '1', note: null });
	const create = d.formSpec('quotes', exposure, 'create')!;
	const c = d.settle(create, {}, { title: 'B', total: '1', note: null, account: 'a' }, { kind: 'pendingApproval', requestId: 'r', records: [] }, text);
	assert.deepEqual(c.draft, { title: null, total: null, note: null, account: null });
	assert.deepEqual(c.notice, { tone: 'info', text: 'held' });
});

test('only an unknown outcome retries under the same key; a conflict marks the fields', () => {
	const spec = d.formSpec('quotes', exposure, 'update', 'q1')!;
	const base = { title: 'A', total: '1', note: null };
	assert.equal(d.settle(spec, base, base, { kind: 'unknown', invocation: 'k' }, text).newKey, false);
	const c = d.settle(spec, base, base, { kind: 'conflict', records: [{ collection: 'quotes', id: 'q1', fields: ['title'] }] }, text);
	assert.deepEqual([...c.errors], [['title', 'conflict']]);
	assert.equal(c.newKey, true);
});

test('a state lock makes fields read-only as advice', () => {
	const lock = d.locked(exposure.fields, { status: 'submitted' });
	assert.equal(lock('note'), false);
	assert.equal(lock('total'), true);
	assert.equal(d.locked(exposure.fields, null)('total'), false);
	assert.equal(d.locked(exposure.fields, { status: 'draft' })('total'), false);
	assert.equal(lock('status'), false, 'the state field still moves along `to`');
});

test('a hidden field has no editor, so the advisory check leaves it to the host', () => {
	const spec = { ...d.formSpec('quotes', exposure, 'create')!, fields: [{ name: 'key', kind: { kind: 'text', hidden: true } as const }] };
	assert.equal(d.check(spec, { key: null }).size, 0);
});

test('an update the caller only reads is the read-only form of its readable fields', () => {
	const spec = d.formSpec('quotes', { ...exposure, update: undefined }, 'update', 'q1')!;
	assert.equal(spec.readonly, true);
	assert.deepEqual(spec.fields.map((f) => f.name), ['title', 'total', 'note', 'status', 'account']);
	assert.equal(d.formSpec('quotes', exposure, 'update', 'q1')!.readonly, undefined);
});
