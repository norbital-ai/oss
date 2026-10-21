/// <reference types="node" />
// Schema evolution (rule 69, X-16): `plan(readApplied(db), manifest)` diffs the applied slice's objects against the
// manifest's, and `applyPlan` runs the steps in one transaction under the schema advisory lock. Step classes:
// additive, backfill (a derived column filled from rows), validating (a constraint counted against rows first, refused
// with its name and the offending row count), destructive (a table or stored column dropped; needs acceptance).
import { Effect, Schema } from 'effect';
import { TenantTx } from '../db/tenant-db.ts';
import { canonical } from '../write/sql.ts';
import { createHash } from 'node:crypto';
import type { EngineManifest } from '../manifest.ts';
import type { TenantDbShape as TenantDb } from '../db/tenant-db.ts';
import { BoltError } from '../../protocol/errors.ts';
import { SYSTEM } from '../../system/index.ts';
import { configurationDefaults } from '../../decl/runtime/integration.ts';
import { definitionOf } from '../integrations/instances.ts';
import {
	RANK,
	schemaObjects,
	SchemaSliceSchema,
	type SchemaObject,
	type SchemaSlice
} from './ddl.ts';
import { engineObjects } from './engine.ts';
type StepClass = 'additive' | 'backfill' | 'validating' | 'destructive';
/** `drop` then `create`: a removed object only drops, a new one only creates, a changed one does both. */
export type Step = {
	id: string;
	class: StepClass;
	drop: SchemaObject | null;
	create: SchemaObject | null;
};
export type Plan = {
	from: string | null;
	to: string;
	slice: SchemaSlice;
	steps: readonly Step[];
};
type ApplyOptions = {
	/** `true` (`bolt dev`, `bolt start --accept`) or the accepted step ids (a merge-request approval). */
	accept?: true | readonly string[];
};
/**
 * What the database holds for a workspace: its models and relationships beside the built-in layer's (`src/system`), and
 * its connections, each with the configuration its definition starts an instance with.
 */
export function schemaSlice(m: EngineManifest): SchemaSlice {
	const connections = Object.fromEntries(
		Object.entries(m.connections).map(([slot, c]) => [
			slot,
			{ ...c, configuration: configurationDefaults(definitionOf(m, c.integration)) }
		])
	);
	return {
		models: { ...SYSTEM.models, ...m.models },
		relationships: { ...SYSTEM.relationships, ...m.relationships },
		currency: m.workspace.currency ?? null,
		tz: m.workspace.tz,
		connections
	};
}
/** The schema hash activation compares (rule 69): SHA-256 of the canonical slice. */
export function fingerprint(s: SchemaSlice): string {
	return createHash('sha256').update(canonical(s)).digest('hex');
}
/** The slice the database was last planned to, or `null` for an empty database. */
export const readApplied = Effect.fn('Bolt.readApplied')(function* (db: TenantDb) {
	const [present] = yield* db.read([
		{ text: `select to_regclass('bolt_schema') is not null as present`, params: [] }
	]);
	if (present?.rows[0]?.present !== true) return null;
	const [row] = yield* db.read([{ text: 'select slice from bolt_schema', params: [] }]);
	return yield* Schema.decodeUnknownEffect(Schema.NullOr(SchemaSliceSchema))(
		row?.rows[0]?.slice ?? null
	).pipe(Effect.mapError((error) => BoltError.make('schema', 'decode', error.message, error)));
});
const ORDER: readonly StepClass[] = ['additive', 'backfill', 'validating', 'destructive'];
const worst = (a: StepClass, b: StepClass): StepClass =>
	ORDER.indexOf(a) > ORDER.indexOf(b) ? a : b;
