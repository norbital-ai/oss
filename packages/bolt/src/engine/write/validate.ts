// Write materialization, custom-field validation, and pure search vector indexing.
import { Array as EffectArray, Effect, Schema } from 'effect';
import { index_column } from '@norbital-ai/store';
import type { Json } from '../../decl/values.ts';
import { BoltError } from '../../protocol/errors.ts';
import {
	LIMITS,
	type CrossAnswer,
	type InputPath,
	type Invocation,
	type Outcome,
	type RowData
} from '../contracts.ts';
import { storedChanges } from '../db/stored.ts';
import type { EngineError } from '../errors.ts';
import type { ActRequest, Bridge, GuestShape as GuestPort } from '../services.ts';
import { stateStamps, withDefaults } from './flatten.ts';
import {
	appRules,
	guest_context,
	guest_port,
	guestFailure,
	k,
	missing_record,
	refused,
	type DraftPlan,
	type DraftWrite,
	type ImportRow,
	type PlanInput,
	type PreparedPlan,
	type StoppedPlan,
	type WriteEngine
} from './shared.ts';

export const validateCustom = Effect.fn('Bolt.validateCustom')(function* (
	e: WriteEngine,
	r: ActRequest,
	writes: readonly DraftWrite[]
) {
	const m = e.manifest,
		byKind = new Map<
			string,
			{
				value: Json;
				path: InputPath;
			}[]
		>();
	for (const { write: w, item } of writes) {
		if (w.op === 'delete') continue;
		for (const [f, v] of Object.entries(w.op === 'create' ? w.values : w.set)) {
			const spec = m.models[w.model]?.fields[f];
			if (
				spec?.kind !== 'custom' ||
				v === null ||
				m.custom_fields[spec.of]?.check !== true
			)
				continue;
			const values = byKind.get(spec.of) ?? [];
			byKind.set(spec.of, values);
			for (const x of spec.many && EffectArray.isArray<typeof v>(v) ? v : [v])
				values.push({ value: x, path: [...item.change.path, f] });
		}
	}
	if (byKind.size === 0) return null;
	const port = yield* guest_port(e.guest);
	const kinds = [...byKind];
	const outcomes = yield* port.invokeEach(
		{
			id: `${r.invocationId}:validate`,
			kind: 'validation',
			ctx: guest_context(r.authority.actor, r.bindings, r.invocationId),
			budget: { crossings: LIMITS.crossings.sync, readBytes: LIMITS.readBytes }
		},
		kinds.map(([of, values]) => ({ target: of, input: values.map((x) => x.value) })),
		{
			cross: (calls: Parameters<Bridge['cross']>[0]) =>
				Effect.succeed(
					calls.map((): CrossAnswer => ({
						ok: false,
						error: { kind: 'bolt', code: 'no_bridge', message: 'a validation reads nothing' }
					}))
				)
		}
	);
	for (const [index, [of, values]] of kinds.entries()) {
		const first = values[0],
			g = outcomes[index];
		if (first === undefined) continue;
		if (g === undefined)
			return yield* BoltError.make('bad_answer', 'guest', `${of}: validation answered nothing.`);
		if (g.kind === 'failed') return yield* guestFailure(g.error);
		if (g.kind === 'refused') return refused('invalid_input', g.message, first.path);
		const out = yield* Schema.decodeUnknownEffect(Schema.Array(Schema.NullOr(Schema.String)))(
			g.output
		).pipe(
			Effect.mapError((error) => BoltError.make('bad_answer', 'guest', `${of}: ${error.message}`, error))
		);
		if (out.length !== values.length)
			return yield* BoltError.make(
				'bad_answer',
				'guest',
				`${of}: validation returns one answer per value.`
			);
		for (const [at, message] of out.entries()) {
			if (message === null) continue;
			const value = values[at];
			if (value === undefined)
				return yield* BoltError.make('bad_answer', 'guest', `${of}: validation named no input value.`);
			return refused('invalid_input', message, value.path);
		}
	}
	return null;
});

