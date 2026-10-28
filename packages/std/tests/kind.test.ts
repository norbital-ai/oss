import assert from 'node:assert/strict';
import { describe, it } from '@effect/vitest';
import { Result, Schema } from 'effect';
import * as fc from 'fast-check';
import { Decimal } from '../src/decimal.ts';
import { IdValue, KIND, inputSchema, type FieldKind, type Kind } from '../src/kind.ts';

const decode = (k: Kind, v: unknown) => Schema.decodeUnknownResult(inputSchema(k))(v);
/** The wire form of an accepted value: decoded, then encoded. */
const wire = (k: Kind, v: unknown) =>
	Result.getOrThrow(Schema.encodeUnknownResult(inputSchema(k))(Result.getOrThrow(decode(k, v))));
const refused = (k: Kind, v: unknown) =>
	assert.equal(decode(k, v)._tag, 'Failure', `${JSON.stringify(k)} refuses ${JSON.stringify(v)}`);

const pad = (n: number) => String(n).padStart(2, '0');
const day = fc
	.date({
		min: new Date('1900-01-01T00:00:00Z'),
		max: new Date('2199-12-31T00:00:00Z'),
		noInvalidDate: true
	})
	.map((d) => d.toISOString().slice(0, 10));
const at = fc.date({
	min: new Date('1900-01-01T00:00:00Z'),
	max: new Date('2199-12-31T00:00:00Z'),
	noInvalidDate: true
});
const finite = fc.double({ noNaN: true, noDefaultInfinity: true });
const decimalText = fc.stringMatching(/^-?\d{1,12}(\.\d{1,8})?$/);
const decimalIn = fc.oneof(
	decimalText,
	decimalText.map(($dec) => ({ $dec })),
	finite,
	fc.integer()
);
/** JSON as a request body holds it: plain prototypes, no `__proto__` key. */
const json = fc
	.jsonValue({ maxDepth: 2 })
	.map((v): unknown => JSON.parse(JSON.stringify(v)))
	.filter((v) => !JSON.stringify(v).includes('"__proto__"'));
const key = fc.string().filter((k) => k !== '__proto__');
const addDays = (d: string, n: number) =>
	new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** One spec and one generator of accepted inputs per kind; every kind is here (asserted below). */
