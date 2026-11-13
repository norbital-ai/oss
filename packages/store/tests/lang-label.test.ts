import assert from 'node:assert/strict';
import { describe, it } from '@effect/vitest';
import { label, label_expression, label_paths } from '../src/lang/label.ts';

describe('std/label', () => {
	it('evaluates CEL from the record and reports the fields needed to read it', () => {
		const expression = "record.code + ' · ' + (record.name != null ? record.name : 'Unnamed')";
		assert.deepEqual(label_paths(expression), ['code', 'name']);
		assert.equal(label({ code: 'Q-7', name: 'Acme' }, expression), 'Q-7 · Acme');
		assert.equal(label({ code: 'Q-7', name: null }, expression), 'Q-7 · Unnamed');
		assert.equal(label({ customer: { name: 'Acme' } }, 'record.customer.name'), 'Acme');
		assert.equal(
			label({ amount: '10.50' }, "'Total ' + string(record.amount)"),
			'Total 10.50'
		);
		assert.equal(
			label(
				{ code: 'Q-7', name: 'Acme' },
				"[record.code, record.name].filter(x, x != null).join(' · ')"
			),
			'Q-7 · Acme'
		);
		assert.deepEqual(label_paths("[record.code].map(x, x + record.name).join('')"), [
			'code',
			'name'
		]);
		assert.ok('error' in label_expression('record.name +'));
		assert.ok('error' in label_expression('42'));
		assert.equal(label({}, 'record.missing'), null);
	});
	it('joins the label paths per kind, dropping empty terms, uuids and blobs', () => {
		const row = {
			code: 'Q-7',
			customer: { label: 'Acme' },
			at: '2026-03-01T00:00:00Z',
			total: '10.50',
			meta: '{"a":1}',
			holder: '0190f1e2-3c4d-7e8f-9a0b-1c2d3e4f5a6b'
		};
		assert.equal(
			label(row, ['code', 'customer', 'at', 'total', 'meta', 'holder', 'missing']),
			'Q-7 · Acme · 2026-03-01 · 10.50'
		);
		assert.equal(label({ at: '2026-03-01T09:30:00Z' }, ['at']), '2026-03-01 09:30');
		assert.equal(label({ customer: { name: 'Acme' } }, ['customer.name']), 'Acme');
	});
	it('uses the id when no label is declared or usable', () => {
		assert.equal(
			label({ id: '0190f1e2-3c4d-7e8f-9a0b-1c2d3e4f5a6b', name: '  ' }, ['name']),
			'0190f1e2-3c4d-7e8f-9a0b-1c2d3e4f5a6b'
		);
		assert.equal(
			label({ id: '0190f1e2-3c4d-7e8f-9a0b-1c2d3e4f5a6b' }, []),
			'0190f1e2-3c4d-7e8f-9a0b-1c2d3e4f5a6b'
		);
	});
	it("formats through the caller's per-kind `show`", () => {
		assert.equal(
			label({ amount: '5' }, ['amount'], (_p, v) => `$${String(v)}.00`),
			'$5.00'
		);
	});
});