/**
 * Pure search indexes' vectors, guest-evaluated in one isolate run: one part per index and batch (at most
 * `LIMITS.writeChunk` rows), one vector list per part. An act joins them into its row writes, `bolt.index` backfills
 * seeded rows with them. `failed` is the guest's failure, for the caller to map.
 */
export const pureVectors = Effect.fn('Bolt.pureVectors')(function* (
	guest: GuestPort,
	parts: readonly {
		readonly model: string;
		readonly name: string;
		readonly dim: number;
		readonly rows: readonly RowData[];
	}[],
	ctx: Invocation['ctx']
): Effect.fn.Return<
	| { readonly failed: BoltError }
	| { readonly vectors: readonly (readonly (readonly number[] | null)[])[] },
	EngineError
> {
	const outcomes = yield* guest.invokeEach(
		{ id: ctx.seed, kind: 'vector', ctx, budget: { crossings: 0, readBytes: 0 } },
		parts.map((part) => ({ target: `${part.model}.${part.name}`, input: part.rows })),
		{ cross: () => Effect.succeed([]) }
	);
	const vectors: (readonly (readonly number[] | null)[])[] = [];
	for (const [index, { model, name, dim, rows }] of parts.entries()) {
		const g = outcomes[index];
		if (g === undefined)
			return yield* BoltError.make('bad_answer', 'guest', `Index ${model}.${name} answered nothing.`);
		if (g.kind === 'failed') return { failed: g.error };
		if (g.kind === 'refused')
			return {
				failed: BoltError.make('internal', 'guest', 'A pure search vector cannot refuse a write.')
			};
		const answered = yield* Schema.decodeUnknownEffect(
			Schema.Array(Schema.NullOr(Schema.Array(Schema.Number)))
		)(g.output).pipe(
			Effect.mapError((error) => BoltError.make('bad_answer', 'guest', error.message, error))
		);
		if (
			answered.length !== rows.length ||
			answered.some(
				(vector) =>
					vector !== null &&
					(vector.length !== dim || vector.some((value) => !Number.isFinite(value)))
			)
		)
			return yield* BoltError.make(
				'bad_answer',
				'guest',
				`Index ${model}.${name} returns exactly ${dim} finite numbers per row, or null.`
			);
		vectors.push(answered);
	}
	return { vectors };
});

export const materializeChanges = Effect.fn('Bolt.materializeChanges')(function* (
	context: PlanInput,
	prepared: PreparedPlan
): Effect.fn.Return<DraftPlan | StoppedPlan, EngineError> {
	const { e, r, cat, pre } = context;
	const m = e.manifest,
		auth = r.authority,
		b = r.bindings;
	const { imp } = context,
		{ items } = prepared;
	const stop = (outcome: Outcome): StoppedPlan => ({ guest: prepared.guest, outcome });
	const writes: DraftWrite[] = [];
	const report: ImportRow[] = [];
	const deletedIds = new Set(
		items.filter((i) => i.change.op === 'delete').map((i) => k(i.change.model, i.change.id))
	);
	const unchanged: { model: string; id: string }[] = [];
	for (const it of items) {
		const c = it.change;
		if (c.op !== 'delete' && deletedIds.has(k(c.model, c.id)))
			return stop(
				refused(
					'invalid_input',
					'A row deleted in this act cannot also be changed (deletedInAct).',
					c.path
				)
			);
		const root = imp !== undefined && it.parent === undefined && c.model === r.model;
		if (c.op === 'upsert')
			return yield* BoltError.make(
				'internal',
				'commit',
				'An unresolved upsert reached the commit planner.'
			);
		if (root)
			report.push({
				index: c.op === 'delete' ? null : Number(c.path[0]),
				id: c.id,
				action: c.op === 'delete' ? 'deleted' : c.op === 'update' ? 'updated' : 'created'
			});
		if (c.op === 'create') {
			const values: Record<string, Json> = { ...c.values };
			const missing = withDefaults(m, cat, c.model, values, auth.actor, b);
			if (missing instanceof BoltError) return yield* missing;
			if (missing !== null)
				return stop(refused('required', `${missing} is required.`, [...c.path, missing]));
			writes.push({
				write: { model: c.model, id: c.id, op: 'create', values },
				item: it
			});
		} else {
			const row = pre.get(k(c.model, c.id));
			if (row === undefined) return stop(missing_record(c.path));
			if (c.op === 'delete') {
				writes.push({
					write: {
						model: c.model,
						id: c.id,
						op: 'delete',
						revision: Number(row['revision'])
					},
					item: it
				});
				continue;
			}
			if (c.revision !== null && c.revision !== Number(row['revision']))
				return stop({ kind: 'conflict', records: [{ model: c.model, id: c.id }] });
			const stamps = stateStamps(m, c.model, c.set, row, b.now);
			const set = storedChanges(cat, c.model, row, { ...c.set, ...stamps });
			const rule = Object.keys(set).length === 0 ? null : appRules(m, c.model, row, set);
			if (rule !== null)
				return stop(refused('invalid_input', rule.message, [...c.path, rule.field]));
			const per = Object.values(m.models[c.model]?.fields ?? {}).flatMap((field) =>
				field.kind === 'seq' ? (field.per ?? []) : []
			);
			if (Object.keys(set).length > 0)
				writes.push({
					write: {
						model: c.model,
						id: c.id,
						op: 'update',
						set,
						revision: Number(row['revision']),
						...(per.some((p) => Object.hasOwn(set, p))
							? { stored: Object.fromEntries(per.map((p) => [p, row[p] ?? null])) }
							: {})
					},
					item: it
				});
			else unchanged.push({ model: c.model, id: c.id });
		}
	}
	const invalid = yield* validateCustom(e, r, writes);
	if (invalid !== null) return stop(invalid);
	return { writes, unchanged, report };
});

