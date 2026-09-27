import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { facts, validateFacts, type FactSpec } from '../src/facts.ts';
import { label } from '../src/label.ts';

describe('std/facts', () => {
	const specs: FactSpec[] = [
		{ key: 'dependants', type: 'number', label: 'Dependants', integer: true, minimum: 0, maximum: 9 },
		{ key: 'resident', type: 'boolean', required: true },
		{ key: 'status', type: 'string', options: ['K0', 'K1'] },
	];
	it('accepts sound declarations and refuses a bad one with its key', () => {
		assert.equal(facts(specs), specs);
		assert.throws(() => facts([...specs, { key: 'resident', type: 'boolean' }]), /resident: each key is declared once/);
		assert.throws(() => facts([{ key: 'x', type: 'string', minimum: 1 }]), /numeric constraints/);
		assert.throws(() => facts([{ key: 'x', type: 'number', required: true, default_value: 1 }]), /required or has a default/);
		assert.throws(() => facts([{ key: 'x', type: 'string', options: ['a'], default_value: 'b' }]), /must be one of/);
		assert.throws(() => facts([{ key: '1x', type: 'string' }]), /a key is/);
	});
	it('validates values: undeclared keys, types, constraints; required only when complete', () => {
		assert.equal(validateFacts(specs, { dependants: 2, status: 'K1' }), null);
		assert.equal(validateFacts(specs, { dependants: 2 }, { complete: true }), 'resident is required.');
		assert.equal(validateFacts(specs, { dependants: 1.5 }), 'Dependants must be a whole number.');
		assert.equal(validateFacts(specs, { dependants: '2' }), 'Dependants must be a number; this value is a string.');
		assert.equal(validateFacts(specs, { status: 'K9' }), 'status must be one of: K0, K1.');
		assert.equal(validateFacts(specs, { other: 1 }), 'other is not a declared fact.');
	});
});

describe('std/label', () => {
	it('joins the label paths per kind, dropping empty terms, uuids and blobs', () => {
		const row = { code: 'Q-7', customer: { label: 'Acme' }, at: '2026-03-01T00:00:00Z', total: { $dec: '10.50' }, meta: '{"a":1}', holder: '0190f1e2-3c4d-7e8f-9a0b-1c2d3e4f5a6b' };
		assert.equal(label(row, ['code', 'customer', 'at', 'total', 'meta', 'holder', 'missing']), 'Q-7 · Acme · 2026-03-01 · 10.50');
		assert.equal(label({ at: '2026-03-01T09:30:00Z' }, ['at']), '2026-03-01 09:30');
		assert.equal(label({ customer: { name: 'Acme' } }, ['customer.name']), 'Acme');
	});
	it('is null, never the id, when nothing names the record', () => {
		assert.equal(label({ id: '0190f1e2-3c4d-7e8f-9a0b-1c2d3e4f5a6b', name: '  ' }, ['name']), null);
	});
	it('formats through the caller\'s per-kind `show`', () => {
		assert.equal(label({ amount: '5' }, ['amount'], (_p, v) => `$${String(v)}.00`), '$5.00');
	});
});