const def = (o: SchemaObject) => o.shape ?? o.create.join(';\n');
const colKey = (o: SchemaObject, c: string) => `${o.table}.${c}`;
export function plan(applied: SchemaSlice | null, next: EngineManifest | SchemaSlice): Plan {
	const slice = 'workspace' in next ? schemaSlice(next) : next;
	const before = new Map((applied === null ? [] : schemaObjects(applied)).map((o) => [o.id, o]));
	const after = schemaObjects(slice);
	const afterById = new Map(after.map((o) => [o.id, o]));
	const changed = new Set<string>();
	const replacedCols = new Set<string>();
	for (const [id, o] of before) {
		const n = afterById.get(id);
		if (n !== undefined && def(n) === def(o)) continue;
		if (n !== undefined) changed.add(id);
		if (o.rank === 'column') replacedCols.add(colKey(o, o.deps[0] as string));
	}
	// a dropped or replaced column takes its dependants with it (`drop column … cascade`): rebuild them
	for (let grew = true; grew;) {
		grew = false;
		for (const o of after) {
			if (
				changed.has(o.id) ||
				!before.has(o.id) ||
				!o.deps.some((c) => replacedCols.has(colKey(o, c)))
			)
				continue;
			changed.add(o.id);
			if (o.rank === 'column') replacedCols.add(colKey(o, o.deps[0] as string));
			grew = true;
		}
	}
	const freshTables = new Set(
		after.filter((o) => o.rank === 'table' && !before.has(o.id)).map((o) => o.table)
	);
	const createClass = (o: SchemaObject): StepClass =>
		freshTables.has(o.table)
			? 'additive'
			: o.violations !== undefined
				? 'validating'
				: o.derived === true
					? 'backfill'
					: 'additive';
	const dropClass = (o: SchemaObject): StepClass =>
		o.stored === true ? 'destructive' : 'additive';
	const steps: Step[] = [
		...[...before.values()]
			.filter((o) => !afterById.has(o.id) && o.drop !== null)
			.map((o): Step => ({ id: `drop:${o.id}`, class: dropClass(o), drop: o, create: null })),
		...after
			.filter((o) => changed.has(o.id))
			.map((o): Step => {
				const old = before.get(o.id);
				if (old === undefined)
					throw BoltError.make('schema', 'derive', `missing replaced schema object '${o.id}'`);
				const drop = old.drop === null ? null : old;
				return {
					id: `replace:${o.id}`,
					class: worst(drop === null ? 'additive' : dropClass(drop), createClass(o)),
					drop,
					create: o
				};
			}),
		...after
			.filter((o) => !before.has(o.id))
			.map((o): Step => ({ id: `create:${o.id}`, class: createClass(o), drop: null, create: o }))
	];
	return {
		from: applied === null ? null : fingerprint(applied),
		to: fingerprint(slice),
		slice,
		steps
	};
}
/**
 * Applies a plan in one transaction. Refuses, before anything changes: an unaccepted destructive step, and a database
 * no longer at `plan.from` (another apply won). A validating step counts its offending rows first.
 */
export const applyPlan = Effect.fn('Bolt.applyPlan')(function* (
	db: TenantDb,
	p: Plan,
	options: ApplyOptions = {}
) {
	const accepted = (s: Step) => options.accept === true || (options.accept ?? []).includes(s.id);
	const refused = p.steps.filter((s) => s.class === 'destructive' && !accepted(s));
	if (refused.length > 0)
		return yield* Effect.fail(
			BoltError.make(
				'destructiveNotAccepted',
				'admission',
				`destructive schema steps need acceptance: ${refused.map((s) => s.id).join(', ')}`,
				refused.map((s) => s.id)
			)
		);
	const drops = p.steps
		.flatMap((s) => (s.drop === null ? [] : [s.drop]))
		.sort((a, b) => RANK[b.rank] - RANK[a.rank]);
	// the engine's private objects are idempotent and re-asserted on every apply: an engine upgrade reaches a database whose plan is empty
	const planned = p.steps.flatMap((s) => (s.create === null ? [] : [s.create]));
	const creates = [
		...planned,
		...engineObjects().filter((o) => !planned.some((x) => x.id === o.id))
	].sort((a, b) => RANK[a.rank] - RANK[b.rank]);
	yield* db.transaction(
		Effect.gen(function* () {
			const tx = yield* TenantTx;
			const at = yield* tx.query({
				text: `select to_regclass('bolt_schema') is not null as present`,
				params: []
			});
			const current =
				at.rows[0]?.present === true
					? ((yield* tx.query({ text: 'select fingerprint from bolt_schema', params: [] })).rows[0]
							?.fingerprint ?? null)
					: null;
			if (current !== p.from)
				return yield* Effect.fail(
					BoltError.make(
						'schemaMoved',
						'admission',
						`the database is at schema ${String(current)}, the plan starts from ${String(p.from)}; plan again`
					)
				);
			for (const o of drops) if (o.drop !== null) yield* tx.query({ text: o.drop, params: [] });
			for (const o of creates) {
				if (o.violations !== undefined) {
					const n = Number((yield* tx.query({ text: o.violations, params: [] })).rows[0]?.n ?? 0);
					const name = o.meta?.name ?? o.id;
					if (n > 0)
						return yield* Effect.fail(
							BoltError.make(
								'schemaInvalid',
								'commit',
								`${name} refuses ${n} existing row${n === 1 ? '' : 's'}`,
								{ constraint: name, rows: n }
							)
						);
				}
				for (const text of o.create) yield* tx.query({ text, params: [] });
			}
			yield* tx.query({
				text: 'insert into bolt_schema (one, fingerprint, slice) values (true, $1, $2::jsonb) on conflict (one) do update set fingerprint = excluded.fingerprint, slice = excluded.slice, applied_at = now()',
				params: [p.to, JSON.stringify(p.slice)]
			});
		}),
		{ advisory: ['bolt:schema'] }
	);
});