export const indexChanges = Effect.fn('Bolt.indexChanges')(function* (
	context: PlanInput,
	writes: readonly DraftWrite[],
	initialGuest: boolean
): Effect.fn.Return<boolean | StoppedPlan, EngineError> {
	const { e, r, pre } = context,
		m = e.manifest,
		auth = r.authority,
		b = r.bindings;
	let guest = initialGuest;
	const stop = (outcome: Outcome): StoppedPlan => ({ guest, outcome });
	const parts: { model: string; name: string; dim: number; chunk: DraftWrite[] }[] = [];
	for (const [model, entries] of Map.groupBy(
		writes.filter(({ write }) => write.op !== 'delete'),
		({ write }) => write.model
	))
		for (const [name, index] of Object.entries(m.models[model]?.search?.indexes ?? {}))
			if (index.field === undefined)
				for (let offset = 0; offset < entries.length; offset += LIMITS.writeChunk)
					parts.push({
						model,
						name,
						dim: index.dim,
						chunk: entries.slice(offset, offset + LIMITS.writeChunk)
					});
	if (parts.length === 0) return guest;
	const g = yield* pureVectors(
		yield* guest_port(e.guest),
		parts.map(({ model, name, dim, chunk }) => ({
			model,
			name,
			dim,
			rows: chunk.map(({ write }) => ({
				...pre.get(k(model, write.id)),
				...(write.op === 'create' ? write.values : write.op === 'update' ? write.set : {}),
				id: write.id
			}))
		})),
		guest_context(auth.actor, b, `${r.invocationId}:vector`)
	);
	guest = true;
	if ('failed' in g) return stop(yield* guestFailure(g.failed));
	for (const [at, { model, name, chunk }] of parts.entries()) {
		const vectors = g.vectors[at] ?? [];
		for (const [position, entry] of chunk.entries()) {
			const write = entry.write,
				column = index_column(name),
				vector = vectors[position];
			if (vector === undefined)
				return yield* BoltError.make('bad_answer', 'guest', `Index ${model}.${name} omitted a row.`);
			if (write.op === 'create')
				entry.write = { ...write, values: { ...write.values, [column]: vector } };
			else if (write.op === 'update')
				entry.write = { ...write, set: { ...write.set, [column]: vector } };
		}
	}
	return guest;
});
