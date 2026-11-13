import assert from 'node:assert/strict';
import { describe, it } from '@effect/vitest';
import { compile, context, evaluate, formula } from '../src/lang/formula.ts';
import { BigDecimal, Effect, Schema } from 'effect';
import { input_schema } from '../src/lang/kind.ts';

describe('native kind values', () => {
	it.effect('nested stored lists and objects decode decimals exactly with ISO dates', () =>
		Effect.gen(function* () {
			const schema = input_schema({
				kind: 'object',
				fields: {
					lines: {
						kind: 'object',
						fields: { amount: { kind: 'decimal', scale: 2 }, day: { kind: 'date' } },
						many: true
					}
				}
			});
			const value = yield* Schema.decodeUnknownEffect(schema)({
				lines: [{ amount: '12345678901234567.89', day: '2026-10-15' }]
			});
			assert.deepEqual(value, {
				lines: [{ amount: '12345678901234567.89', day: '2026-10-15' }]
			});
		})
	);
	it.effect(
		'required fields reject null even when one union arm is optional, while descendants remain optional',
		() =>
			Effect.gen(function* () {
				const schema = input_schema({
					kind: 'object',
					fields: {
						choice: { kind: 'union', of: [{ kind: 'text', optional: true }, { kind: 'int' }] },
						details: { kind: 'object', fields: { note: { kind: 'text', optional: true } } }
					}
				});
				const refused = yield* Schema.decodeUnknownEffect(schema)({
					choice: null,
					details: {}
				}).pipe(Effect.result);
				assert.equal(refused._tag, 'Failure');
				const accepted = yield* Schema.decodeUnknownEffect(schema)({
					choice: 'yes',
					details: { note: null }
				});
				assert.deepEqual(accepted, { choice: 'yes', details: { note: null } });
			})
	);
});

describe('formula', () => {
	const person = {
		kind: 'object',
		fields: {
			age: { kind: 'int' },
			salary: { kind: 'money' },
			kids: { kind: 'object', fields: { age: { kind: 'int' } }, many: true }
		}
	} as const;
	const site = context(
		{ person, base: { kind: 'money' }, day: { kind: 'date' } },
		{
			functions: {
				adults: {
					signature: 'map.adults(int): int',
					fn: (p: { kids: { age: bigint }[] }, age: bigint) =>
						BigInt(p.kids.filter((k) => k.age >= age).length)
				}
			}
		}
	);
	const values = {
		person: { age: 40, salary: '5000.00', kids: [{ age: 20 }, { age: 3 }] },
		base: '1000.10',
		day: '2026-09-25'
	};
	const run = <T extends 'bool' | 'decimal' | 'int' | 'date' | 'text'>(text: string, result: T) => {
		const c = compile(site, text, result);
		if ('error' in c) throw new Error(c.error);
		return evaluate(c, values);
	};
	const exact = (text: string) => BigDecimal.format(run(text, 'decimal'));
	it('evaluates exact decimals', () => {
		assert.equal(exact('base * 0.17 + person.salary / 3'), '1836.683666666667');
		assert.equal(exact('round(base * 0.17, 2)'), '170.02');
		assert.equal(run('person.salary > base && person.age >= 40', 'bool'), true);
		assert.equal(run('person.adults(18)', 'int'), 1);
		assert.equal(run('day', 'date'), '2026-09-25');
		assert.equal(exact('base + 1'), '1001.1');
	});
	it('names the unknown path, the syntax fault and the wrong type at compile', () => {
		assert.deepEqual(compile(site, 'person.agex > 3', 'bool'), {
			error: 'unknown path person.agex'
		});
		const syntax = compile(site, 'person.kids.size() >', 'bool');
		assert.ok('error' in syntax);
		assert.match(syntax.error, /./);
		const resultType = compile(site, 'base * 2', 'bool');
		assert.ok('error' in resultType);
		assert.match(resultType.error, /expected a yes\/no result, got Decimal/);
		const unknown = compile(site, 'nobody + 1', 'decimal');
		assert.ok('error' in unknown);
		assert.match(unknown.error, /nobody/);
		assert.equal(formula(site, 'bool')('person.age > 18'), undefined);
		assert.equal(formula(site, 'bool')('person.nope'), 'unknown path person.nope');
		// the walk reaches every operand position: call arguments, receivers, ternaries, lists and maps
		for (const text of [
			'round(person.nope, 2) > 1',
			'person.nope.size() > 0',
			'base > 1 ? person.nope : 1',
			'[person.nope].size() > 0',
			'{"a": person.nope}.size() > 0',
			'!(person.nope)'
		])
			assert.equal(formula(site, 'bool')(text), 'unknown path person.nope', text);
	});
	it('keeps float mode for law written against doubles', () => {
		const law = context(
			{ wage: { kind: 'decimal', scale: 2 }, age: { kind: 'int' } },
			{ numbers: 'float' }
		);
		const c = compile(law, 'wage * 0.2 + age * 2', 'decimal');
		assert.ok(!('error' in c));
		assert.equal(evaluate(c, { wage: '100.5', age: 3 }), 26.1);
	});
	it('types a derived root builder (M1)', () => {
		const derived = context(
			{ age: { kind: 'int' } },
			{
				derive: (rows: { birth: string }[]) => {
					const person = rows[0];
					assert.ok(person);
					return { age: 2026 - Number(person.birth.slice(0, 4)) };
				}
			}
		);
		const c = compile(derived, 'age >= 18', 'bool');
		assert.ok(!('error' in c) && evaluate(c, derived.derive([{ birth: '2000-01-01' }])) === true);
	});
});