const CASES: { readonly [K in FieldKind]: readonly (readonly [Kind, fc.Arbitrary<unknown>])[] } = {
	text: [
		[{ kind: 'text', max: 40 }, fc.string({ maxLength: 40 })],
		[{ kind: 'text', format: 'email' }, fc.emailAddress()],
		[{ kind: 'text', many: true }, fc.array(fc.string())]
	],
	int: [[{ kind: 'int', min: -1000, max: 1000 }, fc.integer({ min: -1000, max: 1000 })]],
	number: [[{ kind: 'number' }, finite]],
	decimal: [[{ kind: 'decimal', scale: 8 }, decimalIn]],
	money: [[{ kind: 'money', currency: 'SGD' }, decimalIn]],
	sum: [[{ kind: 'sum', of: 'lines.amount' }, decimalIn]],
	count: [[{ kind: 'count', of: 'lines' }, fc.nat()]],
	duration: [[{ kind: 'duration' }, fc.integer()]],
	currency: [[{ kind: 'currency' }, fc.constantFrom('SGD', 'USD', 'JPY')]],
	bool: [[{ kind: 'bool' }, fc.boolean()]],
	date: [[{ kind: 'date' }, day]],
	instant: [
		[
			{ kind: 'instant' },
			fc.oneof(
				at.map((d) => d.toISOString()),
				at.map((d) => `${new Date(d.getTime() + 8 * 3_600_000).toISOString().slice(0, 19)}+08:00`)
			)
		]
	],
	time: [
		[
			{ kind: 'time' },
			fc
				.tuple(fc.integer({ min: 0, max: 23 }), fc.integer({ min: 0, max: 59 }))
				.map(([h, m]) => `${pad(h)}:${pad(m)}`)
		]
	],
	period: [
		[
			{ kind: 'period', of: 'date' },
			fc
				.tuple(day, fc.option(fc.nat(400), { nil: null }))
				.map(([from, n]) => ({ from, to: n === null ? null : addDays(from, n) }))
		],
		[
			{ kind: 'period', of: 'instant' },
			fc.tuple(at, fc.option(fc.integer({ min: 1, max: 1e9 }), { nil: null })).map(([s, n]) => ({
				start: s.toISOString(),
				end: n === null ? null : new Date(s.getTime() + n).toISOString()
			}))
		]
	],
	enum: [
		[{ kind: 'enum', values: ['a', 'b', 'c'] }, fc.constantFrom('a', 'b', 'c')],
		[{ kind: 'enum', values: ['a', 'b'], many: true }, fc.array(fc.constantFrom('a', 'b'))]
	],
	state: [
		[
			{ kind: 'state', initial: 'draft', states: { draft: { to: ['done'] }, done: {} } },
			fc.constantFrom('draft', 'done')
		]
	],
	seq: [
		[
			{ kind: 'seq', pattern: 'SO-{0000}' },
			fc.nat(9999).map((n) => `SO-${String(n).padStart(4, '0')}`)
		],
		[{ kind: 'seq' }, fc.nat()]
	],
	json: [
		[{ kind: 'json' }, json],
		[
			{
				kind: 'json',
				shape: {
					kind: 'object',
					fields: { qty: { kind: 'int' }, price: { kind: 'decimal', scale: 2 } }
				}
			},
			fc.record({ qty: fc.integer(), price: decimalIn })
		]
	],
	file: [
		[
			{ kind: 'file', accept: ['image/*'], max: '1MiB' },
			fc.record(
				{ id: fc.uuid(), name: fc.string(), mime: fc.constant('image/png'), size: fc.nat() },
				{ requiredKeys: ['id', 'name', 'mime'] }
			)
		],
		[
			{ kind: 'file', accept: ['image/*'], max: '1MiB', multiple: true },
			fc.array(fc.record({ id: fc.uuid(), name: fc.string(), mime: fc.constant('image/png') }))
		]
	],
	point: [[{ kind: 'point' }, fc.record({ lat: finite, lng: finite })]],
	vector: [
		[{ kind: 'vector', dim: 3, metric: 'cosine' }, fc.array(finite, { minLength: 3, maxLength: 3 })]
	],
	custom: [[{ kind: 'custom', of: 'money' }, json]],
	id: [[{ kind: 'id', of: 'orders' }, fc.uuid()]],
	ref: [
		[{ kind: 'ref', to: 'orders' }, fc.string()],
		[
			{ kind: 'ref', to: ['orders', 'quotes'] },
			fc.record({ model: fc.constantFrom('orders', 'quotes'), id: fc.string() })
		]
	],
	list: [
		[
			{ kind: 'list', of: { kind: 'decimal', scale: 2 }, max: 5 },
			fc.array(decimalIn, { maxLength: 5 })
		]
	],
	object: [
		[
			{
				kind: 'object',
				fields: {
					a: { kind: 'text' },
					b: { kind: 'int', optional: true },
					c: { kind: 'date', default: { var: 'today' } }
				}
			},
			fc.record(
				{ a: fc.string(), b: fc.option(fc.integer(), { nil: null }), c: day },
				{ requiredKeys: ['a'] }
			)
		]
	],
	union: [
		[
			{
				kind: 'union',
				by: 'type',
				arms: { cash: { amount: { kind: 'decimal', scale: 2 } }, card: { last4: { kind: 'text' } } }
			},
			fc.oneof(
				fc.record({ type: fc.constant('cash'), amount: decimalIn }),
				fc.record({ type: fc.constant('card'), last4: fc.string() })
			)
		],
		[
			{ kind: 'union', of: [{ kind: 'bool' }, { kind: 'int' }, { kind: 'text' }] },
			fc.oneof(fc.boolean(), fc.integer(), fc.string())
		]
	],
	record: [
		[
			{ kind: 'record', of: { kind: 'int' } },
			fc.dictionary(key, fc.integer(), { noNullPrototype: true })
		]
	]
};

