// An own-row predicate (a check, a partial unique's `where`, a roll-up's `where`, a write's condition) → SQL over one
// row: literals and the row's own fields only, never a relation. With `fields` it is DDL: literals typed and inlined,
// two-valued; else literals are bound through `bind`.
import { Effect, Predicate } from 'effect';
import { literal as quote_literal } from '@norbital-ai/std/sql';
import { isArray } from 'effect/Array';
import type { Json } from '../values.ts';
import type { Arg, Pred } from '../ir.ts';
import { q, type FieldInfo } from '../catalog.ts';
import { StoreError } from '../errors.ts';
import { database_value, period_test } from '../read/values.ts';

/** What binds a literal of a statement being built: its `$n`. */
export type Binder = { p(v: Json): string };
const derive = (message: string) => Effect.fail(StoreError.of('invalid_where', 'derive', message));

export const own_pred_sql: (
	p: Pred,
	row: string,
	c: Binder,
	twoValued?: boolean,
	fields?: ReadonlyMap<string, FieldInfo>
) => Effect.Effect<string, StoreError> = Effect.fn('Store.own_pred_sql')(function* (
	p: Pred,
	row: string,
	c: Binder,
	twoValued = false,
	fields?: ReadonlyMap<string, FieldInfo>
) {
	const ddl = fields !== undefined;
	const col = (field: string) => {
		const name = fields?.get(field)?.column ?? field;
		return row === '' ? q(name) : row.endsWith('.') ? `${row}${q(name)}` : `(${row}).${q(name)}`;
	};
	const literal = (value: Json, type?: string): string => {
		if (!ddl) return c.p(database_value(value));
		if (value === null) return 'null';
		if (typeof value === 'boolean') return String(value);
		return `${quote_literal(String(typeof value === 'object' ? JSON.stringify(value) : value))}::${type ?? 'text'}`;
	};
	const val = (arg: Arg, field: string, type = fields?.get(field)?.pg) =>
		arg._tag === 'Field'
			? Effect.succeed(col(arg.field))
			: arg._tag === 'Lit'
				? Effect.succeed(literal(database_value(arg.value), type))
				: derive("a same-row where takes literals and the row's own fields only");
	const leaf = (sql: string) => (twoValued ? `coalesce(${sql}, false)` : ddl ? sql : `(${sql})`);
	const child = (pred: Pred) => own_pred_sql(pred, row, c, twoValued, fields);
	const OPS = {
		eq: '=',
		ne: ddl ? 'is distinct from' : 'IS DISTINCT FROM',
		lt: '<',
		lte: '<=',
		gt: '>',
		gte: '>='
	} as const;
	switch (p.t) {
		case 'const':
			return String(p.value);
		case 'and':
		case 'or':
			return p.of.length === 0
				? String(p.t === 'and')
				: `(${(yield* Effect.forEach(p.of, child)).join(` ${ddl ? p.t : p.t.toUpperCase()} `)})`;
		case 'not': {
			const body = yield* child(p.of);
			return ddl
				? `(not ${p.of.t === 'and' || p.of.t === 'or' || p.of.t === 'not' ? body : `(${body})`})`
				: `(NOT COALESCE(${body}, false))`;
		}
		case 'null':
			return ddl
				? `${col(p.field)} is ${p.is ? '' : 'not '}null`
				: `(${col(p.field)} IS ${p.is ? '' : 'NOT '}NULL)`;
		case 'cmp': {
			const sql = `${col(p.field)} ${OPS[p.op]} ${yield* val(p.arg, p.field)}`;
			return ddl && p.op === 'ne' ? sql : leaf(sql);
		}
		case 'in': {
			if (!isArray<typeof p.args>(p.args))
				return yield* derive('a same-row where takes literal lists only');
			if (fields !== undefined) {
				const type = fields.get(p.field)?.pg ?? 'text';
				if (!twoValued)
					return `${col(p.field)}${p.negated ? ' not' : ''} in (${p.args.map((value) => literal(database_value(value), type)).join(', ')})`;
				const hit = leaf(
					`${col(p.field)} = any(array[${p.args.map((value) => literal(database_value(value), type)).join(', ')}]::${type}[])`
				);
				return p.negated ? `not ${hit}` : hit;
			}
			return leaf(
				`${col(p.field)}::text ${p.negated ? 'NOT ' : ''}IN (SELECT jsonb_array_elements_text(${c.p(p.args.map((value) => database_value(value)))}::jsonb))`
			);
		}
		case 'like':
			return leaf(
				`${col(p.field)} ${ddl ? 'ilike' : 'ILIKE'} ${ddl ? quote_literal(p.pattern) : c.p(p.pattern)}`
			);
		case 'text': {
			const normalize = (value: string) =>
				p.mode === 'folded' ? `lower(${value})` : `regexp_replace(${value}, '\\D', '', 'g')`;
			return leaf(`${normalize(col(p.field))} = ${normalize(literal(p.value, 'text'))}`);
		}
		case 'age':
			return ddl
				? yield* derive(
						'database-clock age predicates belong to queries, not persistent schema rules'
					)
				: leaf(`${col(p.field)} < now() - ${literal(p.seconds, 'float8')} * interval '1 second'`);
		case 'has': {
			const values = [p.arg];
			const array = ddl
				? `array[${values.map((value) => literal(value, 'text')).join(', ')}]::text[]`
				: `ARRAY(SELECT jsonb_array_elements_text(${c.p(values)}::jsonb))`;
			return leaf(`${col(p.field)} @> ${array}`);
		}
		case 'period': {
			const field = fields?.get(p.field),
				date = field?.period_of === 'date',
				type = date ? 'date' : 'timestamptz';
			if (p.op === 'contains')
				return leaf(`${col(p.field)} @> ${yield* val(p.arg, p.field, type)}`);
			const range = `${date ? 'daterange' : 'tstzrange'}(${yield* val(p.lo, p.field, type)}, ${yield* val(p.hi, p.field, type)}, '${date ? '[]' : '[)'}')`;
			return leaf(period_test(p.op, col(p.field), range, date));
		}
		case 'json':
			return leaf(`${col(p.field)} @> ${literal(p.contains, 'jsonb')}`);
		case 'one':
		case 'many':
		case 'count':
		case 'agg':
			return yield* derive(`a same-row where cannot reach the relation '${p.rel}'`);
		default:
			return yield* derive(`a same-row where cannot use '${p.t}'`);
	}
});
