import { Effect, Option, Schema } from 'effect';
import { BoltError } from '../../protocol/errors.ts';
import type { LiveShape } from '../services.ts';
import type { Chain } from '../write/sql.ts';
import { decodeOne } from './rows.ts';
import { literal } from '@norbital-ai/store';
import type { RawDb } from '@norbital-ai/host-api';

/** The committed pre/post images shared by native writers and the live lane. */
export const Captured = Schema.Struct({
	model: Schema.String,
	id: Schema.String,
	op: Schema.Literals(['create', 'update', 'delete']),
	revision: Schema.Number,
	transaction: Schema.String.check(Schema.isPattern(/^\d+$/)),
	old: Schema.NullOr(Schema.Record(Schema.String, Schema.Json)),
	new: Schema.NullOr(Schema.Record(Schema.String, Schema.Json)),
	cause: Schema.Literals(['direct', 'cascade', 'derived', 'erased'])
});
export type Captured = typeof Captured.Type;
export const CapturedResult = Schema.Struct({ captured: Schema.Array(Captured) });
export type CommitPublication = LiveShape['publish'] | 'bootstrap';

type Image = (alias: string, side: 'old' | 'new') => string;
const columns = (model: string, before: string, after: string, image?: Image) => ({
	model: `${model}::text`,
	id: `coalesce(${after}.id, ${before}.id)::text`,
	op: `CASE WHEN ${before}.id IS NULL THEN 'create' WHEN ${after}.id IS NULL THEN 'delete' ELSE 'update' END::text`,
	revision: `coalesce((to_jsonb(${after})->>'revision')::bigint, (to_jsonb(${before})->>'revision')::bigint, 0)`,
	transaction: 'pg_current_xact_id()::text',
	old: `CASE WHEN ${before}.id IS NULL THEN NULL::jsonb ELSE ${image?.(before, 'old') ?? `to_jsonb(${before})`} END`,
	new: `CASE WHEN ${after}.id IS NULL THEN NULL::jsonb ELSE ${image?.(after, 'new') ?? `to_jsonb(${after})`} END`,
	cause: "'direct'::text"
});
/** A system-table mutation's RETURNING columns. `model` is a trusted SQL expression. */
export const capturedFields = (model: string): string => Object.entries(columns(model, 'old', 'new'))
	.map(([name, expression]) => `${expression} AS "${name}"`).join(', ');

/** A native DML piece keeps its own projection and registers its images with the same statement. */
export function capturePiece(
	c: Chain,
	name: string,
	model: string,
	statement: string,
	options: { readonly returning?: string | ((before: string, after: string) => string); readonly image?: Image } = {}
): string {
	const before = '__bolt_before', after = '__bolt_after';
	const fields = Object.entries(columns(literal(model), before, after, options.image))
		.flatMap(([name, expression]) => [`'${name}'`, expression]);
	c.captures.push(name);
	const returning = typeof options.returning === 'function' ? options.returning(before, after) : options.returning;
	return c.cte(name, `${statement} RETURNING WITH (OLD AS ${before}, NEW AS ${after})
		${returning ?? `coalesce(${after}.id, ${before}.id) AS id`},
		jsonb_build_object(${fields.join(', ')}) AS __bolt_capture`);
}
/** Every native row mutation registered by this statement, in piece order. */
export const captureRows = (c: Chain): string => c.captures.length === 0 ? "'[]'::jsonb"
	: `(SELECT coalesce(jsonb_agg(x.__bolt_capture ORDER BY x.piece), '[]'::jsonb)
		FROM (${c.captures.map((name, piece) => `SELECT ${piece} AS piece, __bolt_capture FROM ${name}`).join(' UNION ALL ')}) x)`;

/** Decode one native answer; active generations publish after commit, bootstrap has no subscriptions. */
export function nativeCommit<A extends typeof CapturedResult.Type>(
	write: RawDb['write'],
	publication: CommitPublication,
	c: Chain,
	schema: Schema.Decoder<A>,
	select = ''
) {
	return Effect.gen(function* () {
		const result = yield* decodeOne(schema, yield* write(c.sql(
			`${select === '' ? '' : `${select}, `}${captureRows(c)} AS captured`
		)));
		if (Option.isNone(result))
			return yield* Effect.fail(BoltError.make('corrupt', 'commit', 'a native statement returned no answer'));
		if (publication !== 'bootstrap') publication(result.value.captured);
		return result.value;
	}).pipe(Effect.withSpan('Bolt.nativeCommit'));
}