describe('std/kind', () => {
	it('the primitive ID codec preserves the kind decoder values and refusals', () => {
		const primitive = Schema.decodeUnknownResult(IdValue);
		const kind = { kind: 'id', of: 'orders' } as const;
		const cases: readonly (readonly [unknown, boolean])[] = [
			['12345678-1234-1234-1234-123456789abc', true],
			['ABCDEF12-ABCD-ABCD-ABCD-ABCDEF123456', true],
			['00000000-0000-0000-0000-000000000000', true],
			['not-an-id', false],
			['12345678-1234-1234-1234-123456789abg', false],
			['12345678123412341234123456789abc', false],
			[' 12345678-1234-1234-1234-123456789abc', false],
			['12345678-1234-1234-1234-123456789abc ', false],
			[null, false],
			[undefined, false],
			[123, false],
			[true, false],
			[{}, false],
			[[], false]
		];
		for (const [value, accepted] of cases) {
			const actual = primitive(value);
			const catalogue = decode(kind, value);
			assert.equal(Result.isSuccess(actual), accepted);
			assert.equal(actual._tag, catalogue._tag);
			if (Result.isSuccess(actual)) assert.deepEqual(Result.getOrThrow(catalogue), actual.success);
			else {
				assert.ok(Result.isFailure(catalogue));
				assert.equal(String(actual.failure), String(catalogue.failure));
			}
		}
	});

	it('canonicalises negative zero through scalar, point and vector JSON codecs', () => {
		for (const kind of ['int', 'number', 'duration'] as const)
			assert.equal(Object.is(wire({ kind }, -0), 0), true);
		assert.equal(Object.is(wire({ kind: 'count', of: 'orders' }, -0), 0), true);
		assert.deepEqual(wire({ kind: 'point' }, { lat: -0, lng: -0 }), { lat: 0, lng: 0 });
		assert.deepEqual(wire({ kind: 'vector', dim: 2, metric: 'l2' }, [-0, 1]), [0, 1]);
	});
	it('has a case for every kind', () =>
		assert.deepEqual(Object.keys(CASES).sort(), Object.keys(KIND).sort()));

	for (const [name, cases] of Object.entries(CASES))
		it(`${name}: accepted inputs encode to wire that is JSON and a fixed point`, () => {
			for (const [k, arb] of cases)
				fc.assert(
					fc.property(arb, (v) => {
						const w = wire(k, v);
						assert.deepEqual(JSON.parse(JSON.stringify(w)), w);
						assert.deepEqual(wire(k, w), w);
					})
				);
		});

	it('decodes to std values: decimals exact, instants canonical UTC, open periods closed with null', () => {
		const amount = Result.getOrThrow(decode({ kind: 'decimal', scale: 2 }, { $dec: '1.20' }));
		assert.ok(amount instanceof Decimal && amount.toString() === '1.20');
		assert.equal(String(Result.getOrThrow(decode({ kind: 'money' }, 0.1))), '0.1');
		assert.equal(
			String(Result.getOrThrow(decode({ kind: 'decimal', scale: 8 }, 1.5e-7))),
			'0.00000015'
		);
		assert.deepEqual(wire({ kind: 'decimal', scale: 2 }, '-3.50'), { $dec: '-3.50' });
		assert.equal(
			Result.getOrThrow(decode({ kind: 'instant' }, '2026-01-01T08:00:00+08:00')),
			'2026-01-01T00:00:00.000Z'
		);
		assert.deepEqual(
			Result.getOrThrow(decode({ kind: 'period', of: 'date' }, { from: '2026-01-01' })),
			{ from: '2026-01-01', to: null }
		);
		assert.equal(Result.getOrThrow(decode({ kind: 'text', optional: true }, null)), null);
	});

	it('refuses what each kind refuses, the old wire tags included', () => {
		refused({ kind: 'text', max: 3 }, 'abcd');
		refused({ kind: 'text', format: 'email' }, 'not an email');
		refused({ kind: 'int', max: 10 }, 11);
		refused({ kind: 'int' }, 1.5);
		refused({ kind: 'decimal', scale: 2 }, 'abc');
		refused({ kind: 'decimal', scale: 2 }, { $dec: '1e3' });
		refused({ kind: 'decimal', scale: 2 }, Number.NaN);
		refused({ kind: 'date' }, '2026-02-30');
		refused({ kind: 'date' }, { $d: '2026-01-01' });
		refused({ kind: 'instant' }, { $t: '2026-01-01T00:00:00.000Z' });
		refused({ kind: 'instant' }, 'never');
		refused({ kind: 'time' }, '24:00');
		refused({ kind: 'period', of: 'date' }, { from: '2026-02-01', to: '2026-01-01' });
		refused(
			{ kind: 'period', of: 'instant' },
			{ start: '2026-01-01T00:00:00.000Z', end: '2026-01-01T00:00:00.000Z' }
		);
		refused({ kind: 'enum', values: ['a'] }, 'b');
		refused({ kind: 'state', initial: 'a', states: { a: {} } }, 'b');
		refused({ kind: 'vector', dim: 2, metric: 'l2' }, [1, 2, 3]);
		refused({ kind: 'id', of: 'orders' }, 'o-1');
		refused({ kind: 'list', of: { kind: 'int' }, max: 1 }, [1, 2]);
		refused({ kind: 'object', fields: { a: { kind: 'text' } } }, {});
		refused({ kind: 'object', fields: { a: { kind: 'text' } } }, { a: null });
		refused({ kind: 'union', by: 'type', arms: { cash: {} } }, { type: 'card' });
		refused({ kind: 'text' }, null);
	});

	it('states each trait once, duration numeric', () => {
		const having = (t: 'numeric' | 'ordered' | 'summable' | 'sortable') =>
			Object.entries(KIND)
				.filter(([, e]) => e.traits[t])
				.map(([k]) => k)
				.sort();
		assert.deepEqual(having('numeric'), [
			'count',
			'decimal',
			'duration',
			'int',
			'money',
			'number',
			'sum'
		]);
		assert.deepEqual(having('summable'), having('numeric'));
		assert.deepEqual(having('ordered'), [
			'count',
			'date',
			'decimal',
			'duration',
			'instant',
			'int',
			'money',
			'number',
			'sum',
			'text',
			'time'
		]);
		assert.deepEqual(
			Object.keys(KIND)
				.filter((k) => !KIND[k as FieldKind].traits.sortable)
				.sort(),
			['custom', 'file', 'json', 'list', 'object', 'period', 'point', 'record', 'union', 'vector']
		);
	});

	it('memoises per spec object', () => {
		const spec: Kind = { kind: 'list', of: { kind: 'int' } };
		assert.equal(inputSchema(spec), inputSchema(spec));
	});
});
