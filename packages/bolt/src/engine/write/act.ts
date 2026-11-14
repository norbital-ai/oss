// The act planner, in rule order: decode → the records named and the columns admitted per write path → observed-revision
// checks → the policies' checks on the submitted trees → batched per-verb callbacks → defaults and model rules → the
// approval route → the planned commit, which `Callables.acts` commits in one statement.
import type { Json } from '../../decl/values.ts';
import { MessageValues, message_text } from '../../decl/errors/refusal.ts';
const jsonArray = (value: Json | undefined): value is readonly Json[] => Array.isArray(value);

import type { ApprovalSnapshot } from '../../decl/access/policy.ts';
import type { Lock, Sql } from '@norbital-ai/host-api';
import type {
	Authority,
	Bindings,
	Change,
	CrossAnswer,
	Invocation,
	InputPath,
	Outcome,
	RowData,
	DeleteArm,
	WriteArm
} from '../contracts.ts';
import type { SelectIR } from '@norbital-ai/store';
import type { Bridge } from '../services.ts';
import { layered, type EngineManifest } from '../manifest.ts';
import type { GuestShape as GuestPort } from '../services.ts';
import type { TenantDbShape as TenantDb } from '../db/tenant-db.ts';
import { storedChanges, storedRowSql } from '../db/stored.ts';
import { storedRows } from '../db/rows.ts';
import { LIMITS, utf8Bytes } from '../contracts.ts';
import type { EngineError } from '../errors.ts';
import { LOST_OUTCOME } from './result.ts';
import { BoltError, from_store } from '../../protocol/errors.ts';
import { admitMove, readsAny } from '../access/authority.ts';
import { catalog_of } from '../access/pred.ts';

import { read_history } from '../query/history.ts';
import { holders, type Holder } from '../approvals/lock.ts';
import { Snapshot } from '../approvals/snapshot.ts';
import { Effect, Option, Predicate, Schema } from 'effect';
import * as EffectArray from 'effect/Array';
import type { ActRequest, PlannedCommit, InvocationEvents } from '../services.ts';
export type { ActRequest } from '../services.ts';
import { index_column, null_row_sql, q, type Catalog } from '@norbital-ai/store';
import { UUID_PATTERN } from '@norbital-ai/store/kind';
import { compile_gets } from '@norbital-ai/store';
import {
	coalescing,
	memo_reads,
	read_composed,
	read_engine,
	readTargets,
	ReadDeps
} from '../query/engine.ts';
import { scopeOf, composable, readOptions } from '../query/reader.ts';
import { type ConstraintMeta } from '@norbital-ai/store';
import {
	CommitAnswer,
	type Commit,
	type Write
} from './commit.ts';
import { writerOf } from '../runs/queue.ts';
import {
	Flattener,
	layerPath,
	layerSel,
	modelKey,
	withDefaults,
	stateStamps,
	type Item,
	type Sel
} from './flatten.ts';
import { canonical, database_value } from '@norbital-ai/store';
import { decideError, minter, fingerprinting, type Fingerprint } from './sql.ts';
import { prospectiveBridge } from './prospective.ts';
import { writeFields, writeTarget } from '../callables/parse.ts';
import { erase } from './erase.ts';
import { importPlan, importRefs, type ImportPlan } from './import.ts';
import { embedQueued, embedWrites } from '../integrations/embed.ts'; // hook:integrations
import { instanceTransform } from '../integrations/instances.ts';
import { reviewChange } from '../approvals/review.ts';
import { SYSTEM } from '../../system/index.ts';
/** The generated verbs: `import` and `erase` included. */
export type Verb = 'create' | 'update' | 'delete' | 'upsert' | 'import' | 'erase';
/** The snapshot that opens or resumes a request. */
export type StepsSnapshot = Extract<ApprovalSnapshot, { kind: 'steps' }>;
export type HeldRecord = {
	readonly id: string;
	readonly action: 'create' | 'update' | 'delete';
	readonly values: RowData;
};
/** Approval persistence belongs to the approval engine; the write engine evaluates the grant's callback. */
export interface ApprovalHook {
	route(act: {
		readonly model: string;
		readonly record: string;
		readonly action: 'create' | 'update' | 'delete';
		readonly authority: Authority;
		readonly bindings: Bindings;
		readonly seed: string;
		readonly snapshot: StepsSnapshot;
		readonly records: readonly HeldRecord[];
	}): Effect.Effect<NonNullable<Commit['approval']> | Outcome, EngineError>;
	resubmit(act: {
		readonly request: string;
		readonly authority: Authority;
		readonly bindings: Bindings;
		readonly snapshot: StepsSnapshot | { readonly kind: 'allow' };
		readonly changed: readonly {
			readonly model: string;
			readonly id: string;
			readonly fields: readonly string[];
		}[];
		readonly records: readonly HeldRecord[];
	}): Effect.Effect<NonNullable<Commit['resubmit']>, EngineError>;
}
export type WriteEngine = {
	log?: InvocationEvents;
	manifest: EngineManifest;
	db: TenantDb;
	guest?: GuestPort;
	/**
	 * The transform's reads as the workspace; `tables()` names what it read, for the transform lock, and
	 * `fingerprints()` digests them, for the transform assert.
	 */
	bridge?: (
		invocation: Invocation,
		db?: TenantDb
	) => Bridge & {
		tables?(): readonly string[];
		fingerprints?(): readonly Fingerprint[];
	};
	approval?: ApprovalHook;
};
type RefusalCode = Extract<
	Outcome,
	{
		kind: 'refused';
	}
>['code'];
export const refused = (code: RefusalCode, message: string, path?: InputPath): Outcome => {
	const field = path?.findLast(
		(p) =>
			typeof p === 'string' &&
			!['set', 'target', 'create', 'update', 'upsert', 'delete', 'link', 'unlink'].includes(p)
	);
	const row = path?.find((p) => typeof p === 'number');
	return {
		kind: 'refused',
		code,
		message,
		...(typeof field === 'string' ? { field } : {}),
		...(typeof row === 'number' ? { row } : {})
	};
};
const missing_record = (path?: InputPath) => refused('not_found', 'The record does not exist.', path);
const guest_port = (guest: WriteEngine['guest']) => guest === undefined
	? Effect.fail(BoltError.make('no_guest', 'guest', 'this host runs no guest code'))
	: Effect.succeed(guest);
const guest_context = (actor: Authority['actor'], b: Bindings, seed: string) => ({
	actor, now: b.now, today: b.today, tz: b.tz, seed
});
export const k = (model: string, id: string) => `${model}\u0000${id}`;
export type Taker = (
	severity: 'info' | 'warn',
	event: string,
	attributes: {
		readonly [key: string]: Json;
	}
) => Effect.Effect<void>;
/**
 * Plans one act (a generated verb) into its mode's sink, or answers the outcome that stops it. `Callables.acts` commits
 * what it plans, so a verb answers alike whoever calls it.
 */
export const act = Effect.fn('Bolt.act')(function* (e: WriteEngine, r: ActRequest) {
	let took = false;
	const take: Taker = (severity, event, attributes) =>
		Effect.gen(function* () {
			took = true;
			if (e.log === undefined) return;
			yield* e.log.emit(severity, event, { callable: `${r.model}.${r.verb}`, ...attributes });
		});
	const o = yield* r.verb === 'erase' ? erase(e, r, take) : pipeline(e, r, take);
	if (!took && e.log !== undefined && (o.kind === 'refused' || o.kind === 'conflict')) {
		yield* e.log.emit('warn', 'act.refused', {
			callable: `${r.model}.${r.verb}`,
			code: o.kind === 'refused' ? o.code : 'conflict'
		});
	}
	return o;
});
const pipeline = Effect.fn('Bolt.pipeline')(function* (
	engine: WriteEngine,
	r: ActRequest,
	take: Taker
) {
	const e = {
		...engine,
		...(Object.hasOwn(SYSTEM.exposures, r.model) ? { manifest: layered(engine.manifest) } : {})
	};
	const m = e.manifest,
		cat = catalog_of(m),
		b = r.bindings;
	const { sync, sink, pending } = r.mode;
	const auth = r.authority;
	const none = (outcome: Outcome): Outcome => outcome;
	// decode against the model's input allowlist, every offender at once
	const spec = m.exposures[r.model];
	if (spec === undefined)
		return yield* Effect.fail(
			BoltError.make('unknown_model', 'decode', `unknown model '${r.model}'`)
		);
	const sel: Sel | undefined = sync
		? { columns: sync.fields } // hook:integrations
		: r.verb === 'update'
			? spec.update && layerSel(m, cat, spec.update.columns, 'update', r.model)
			: r.verb === 'delete'
				? spec.delete && { columns: [] }
				: spec.create && layerSel(m, cat, spec.create.columns, 'create', r.model);
	const key0 = modelKey(m, r.model);
	// An upsert uses an explicit id or the model's import key and needs both caller-facing write arms.
	const byId = r.verb === 'upsert';
	if (
		sel === undefined ||
		(r.verb === 'upsert' &&
			(r.on_conflict === undefined ||
				(byId ? sync === undefined && spec.update === undefined : key0.length === 0))) ||
		(r.verb === 'import' && key0.length === 0)
	)
		return none(refused('forbidden', `${r.model} does not accept ${r.verb}.`));
	// an import's options and its refs by key values, resolved before decode (one read per target)
	let imp: ImportPlan | undefined;
	if (r.verb === 'import') {
		const planned = yield* importPlan(m, r.model, r.input, key0);
		if ('kind' in planned) return none(planned);
		const refs = yield* importRefs(e.db, m, cat, r.model, planned.rows);
		if ('kind' in refs) return none(refs);
		imp = { ...planned, rows: refs };
	}
	const mint = minter(r.invocationId, b.now);
	const f = new Flattener(m, cat, mint);
	// a generated write takes an array of rows (one `transform` sees the whole batch); no single-row form
	const inputs = imp?.rows ?? (Schema.is(Rows)(r.input) ? r.input : undefined);
	if (inputs === undefined)
		return none(refused('invalid_input', `${r.model}.${r.verb} takes an array of rows.`));
	// A bulk act holds every row until one atomic insert: refuse before the flattener copies them past the cell's budget.
	let inputBytes = 2;
	for (const [index, input] of inputs.entries()) {
		inputBytes += utf8Bytes(JSON.stringify(input)) + (index === 0 ? 0 : 1);
		if (inputBytes > LIMITS.act.inputBytes)
			return none(
				refused(
					'overflow',
					`An act writes at most ${LIMITS.act.inputBytes / 1_048_576} MiB of input; split the work into smaller acts.`
				)
			);
	}
	if (inputs.length > LIMITS.act.rows)
		return none(
			refused(
				'overflow',
				`An act writes at most ${LIMITS.act.rows} rows; split the work into smaller acts.`
			)
		);
	if (byId) {
		const invalid = inputs.findIndex((x) => !Predicate.isObject(x));
		if (invalid >= 0) return none(refused('invalid_input', 'Expected an object.', [invalid]));
		const badId = inputs.findIndex(
			(x) => Predicate.isObject(x) && x['id'] !== undefined && typeof x['id'] !== 'string'
		);
		if (badId >= 0) return none(refused('invalid_input', 'Expected an id.', [badId, 'id']));
	}
	// an upsert row whose `id` is on file is an update of it (`keep`: left as it is), resolved here, before the
	// transform, so the transform sees the stored row; a row without an id is a create; an id on no row is refused
	const upserted: (string | null)[] = [];
	const onFile = byId
		? yield* readRows(
				e.db,
				cat,
				inputs.flatMap((x) =>
					Predicate.isObject(x) && typeof x['id'] === 'string' ? [[r.model, x['id']] as const] : []
				)
			)
		: new Map<string, RowData>();
	const missing = byId
		? inputs.findIndex(
				(x) =>
					Predicate.isObject(x) && x['id'] !== undefined && !onFile.has(k(r.model, String(x['id'])))
			)
		: -1;
	if (missing >= 0 && sync === undefined)
		return none(refused('not_found', `No ${r.model} has this id.`, [missing, 'id']));
	inputs.forEach((x, i) => {
		const path = [i];
		// a created root may carry the id its writer minted (`new_id`), so a later act in the batch can name it
		if (r.verb === 'create' && Predicate.isReadonlyObject(x) && !Array.isArray(x) && x['id'] !== undefined) {
			const { id, ...row } = x;
			if (typeof id === 'string' && UUID_PATTERN.test(id)) f.create(r.model, sel, row, path, undefined, undefined, id);
			else f.problems.push({ path: [...path, 'id'], message: 'a created row names a uuid it minted (new_id)' });
		} else if (r.verb === 'create' || (imp !== undefined && imp.on_conflict === undefined))
			f.create(r.model, sel, x, path);
		else if (imp !== undefined)
			f.create(r.model, sel, x, path, undefined, {
				on: key0,
				on_conflict: imp.on_conflict === 'update' ? 'update' : 'keep'
			});
		else if (byId && r.on_conflict !== undefined && Predicate.isReadonlyObject(x) && !Array.isArray(x)) {
			const { id, ...row } = x;
			if (typeof id !== 'string') {
				const at = f.items.length;
				f.create(
					r.model,
					sel,
					row,
					path,
					undefined,
					key0.length === 0 ? undefined : { on: key0, on_conflict: r.on_conflict }
				);
				upserted.push(f.items[at]?.change.id ?? null);
			} else {
				upserted.push(id);
				if (sync !== undefined && !onFile.has(k(r.model, id)))
					f.create(r.model, sel, row, path, undefined, undefined, id);
				else if (r.on_conflict === 'update')
					f.update(
						r.model,
						sync === undefined && spec.update !== undefined
							? layerSel(m, cat, spec.update.columns, 'update', r.model)
							: sel,
						id,
						row,
						r.observed?.[id] ?? null,
						path
					);
			}
		} else {
			if (!Predicate.isObject(x)) {
				f.problems.push({ path, message: 'expected an object' });
				return;
			}
			const target = x['target'];
			const observed = r.observed?.[String(target)] ?? null;
			if (r.verb === 'update') f.update(r.model, sel, target, x['set'], observed, path);
			else f.delete(r.model, target, observed, path);
		}
	});
	sync?.deletes.forEach((id, i) => f.delete(r.model, id, null, ['deletes', i]));
	const [first] = f.problems;
	if (first !== undefined) {
		return none(
			refused(
				'invalid_input',
				f.problems.map((p) => `${p.path.join('.') || 'input'}: ${p.message}`).join('; '),
				first.path
			)
		);
	}
	const owned = syncOwnership(m, r, f.items); // hook:integrations
	if (owned !== null) return none(owned);
	if (f.items.length > LIMITS.changesPerAct)
		return none(refused('overflow', `An act writes at most ${LIMITS.changesPerAct} rows.`));
	// the act's own reads: those issued together cross as one round trip and one statement, and a read repeated
	// before the commit (an import's key resolution, after its transform) is answered from the first
	const own = yield* memo_reads(yield* coalescing(e.db));
	// `prune` deletes the caller-readable rows inside its `Where` whose key the import does not name; an
	// import's rows matched by key are resolved in the same round trip
	const matching = f.items.some((item) => item.change.op === 'upsert')
		? resolveUpserts(
				own,
				m,
				f.items.filter((i) => i.change.op === 'upsert')
			)
		: Effect.succeed(new Map<Item, RowData>());
	const [matched, pruneIds] = yield* Effect.all(
		[matching, imp?.prune === undefined ? Effect.succeed([]) : imp.prune(own, auth, b, f.items)],
		{ concurrency: 'unbounded' }
	);
	if (imp?.prune !== undefined) {
		const ids = pruneIds;
		if (!Array.isArray(ids)) return none(ids);
		for (const id of ids) f.delete(r.model, id, null, ['prune']);
	}
	const visibility = new Map<string, boolean>();
	const scope: ReadVisibility = { authority: auth, bindings: b, visibility, fingerprints: [] };
	const pre = yield* readRows(
		own,
		cat,
		[
			...f.items
				.filter((i) => i.change.op === 'update' || i.change.op === 'delete')
				.map((i) => [i.change.model, i.change.id] as const),
			...f.items.flatMap((i) =>
				i.change.op === 'upsert' &&
				i.change.on.length === 1 &&
				i.change.on[0] === 'id' &&
				typeof i.change.values['id'] === 'string'
					? [[i.change.model, i.change.values['id']] as const]
					: []
			),
			...[...matched].map(([item, row]) => [item.change.model, String(row['id'])] as const),
			...(r.on_conflict === 'keep'
				? [...onFile.values()].map((row) => [r.model, String(row['id'])] as const)
				: []),
			...f.items.flatMap((i) => i.refs.map((x) => [x.to, x.id] as const))
		],
		scope
	);
	for (const [item, row] of matched) {
		const id = String(row['id']);
		pre.set(k(item.change.model, id), row);
		if (byId && item.change.model === r.model && item.parent === undefined) {
			const index = typeof item.change.path[0] === 'number' ? item.change.path[0] : 0;
			upserted[index] = id;
			onFile.set(k(r.model, id), row);
		}
		if (item.change.op === 'upsert') {
			const previous = item.change.id;
			item.change.id = id;
			for (const child of f.items)
				if (child.parent?.model === item.change.model && child.parent.id === previous) {
					child.parent = { ...child.parent, id };
					if (child.change.op !== 'delete')
						child.change =
							child.change.op === 'update'
								? { ...child.change, set: { ...child.change.set, [child.parent.fk]: id } }
								: { ...child.change, values: { ...child.change.values, [child.parent.fk]: id } };
				}
		}
	}
	// a row an earlier act of the batch created is the caller's own: it links and reads as visible // hook:callables
	for (const [key, row] of pending ?? [])
		if (!pre.has(key)) {
			pre.set(key, row);
			visibility.set(key, true);
		}
	const readable = (c: string, row: RowData) => readableBy(auth, c, row, visibility);
	if (byId && r.on_conflict === 'keep')
		for (const id of upserted) {
			if (id === null) continue;
			const row = onFile.get(k(r.model, id));
			if (row === undefined) continue;
			if (!readable(r.model, row)) return none(missing_record());
			if (!auth.admin && (auth.models[r.model]?.update.length ?? 0) === 0)
				return none(refused('forbidden', 'You may not make this change.'));
		}
	// 4. the records the batch names exist, belong where it names them and are readable
	for (const it of f.items) {
		const c = it.change;
		const row = pre.get(k(c.model, named(c)));
		// a `with` child is written through its root's access point: the root's grant judges it, never the child's own
		const nested = it.parent !== undefined;
		if (actionOf(c, pre) === 'update' || c.op === 'delete') {
			if (row === undefined || (!nested && !readable(c.model, row)))
				return none(missing_record(c.path));
			if (it.belongs === 'parent' && (it.parent === undefined || row[it.parent.fk] !== it.parent.id))
				return none(refused('not_found', 'The record does not belong here.', c.path));
		}
		for (const ref of it.refs) {
			const target = pre.get(k(ref.to, ref.id));
			if (target === undefined || !readable(ref.to, target))
				return none(
					refused(
						'not_found',
						`No readable ${ref.to} has this id: whoever writes this link must be able to read it.`,
						[...c.path, ref.field]
					)
				);
		}
		const state = stateField(m, c.model);
		const next = c.op === 'update' ? c.set[state ?? ''] : undefined;
		if (
			!auth.admin &&
			!nested &&
			state !== undefined &&
			typeof next === 'string' &&
			row !== undefined &&
			!admitMove(auth, c.model, state, String(row[state]), next)
		)
			return none(
				refused('forbidden', `You may not move ${state} to '${next}'.`, [...c.path, state])
			);
	}
	// 5. the caller's write arms admit every column the batch writes, per path, before any guest code
	const admitted = auth.admin ? undefined : admit(cat, auth, r.model, f.items, pre);
	if (admitted !== undefined && 'kind' in admitted) return none(admitted);
	// Observed revisions are checked before transformations run. A revision that moved only by roll-ups (another act
	// wrote this record's children: history `derived`) is no conflict: no field the caller writes changed.
	const moved: { item: Item; c: string; id: string; seen: number; now: number }[] = [];
	for (const it of f.items) {
		const c = it.change;
		const row = pre.get(k(c.model, named(c)));
		if (row === undefined) continue;
		const seen =
			c.op === 'update' || c.op === 'delete' ? (c.revision ?? r.observed?.[c.id] ?? null) : null;
		if (seen === null || seen === row['revision']) continue;
		if (typeof row['revision'] !== 'number' || seen > row['revision'] || !UUID_PATTERN.test(c.id))
			return none({ kind: 'conflict', records: [{ model: c.model, id: c.id }] });
		moved.push({ item: it, c: c.model, id: c.id, seen, now: row['revision'] });
	}
	if (moved.length > 0) {
		const [derived] = yield* own.read([
			{
				text: `SELECT x.c, x.id FROM jsonb_to_recordset($1::jsonb) AS x(c text, id text, seen int, cur int)
			WHERE (SELECT count(*) FROM bolt_history h WHERE h.collection = x.c AND h.record = x.id::uuid
				AND h.revision > x.seen AND h.revision <= x.cur AND h.cause = 'derived') = x.cur - x.seen`,
				params: [JSON.stringify(moved.map(({ c, id, seen, now }) => ({ c, id, seen, cur: now })))]
			}
		]);
		const accepted = new Set((derived?.rows ?? []).map((row) => k(String(row['c']), String(row['id']))));
		const stale = moved.find(({ c, id }) => !accepted.has(k(c, id)));
		if (stale !== undefined) return none({ kind: 'conflict', records: [{ model: stale.c, id: stale.id }] });
		for (const { item, now } of moved)
			if (item.change.op === 'update' || item.change.op === 'delete') item.change = { ...item.change, revision: now };
	}
	const planned = yield* plan(
		e,
		r,
		cat,
		f.items,
		pre,
		imp,
		byId ? upserted : undefined,
		own,
		visibility,
		admitted,
		scope.fingerprints
	);
	if ('outcome' in planned) return planned.outcome;
	sink(planned);
	const records = planned.commit.writes.map((w) => ({
		model: w.model,
		id: w.id,
		revision: w.op === 'create' ? 1 : w.revision + 1
	}));
	const request =
		planned.commit.approval?.request_id ??
		(planned.commit.resubmit?.pending === true ? planned.commit.resubmit.request : undefined);
	return request === undefined
		? {
				kind: 'committed' as const,
				output: planned.commit.output,
				records,
				...(planned.commit.unchanged === undefined ? {} : { unchanged: planned.commit.unchanged })
			}
		: { kind: 'pending_approval' as const, request_id: request, records };
});
/** The record a change names: an upsert by id names the stored row, any other change its own id. */
const named = (c: Change): string =>
	c.op === 'upsert' && c.on.length === 1 && c.on[0] === 'id' && typeof c.values['id'] === 'string'
		? c.values['id']
		: c.id;
type Judged = 'create' | 'update' | 'delete';
/** The verb a change is judged by: an upsert of a stored row updates it, any other upsert creates. */
const actionOf = (c: Change, pre: ReadonlyMap<string, RowData>): Judged =>
	c.op === 'upsert' ? (pre.has(k(c.model, named(c))) ? 'update' : 'create') : c.op;
const Rows = Schema.Array(Schema.Json);
export const stateField = (m: EngineManifest, model: string): string | undefined =>
	Object.entries(m.models[model]?.fields ?? {}).find(([, x]) => x.kind === 'state')?.[0];
/** An unchanged scalar restatement needs no field grant; relationship actions remain explicit changes. */
function suppliedChanges(cat: Catalog, item: Item, row: RowData | null): readonly string[] {
	const c = item.change;
	if ((c.op !== 'update' && c.op !== 'upsert') || row === null) return item.supplied;
	const values = c.op === 'update' ? c.set : c.values;
	const differences = storedChanges(cat, c.model, row, values);
	return item.supplied.filter(
		(field) => !Object.hasOwn(values, field) || Object.hasOwn(differences, field)
	);
}
type CheckArm = { readonly policy: string; readonly check: boolean };
/** Per verb, the arms that admit the act's whole batch there; each one's `check`, when declared, judges it. */
export type Admitted = { readonly [verb in Judged]?: readonly CheckArm[] };
export type Need = { readonly path: string; readonly field?: string; readonly row?: number };
/** Which of the actor's policies a refusal of a whole verb weighed: none of them grants it, or there were none. */
const held = (auth: Authority) =>
	auth.policies.length === 0
		? 'you hold no policy'
		: `none of your policies (${auth.policies.join(', ')}) grants it`;
const forbidden = (need: Need | undefined, message: string): Outcome => ({
	kind: 'refused',
	code: 'forbidden',
	message,
	...need
});
/**
 * Rule 35 before any guest code: every (path, column) the batch writes, and every child path it acts on, must be named
 * by one of the root's arms of that verb (a `with` child is written through its root's access point, never its own);
 * the arms naming all of them admit the batch.
 */
function admit(
	cat: Catalog,
	auth: Authority,
	root: string,
	items: readonly Item[],
	pre: ReadonlyMap<string, RowData>
): Admitted | Outcome {
	const verbs = new Map<Json, Judged>();
	for (const item of items)
		if (item.parent === undefined)
			verbs.set(item.change.path[0] ?? null, actionOf(item.change, pre));
	const needs = new Map<Judged, Need[]>();
	for (const item of items) {
		const c = item.change,
			at = c.path[0] ?? null;
		const verb = verbs.get(at) ?? actionOf(c, pre);
		const list = needs.get(verb) ?? [];
		needs.set(verb, list);
		const need: Need = {
			path: layerPath(root, c.path),
			...(typeof at === 'number' ? { row: at } : {})
		};
		if (item.parent !== undefined) list.push(need);
		if (c.op === 'delete') continue;
		const many = cat.models.get(c.model)?.many;
		for (const field of suppliedChanges(cat, item, pre.get(k(c.model, named(c))) ?? null))
			if (field !== item.parent?.fk && many?.has(field) !== true) list.push({ ...need, field });
	}
	const out: { [verb in Judged]?: readonly CheckArm[] } = {};
	for (const [verb, list] of needs) {
		if (verb === 'delete') {
			const arms = auth.models[root]?.delete ?? [];
			if (arms.length === 0)
				return forbidden(list[0], `You may not delete ${root}: ${held(auth)}.`);
			out.delete = arms;
			continue;
		}
		const arms = auth.models[root]?.[verb] ?? [];
		const first = arms[0];
		if (first === undefined) return forbidden(list[0], `You may not ${verb} ${root}: ${held(auth)}.`);
		const covers = (arm: WriteArm, need: Need) =>
			need.field === undefined
				? Object.hasOwn(arm.columns, need.path)
				: (arm.columns[need.path]?.includes(need.field) ?? false);
		const outside = list.find((need) => !arms.some((arm) => covers(arm, need)));
		if (outside !== undefined)
			return forbidden(
				outside,
				outside.field === undefined
					? `You may not change ${outside.path}.`
					: `You may not write ${outside.field} of ${outside.path}.`
			);
		const admitting = arms.filter((arm) => list.every((need) => covers(arm, need)));
		if (admitting.length === 0)
			return forbidden(
				list.find((need) => !covers(first, need)),
				'No one policy admits this whole change; split it into smaller acts.'
			);
		out[verb] = admitting;
	}
	return out;
}
/** A check's answer as the guest edge sends it (`Verdict.dataOf`). */
const VerdictSchema = Schema.Union([
	Schema.Struct({ kind: Schema.Literal('allow') }),
	Schema.Struct({
		kind: Schema.Literal('refuse'),
		message: Schema.String,
		values: Schema.optionalKey(MessageValues),
		at: Schema.optionalKey(
			Schema.Struct({
				row: Schema.optionalKey(Schema.Number),
				field: Schema.optionalKey(Schema.String)
			})
		)
	}),
	Schema.Struct({ kind: Schema.Literal('approve'), flow: Snapshot })
]);
type Judgement =
	| { readonly kind: 'allow' }
	| { readonly kind: 'approve'; readonly flow: StepsSnapshot }
	| { readonly kind: 'refuse'; readonly outcome: Outcome };
/**
 * Rule 35's guest half: each admitting arm's `verdict` judges the verb's batch (invocation kind `policy`, workspace reads
 * within a transform's budget). Any `allow` executes, an arm without a verdict among them; else the first `approve` in
 * the team's policy order holds the batch for its flow; else the first `refuse` refuses it (its `row` indexes `input`).
 */
export const judge = Effect.fn('Bolt.judge')(function* (
	e: Pick<WriteEngine, 'manifest' | 'guest' | 'bridge'>,
	db: TenantDb,
	auth: Authority,
	b: Bindings,
	seed: string,
	model: string,
	verb: Judged,
	arms: readonly CheckArm[],
	input: readonly Json[],
	reads?: { readonly tables: Set<string>; readonly fingerprints: Fingerprint[] }
): Effect.fn.Return<{ guest: boolean; verdict: Judgement }, EngineError> {
	if (arms.length === 0)
		return {
			guest: false,
			verdict: { kind: 'refuse', outcome: refused('forbidden', 'You may not make this change.') }
		};
	if (arms.some((arm) => !arm.check)) return { guest: false, verdict: { kind: 'allow' } };
	const port = yield* guest_port(e.guest);
	let approve: Judgement | undefined, refusal: Judgement | undefined;
	// every checked arm crosses in one isolate run, sharing one read bridge; the verdicts are read in arm order
	const targets = arms.map((arm) => `${arm.policy}.${model}.${verb}`);
	const invocation = {
		id: `${seed}:policy:${model}.${verb}`,
		kind: 'policy' as const,
		ctx: { ...guest_context(auth.actor, b, seed), policies: auth.policies },
		budget: {
			crossings: LIMITS.crossings.write * arms.length,
			readBytes: LIMITS.readBytes * arms.length
		}
	};
	const bridge =
		e.bridge?.({ ...invocation, target: targets.join(' '), input }, db) ??
		transformBridge(e.manifest, db, { ...invocation, target: targets.join(' '), input });
	const outcomes = yield* port.invokeEach(
		invocation,
		targets.map((target) => ({ target, input })),
		bridge
	);
	for (const table of bridge.tables?.() ?? []) reads?.tables.add(table);
	reads?.fingerprints.push(...(bridge.fingerprints?.() ?? []));
	for (const [index, target] of targets.entries()) {
		const g = outcomes[index];
		if (g === undefined)
			return yield* BoltError.make('bad_answer', 'guest', `${target}: the guest answered no verdict.`);
		if (g.kind === 'failed')
			return { guest: true, verdict: { kind: 'refuse', outcome: yield* guestFailure(g.error) } };
		if (g.kind === 'refused')
			return {
				guest: true,
				verdict: {
					kind: 'refuse',
					outcome: {
						kind: 'refused',
						code: 'refused',
						message: g.message,
						...(g.key === undefined ? {} : { key: g.key }),
						...(g.values === undefined ? {} : { values: g.values }),
						rule: target
					}
				}
			};
		const data = yield* Schema.decodeUnknownEffect(VerdictSchema)(g.output).pipe(
			Effect.mapError((error) =>
				BoltError.make('bad_answer', 'guest', `${target}: ${error.message}`, error)
			)
		);
		if (data.kind === 'allow') return { guest: true, verdict: { kind: 'allow' } };
		if (data.kind === 'approve') approve ??= { kind: 'approve', flow: data.flow };
		else
			refusal ??= {
				kind: 'refuse',
				outcome: {
					kind: 'refused',
					code: 'refused',
					message: message_text(e.manifest.messages, data.message, data.values),
					key: data.message,
					...(data.values === undefined ? {} : { values: data.values }),
					rule: target,
					...data.at
				}
			};
	}
	return {
		guest: true,
		verdict: approve ??
			refusal ?? { kind: 'refuse', outcome: refused('forbidden', 'You may not make this change.') }
	};
});
/** A write callback's stored tree: each declared child layer, refusing a list beyond the native bound. */
export const treeSelect = (
	cat: Catalog,
	paths: readonly string[],
	path: string,
	model: string
): SelectIR => ({
	fields: null,
	relations: Object.fromEntries(
		paths.flatMap((p) => {
			const rel = p.startsWith(`${path}.`) ? p.slice(path.length + 1) : '';
			const many =
				rel === '' || rel.includes('.') ? undefined : cat.models.get(model)?.many.get(rel);
			return many === undefined
				? []
				: [
						[
							rel,
							{
								target: many.child,
								many: true,
								select: treeSelect(cat, paths, p, many.child),
									page: { _tag: 'Limit' as const, limit: LIMITS.page.max + 1 }
							}
						]
					];
		})
	)
});
/** Write callbacks expose writable stored values and system metadata, never stale generated values. */
export const writeTree = (cat: Catalog, model: string, row: RowData | null): RowData | null => row === null ? null : Object.fromEntries(
	Object.entries(row).flatMap(([name, value]): readonly (readonly [string, Json])[] => {
		const field = cat.models.get(model)?.fields.get(name);
		if (field?.computed || field?.derived || (field !== undefined && ['seq', 'sum', 'count'].includes(field.kind))) return [];
		const relation = cat.models.get(model)?.many.get(name);
		if (relation === undefined) return [[name, value]];
		if (!jsonArray(value)) throw BoltError.make('internal', 'decode', `The stored write tree is missing ${model}.${name}.`);
		if (value.length > LIMITS.page.max) throw BoltError.make('too_large', 'admission', `The stored ${model}.${name} exceeds the write tree limit.`);
		return [[name, value.map((child) => {
			if (!Predicate.isObject(child) || typeof child['id'] !== 'string') throw BoltError.make('internal', 'decode', `The stored write tree has an invalid ${model}.${name} row.`);
			return writeTree(cat, relation.child, child);
		})]];
	})
);
/** The stored trees a verdict or transform receives, in `ids` order (`null` where no row is stored). */
export const storedTrees = (
	db: TenantDb,
	m: EngineManifest,
	cat: Catalog,
	model: string,
	ids: readonly (string | null)[],
	b: Bindings,
	paths = Object.keys(m.exposures[model]?.update?.columns ?? {})
) => wireRows(db, cat, model, ids, b, treeSelect(cat, paths, model, model)).pipe(Effect.flatMap((rows) => Effect.try({
	try: () => rows.map((row) => writeTree(cat, model, row)),
	catch: (error) => error instanceof BoltError ? error : BoltError.make('internal', 'decode', String(error))
})));
/** Rule 13: the caller's read scope admits the row, as the act's own native read found it (an administrator reads all). */
function readableBy(
	auth: Authority,
	c: string,
	row: RowData,
	visibility: ReadonlyMap<string, boolean>
): boolean {
	return auth.admin || (typeof row['id'] === 'string' && visibility.get(k(c, row['id'])) === true);
}
type ReadVisibility = {
	authority: Authority;
	bindings: Bindings;
	visibility: Map<string, boolean>;
	/** The visibility reads' digests, for the commit to assert: a row that left the caller's scope since is a conflict. */
	fingerprints: Fingerprint[];
};
/**
 * Reads raw rows and, with a caller `scope`, which of them its native read scope admits, keyed `model␀id`: a row any
 * output the caller holds admits. Only a model the caller reads is checked; any other row is not readable. The two reads
 * are issued together (one round trip over a coalescing reader); the visibility read is fingerprinted.
 */
export const readRows = Effect.fn('Bolt.readRows')(function* (
	db: TenantDb,
	cat: Catalog,
	want: readonly (readonly [string, string])[],
	scope?: ReadVisibility
): Effect.fn.Return<Map<string, RowData>, EngineError> {
	const grouped = [...Map.groupBy(want, ([c]) => c)];
	if (grouped.length === 0) return new Map();
	const tables = grouped.map(([table]) => table);
	const checks =
		scope === undefined || scope.authority.admin
			? []
			: tables.filter((table) => readsAny(scope.authority, table));
	const visible = yield* Effect.forEach(checks, (table) => {
		if (scope === undefined)
			return Effect.fail(
				BoltError.make('internal', 'admission', 'read visibility requires its caller scope')
			);
		const ids = [...new Set(want.filter(([model]) => model === table).map(([, id]) => id))];
		for (const id of ids) scope.visibility.set(k(table, id), false);
		return compile_gets(
			cat,
			table,
			ids,
			{ fields: ['id'], relations: {} },
			{
				...readOptions({ as: 'caller', authority: scope.authority }, scope.bindings),
				scope: scopeOf(scope.authority, 'any')
			}
		).pipe(Effect.map(composable), Effect.mapError(from_store));
	});
	const recorded = fingerprinting(db);
	const [res, seen] = yield* Effect.all(
		[
			read_composed(
				db,
				grouped.map(([t, targets]) =>
					composable({
						text: `SELECT ${storedRowSql(cat, t, 't')} AS j FROM ${q(t)} t JOIN jsonb_populate_recordset(${null_row_sql(t, cat.models.get(t)?.fields.keys() ?? [])}, $1::jsonb) r ON t.id = r.id`,
						params: [
							JSON.stringify([...new Set(targets.map(([, id]) => id))].map((id) => ({ id })))
						]
					})
				)
			),
			visible.length === 0 ? Effect.succeed([]) : read_composed(recorded.db, visible)
		],
		{ concurrency: 'unbounded' }
	);
	scope?.fingerprints.push(...recorded.fingerprints());
	for (const [index, table] of checks.entries())
		for (const row of seen[index]?.rows ?? []) {
			const value = row['j'];
			if (Predicate.isObject(value) && typeof value['id'] === 'string')
				scope?.visibility.set(k(table, value['id']), true);
		}
	const rows = new Map<string, RowData>();
	for (const [index, table] of tables.entries())
		for (const row of yield* storedRows(cat, table, res[index])) rows.set(k(table, row.id), row);
	return rows;
});
type StoppedPlan = { guest: boolean; outcome: Outcome };
type Planned = StoppedPlan | (PlannedCommit & { guest: boolean });
type ImportRow = { index: number | null; id: string | null; action: string };
type DraftWrite = { write: Write; item: Item };
type PlanInput = {
	e: WriteEngine;
	r: ActRequest;
	cat: Catalog;
	submitted: readonly Item[];
	pre: Map<string, RowData>;
	imp: ImportPlan | undefined;
	own: TenantDb;
	visibility: Map<string, boolean>;
	admitted: Admitted | undefined;
	/** The open requests holding any of the refs (`heldBy`): each ref is asked of the database once per plan. */
	held: (
		refs: readonly (readonly [string, string])[]
	) => Effect.Effect<readonly Holder[], EngineError>;
};
/** One `holders` read per plan in the usual act: a ref asked again is answered from the requests already found. */
const heldBy = (db: TenantDb, actor: Authority['actor']): PlanInput['held'] => {
	const asked = new Set<string>(),
		found = new Map<string, Holder>();
	return Effect.fnUntraced(function* (refs: readonly (readonly [string, string])[]) {
		const fresh = [...new Map(refs.filter(([c, id]) => !asked.has(k(c, id))).map((ref) => [k(...ref), ref])).values()];
		for (const [c, id] of fresh) asked.add(k(c, id));
		for (const h of yield* holders(db, fresh, actor)) {
			const known = found.get(h.id);
			found.set(h.id, known === undefined ? h : { ...known, refs: [...known.refs, ...h.refs] });
		}
		const wanted = new Set(refs.map(([c, id]) => k(c, id)));
		return [...found.values()].filter((h) => h.refs.some(([c, id]) => wanted.has(k(c, id))));
	});
};
/** The refs the approval lock weighs for `writes`: each stored row, and the stored owned parent of each. */
const holdRefs = (
	m: EngineManifest,
	cat: Catalog,
	pre: ReadonlyMap<string, RowData>,
	writes: readonly Write[]
): (readonly [string, string])[] => {
	const fresh = new Set(writes.filter((write) => write.op === 'create').map((write) => k(write.model, write.id)));
	return writes.flatMap((write): (readonly [string, string])[] => [
		...(write.op === 'create' ? [] : [[write.model, write.id] as const]),
		...[...(cat.models.get(write.model)?.one ?? [])].flatMap(([fk, one]) => {
			const parent = write.op === 'create' ? write.values[fk] : pre.get(k(write.model, write.id))?.[fk];
			const target = one.targets[0];
			return m.relationships[`${write.model}.${fk}`]?.owned &&
				target !== undefined &&
				typeof parent === 'string' &&
				!fresh.has(k(target, parent))
				? [[target, parent] as const]
				: [];
		})
	]);
};
/** The writes the submitted items name before any callback, as `holdRefs` weighs them. */
const guessed = (items: readonly Item[], pre: ReadonlyMap<string, RowData>): Write[] =>
	items.map(({ change: c }): Write =>
		actionOf(c, pre) === 'create'
			? { model: c.model, id: named(c), op: 'create', values: c.op === 'update' ? c.set : c.op === 'delete' ? {} : c.values }
			: { model: c.model, id: named(c), op: 'update', set: {}, revision: 0 }
	);
type PreparedPlan = {
	guest: boolean;
	items: Item[];
	flow: StepsSnapshot | undefined;
	importRows: ImportRow[];
	upsertOutput: string[];
	readTables: Set<string>;
	fingerprints: Fingerprint[];
};
type DraftPlan = { writes: DraftWrite[]; unchanged: { model: string; id: string }[]; report: ImportRow[] };
type RoutedPlan = { guest: boolean; approval: Commit['approval']; resubmit: Commit['resubmit']; joined: boolean };

const changeToken = (item: Item) => canonical([item.change.model, item.change.path]);
const descendantOf = (item: Item, root: Item) =>
	item !== root &&
	item.change.path.length > root.change.path.length &&
	root.change.path.every((part, at) => item.change.path[at] === part);
const changeDepth = (item: Item) =>
	item.change.path.filter(
		(part, index) =>
			typeof part === 'string' &&
			typeof item.change.path[index + 1] === 'number' &&
			['create', 'update', 'upsert', 'delete', 'link', 'unlink'].includes(part)
	).length;
const payloadFor = (items: readonly Item[], pre: ReadonlyMap<string, RowData>) => {
	const children = new Map<string, Item[]>();
	for (const item of items) {
		const parent = item.parent;
		if (parent === undefined) continue;
		const key = k(parent.model, parent.id), list = children.get(key) ?? [];
		list.push(item);
		children.set(key, list);
	}
	const payload = (item: Item, nested = false): RowData => {
		const c = item.change;
		if (c.op === 'delete') return {};
		const values: Record<string, Json> = { ...(c.op === 'update' ? c.set : c.values) };
		if (nested && item.parent !== undefined && c.op !== 'update') delete values[item.parent.fk];
		for (const child of (children.get(k(c.model, c.id)) ?? []).filter(
			(one) => changeDepth(one) === changeDepth(item) + 1 && descendantOf(one, item)
		)) {
			const parent = child.parent;
			if (parent === undefined) continue;
			const rel = parent.rel;
			const action = child.change.path.findLast(
				(part) =>
					typeof part === 'string' &&
					['create', 'update', 'upsert', 'delete', 'link', 'unlink'].includes(part)
			);
			if (typeof action !== 'string') continue;
			const sub = payload(child, true);
			const revision = child.change.op === 'update' || child.change.op === 'delete'
				? child.change.revision ?? pre.get(k(child.change.model, child.change.id))?.['revision']
				: undefined;
			const target = { id: child.change.id, ...(typeof revision === 'number' ? { revision } : {}) };
			const entry: Json =
				action === 'update'
					? { target, set: sub }
					: action === 'upsert'
						? { id: child.change.id, ...sub }
						: ['delete', 'link', 'unlink'].includes(action)
							? target
							: sub;
			// a created row's children are its create tree's list (a link as the child's id); an update's are actions
			if (actionOf(c, pre) === 'create') {
				const existing = values[rel];
				values[rel] = [...(jsonArray(existing) ? existing : []), entry];
				continue;
			}
			const group: { [key: string]: Json } = Predicate.isObject(values[rel])
				? { ...values[rel] }
				: {};
			const existing = group[action];
			group[action] = [...(jsonArray(existing) ? existing : []), entry];
			values[rel] = group;
		}
		return values;
	};
	return payload;
};

/** Verdicts and transforms see the same proposed rows, including actual child lists rather than relation commands. */
const changeInputs = Effect.fn('Bolt.changeInputs')(function* (
	context: PlanInput,
	model: string,
	verb: Judged,
	roots: readonly Item[],
	items: readonly Item[],
	reads: Pick<PreparedPlan, 'readTables' | 'fingerprints'>
): Effect.fn.Return<{ input: Json[]; missing?: Item }, EngineError> {
	const { e, r, own, pre, cat } = context, m = e.manifest;
	const recorded = fingerprinting(own);
	const paths = new Set(verb === 'delete' ? [] : Object.keys(m.exposures[model]?.[verb]?.columns ?? {}));
	const entries = roots.flatMap((root) => [root, ...items.filter((item) => descendantOf(item, root))].map((item) => ({
		item,
		path: layerPath(model, item.change.path.slice(root.change.path.length))
	})));
	for (const entry of entries) paths.add(entry.path);
	const childrenByParent = Map.groupBy(entries.filter(({ item }) => item.parent !== undefined), ({ item, path }) =>
		canonical([item.parent?.model, item.parent?.id, item.parent?.rel, path]));
	const stored = new Map<Item, RowData | null>();
	for (const group of Map.groupBy(entries, ({ item, path }) => canonical([item.change.model, path])).values()) {
		const first = group[0];
		if (first === undefined) continue;
		const ids = group.map(({ item }) => actionOf(item.change, pre) === 'create' ? null : named(item.change));
		const select = treeSelect(cat, [...paths], first.path, first.item.change.model);
		const remember = (model: string, tree: SelectIR): void => {
			reads.readTables.add(model);
			for (const relation of Object.values(tree.relations)) remember(relation.target, relation.select);
		};
		remember(first.item.change.model, select);
		const rows = yield* wireRows(recorded.db, cat, first.item.change.model, ids, r.bindings, select);
		for (const [index, entry] of group.entries()) {
			const before = rows[index] ?? null;
			if (ids[index] !== null && before === null) return { input: [], missing: entry.item };
			stored.set(entry.item, before);
		}
	}
	reads.fingerprints.push(...recorded.fingerprints());
	const payload = payloadFor(items, pre);
	const setOf = (item: Item): RowData => {
		const values = payload(item);
		if (item.change.op !== 'upsert') return values;
		const { id: _id, ...rest } = values;
		return rest;
	};
	const proposed = (item: Item, path: string): RowData | null => {
		const c = item.change, action = actionOf(c, pre), before = stored.get(item) ?? null;
		if (c.op === 'delete') return null;
		if (c.op === 'upsert' && c.on_conflict === 'keep' && before !== null) return before;
		const values = c.op === 'update' ? c.set : c.values;
		const after: Record<string, Json> = { ...before, ...(action === 'update' ? storedChanges(cat, c.model, before ?? {}, values) : values), id: named(c) };
		for (const field of cat.models.get(c.model)?.fields.values() ?? [])
			if (field.computed || field.derived || field.kind === 'sum' || field.kind === 'count') delete after[field.name];
		if (action === 'create') {
			const missing = withDefaults(m, cat, c.model, after, r.authority.actor, r.bindings);
			if (missing instanceof BoltError) throw missing;
		}
		else Object.assign(after, stateStamps(m, c.model, values, before ?? undefined, r.bindings.now));
		for (const [rel, edge] of cat.models.get(c.model)?.many ?? []) {
			const childPath = `${path}.${rel}`;
			if (!paths.has(childPath) && ![...paths].some((name) => name.startsWith(`${childPath}.`))) continue;
			const previous = before?.[rel];
			const children = new Map<string, Json>();
			if (before !== null && !jsonArray(previous)) throw BoltError.make('internal', 'decode', `The stored tree is missing ${childPath}.`);
			for (const row of jsonArray(previous) ? previous : []) {
				if (!Predicate.isObject(row) || typeof row['id'] !== 'string') throw BoltError.make('internal', 'decode', `The stored tree has an invalid ${childPath} row.`);
				children.set(row['id'], row);
			}
			for (const entry of childrenByParent.get(canonical([c.model, named(c), rel, childPath])) ?? []) {
				const child = entry.item, parent = child.parent;
				if (entry.path !== childPath || parent?.model !== c.model || parent.id !== named(c) || parent.rel !== rel || !descendantOf(child, item)) continue;
				const change = child.change;
				const next = change.op === 'delete' ? null : change.op === 'update' ? change.set[edge.column] : change.values[edge.column];
				if (change.op === 'delete' || (next !== undefined && next !== named(c))) children.delete(named(change));
				else {
					const row = proposed(child, childPath);
					if (row !== null) children.set(named(change), row);
				}
			}
			after[rel] = [...children.values()];
		}
		return after;
	};
	return yield* Effect.try({
		try: () => ({ input: roots.map((item) => ({
			before: actionOf(item.change, pre) === 'create' ? null : writeTree(cat, model, stored.get(item) ?? null),
			set: item.change.op === 'delete' ? {} : setOf(item),
			after: writeTree(cat, model, proposed(item, model))
		})) }),
		catch: (error) => error instanceof BoltError ? error : BoltError.make('internal', 'decode', String(error))
	});
});

const judgeSubmitted = Effect.fn('Bolt.judgeSubmitted')(function* (
	context: PlanInput, items: readonly Item[], reads: Pick<PreparedPlan, 'readTables' | 'fingerprints'>
): Effect.fn.Return<{ guest: boolean; flow: StepsSnapshot | undefined } | StoppedPlan, EngineError> {
	const { e, r, pre, own, admitted, cat } = context;
	const m = e.manifest, auth = r.authority, b = r.bindings;
	const { readTables, fingerprints } = reads;
	let guest = false, flow: StepsSnapshot | undefined;
	// 6. each admitting arm's verdict judges its verb's batch as submitted, before any transform; a requester's
	// save of their own request in ChangesRequested is judged against its checkpoint when it resubmits (step 8) instead
	if (admitted !== undefined) {
		const checked = Object.values(admitted).some((arms) => arms?.some((arm) => arm.check) === true);
		// asked for every record the act may touch, so the route's own question is usually answered from memory
		const saving = new Set(
			(checked ? yield* context.held(holdRefs(m, cat, pre, guessed(items, pre))) : [])
				.filter((request) => request.state === 'ChangesRequested' && request.requester)
				.map((request) => k(request.model, request.record))
		);
		for (const verb of ['create', 'update', 'delete'] as const) {
			const arms = admitted[verb],
				roots = items.filter(
					(item) =>
						item.parent === undefined &&
						actionOf(item.change, pre) === verb &&
						!saving.has(k(item.change.model, named(item.change)))
				);
			if (arms === undefined || roots.length === 0) continue;
			const { input, missing } = yield* changeInputs(context, r.model, verb, roots, items, reads);
			if (missing !== undefined) return { guest, outcome: missing_record(missing.change.path) };
			const judged = yield* judge(
				e,
				own,
				auth,
				b,
				`${r.invocationId}:${r.model}:${verb}`,
				r.model,
				verb,
				arms,
				input,
				{ tables: readTables, fingerprints }
			);
			guest ||= judged.guest;
			const verdict = judged.verdict;
			if (verdict.kind === 'refuse') {
				const o = verdict.outcome;
				if (o.kind !== 'refused' || o.row === undefined) return { guest, outcome: o };
				// a refusal's row indexes the check's batch; the act's refusal names the input row
				const { row, ...rest } = o;
				const at = roots[row]?.change.path[0];
				return { guest, outcome: typeof at === 'number' ? { ...rest, row: at } : rest };
			}
			if (verdict.kind === 'approve') {
				if (flow !== undefined && canonical(flow) !== canonical(verdict.flow))
					return {
						guest,
						outcome: refused(
							'approval_split',
							'The rows in one act require different approval flows.'
						)
					};
				flow = verdict.flow;
			}
		}
	}
	return { guest, flow };
});

type ResolutionState = {
	identities: Map<string, string>;
	importRows: ImportRow[];
	upsertOutput: string[];
};
const resolveLevel = Effect.fn('Bolt.resolveLevel')(function* (
	context: PlanInput, items: Item[], level: number, state: ResolutionState
): Effect.fn.Return<Item[] | Outcome, EngineError> {
	const { r, pre, imp, own, visibility } = context, m = context.e.manifest, auth = r.authority;
	const { identities, importRows, upsertOutput } = state, { sync } = r.mode;
	const current = items.filter((item) => changeDepth(item) === level);
	const matches = yield* resolveUpserts(
		own,
		m,
		current.filter((item) => item.change.op === 'upsert')
	);
	for (const item of current) {
		const c = item.change;
		if (c.op !== 'upsert') continue;
		const found = matches.get(item),
			root = imp !== undefined && item.parent === undefined;
		if (
			found !== undefined &&
			((item.parent === undefined && !readableBy(auth, c.model, found, visibility)) ||
				(root && imp.on_conflict === 'refuse'))
		)
			return refused('unique', 'A record with these values already exists.', c.path);
		if (found === undefined && c.on.length === 1 && c.on[0] === 'id' && sync === undefined)
			return refused('not_found', `No ${c.model} has this id.`, [...c.path, 'id']);
		const id = found === undefined ? c.id : String(found['id']);
		const skip = found === undefined && root && imp.on_missing === 'skip';
		if (r.verb === 'upsert' && item.parent === undefined) upsertOutput.push(id);
		if (root)
			importRows.push({
				index: Number(c.path[0]),
				id: skip ? null : id,
				action: skip
					? 'skipped'
					: found === undefined
						? 'created'
						: c.on_conflict === 'keep'
							? 'kept'
							: 'updated'
			});
		if (skip || (found !== undefined && c.on_conflict === 'keep')) {
			items = items.filter((one) => one !== item && !descendantOf(one, item));
			continue;
		}
		if (found !== undefined) pre.set(k(c.model, id), found);
		const values = Object.fromEntries(
			Object.entries(c.values).filter(
				([field]) => field !== 'id' && (found === undefined || !c.on.includes(field))
			)
		);
		item.change =
			found === undefined
				? { model: c.model, id, path: c.path, op: 'create', values }
				: {
						model: c.model,
						id,
						path: c.path,
						op: 'update',
						set: values,
						revision: Number(found['revision'])
					};
		identities.set(changeToken(item), id);
		if (id !== c.id)
			for (const child of items) {
				if (
					child.parent?.model !== c.model ||
					child.parent.id !== c.id ||
					!descendantOf(child, item)
				)
					continue;
				child.parent = { ...child.parent, id };
				if (child.change.op !== 'delete')
					child.change =
						child.change.op === 'update'
							? { ...child.change, set: { ...child.change.set, [child.parent.fk]: id } }
							: { ...child.change, values: { ...child.change.values, [child.parent.fk]: id } };
			}
	}
	return items;
});

const prepareChanges = Effect.fn('Bolt.prepareChanges')(function* (
	context: PlanInput
): Effect.fn.Return<PreparedPlan | StoppedPlan, EngineError> {
	const { e, r, cat, pre, own } = context;
	const m = e.manifest, auth = r.authority, b = r.bindings;
	const { submitted } = context;
	let items: Item[] = submitted.map((item) => ({
		...item,
		change:
			item.change.op === 'update'
				? { ...item.change, set: { ...item.change.set } }
				: item.change.op === 'delete'
					? { ...item.change }
					: { ...item.change, values: { ...item.change.values } },
		...(item.parent === undefined ? {} : { parent: { ...item.parent } })
	}));
	const identities = new Map(submitted.map((item) => [changeToken(item), item.change.id]));
	const supplied = new Map(submitted.map((item) => [changeToken(item), item.supplied]));
	const importRows: ImportRow[] = [];
	const upsertOutput: string[] = [];
	const readTables = new Set<string>(),
		fingerprints: Fingerprint[] = [];
	const judged = yield* judgeSubmitted(context, items, { readTables, fingerprints });
	if ('outcome' in judged) return judged;
	let runs = judged.guest;
	const flow = judged.flow;
	// Parent callbacks may replace their native children. Each following level resolves its own keys before callbacks.
	for (let level = 0; level <= LIMITS.writeDepth; level++) {
		const resolved = yield* resolveLevel(context, items, level, { identities, importRows, upsertOutput });
		if ('kind' in resolved) return { guest: runs, outcome: resolved };
		items = resolved;
		// carried rows go straight to storage: their own model's callbacks never run
		const groups = Map.groupBy(
			items.filter((item) => changeDepth(item) === level && !carried(r, item)),
			(item) => canonical([item.change.model, item.change.op])
		);
		for (const roots of groups.values()) {
			const first = roots[0];
			if (first === undefined || first.change.op === 'upsert') continue;
			const model = first.change.model,
				verb = first.change.op;
			if (!hasCallback(m, model, verb)) continue;
			const port = yield* guest_port(e.guest);
			for (let offset = 0; offset < roots.length; offset += LIMITS.writeChunk) {
				const chunk = roots.slice(offset, offset + LIMITS.writeChunk),
					seed = `${r.invocationId}:${model}:${verb}:${level}:${offset / LIMITS.writeChunk}`;
				const { input, missing } = yield* changeInputs(context, model, verb, chunk, items, { readTables, fingerprints });
				if (missing !== undefined) return { guest: runs, outcome: missing_record(missing.change.path) };
				const from = chunk[0]?.change.path ?? [];
				const invocation: Invocation = {
					id: seed,
					kind: verb,
					target: model,
					input,
					ctx: {
						...guest_context(auth.actor, b, seed),
						policies: auth.policies,
						admin: auth.admin
					},
					budget: { crossings: LIMITS.crossings.write, readBytes: LIMITS.readBytes }
				};
				const original = e.bridge?.(invocation, own) ?? transformBridge(m, own, invocation);
				const bridge = prospectiveBridge(e, cat, b, auth.actor, items, pre, original);
				const g = yield* port.invoke(invocation, bridge);
				runs = true;
				for (const table of original.tables?.() ?? []) readTables.add(table);
				fingerprints.push(...(original.fingerprints?.() ?? []));
				if (g.kind === 'refused') {
					const at = g.row === undefined ? undefined : chunk[g.row];
					const row = at?.change.path.find((part) => typeof part === 'number');
					return {
						guest: true,
						outcome: {
							kind: 'refused',
							code: 'refused',
							message: g.message,
							...(g.key === undefined ? {} : { key: g.key }),
							...(g.values === undefined ? {} : { values: g.values }),
							rule: `${model}.${verb}`,
							...(g.field === undefined ? {} : { field: g.field }),
							...(typeof row === 'number' ? { row } : {})
						}
					};
				}
				if (g.kind === 'failed') return { guest: true, outcome: yield* guestFailure(g.error) };
				const answer = answerOf(verb, g.output, chunk.length, m, model);
				if (typeof answer === 'string')
					return yield* BoltError.make('transform_shape', 'guest', answer);
				// `on_approved` waits for the approving decision when the write is held (approvals.ts `approvedWrites`)
				const carries = [
					...answer.with.map((write) => [CARRIED, write] as const),
					...(flow === undefined
						? answer.on_approved.map((write) => [APPROVED, write] as const)
						: [])
				];
				if (carries.length > 0 && level === LIMITS.writeDepth)
					return yield* BoltError.make(
						'transform_shape',
						'guest',
						`a write nested ${LIMITS.writeDepth} deep carries no further writes`
					);
				const again = new Flattener(m, cat, minter(seed, b.now), identities);
				for (const [index, item] of chunk.entries()) {
					const c = item.change;
					if (c.op === 'create')
						again.create(model, 'any', withoutId(answer.sets[index]), c.path, item.parent);
					else if (c.op === 'update')
						again.update(model, 'any', c.id, answer.sets[index], c.revision, c.path, item.parent);
				}
				// rows of other models this write carries sit one level down, in this commit: the model's own code, straight to
				// storage (`CarriedWrites`). The root write's grant admits them; the native rules still hold their locks and state moves
				for (const [segment, write] of carries) {
					if (m.models[write.model] === undefined)
						return yield* BoltError.make(
							'transform_payload',
							'guest',
							`${write.model}: no such model`
						);
					const at = [...from, segment, write.model, write.op, write.index];
					if (write.op === 'create') again.create(write.model, 'any', write.row, at);
					else again.update(write.model, 'any', write.target, write.set, null, at);
				}
				if (again.problems.length)
					return yield* BoltError.make(
						'transform_payload',
						'guest',
						again.problems
							.map((problem) => `${problem.path.join('.')}: ${problem.message}`)
							.join('; ')
					);
				// one lookup per replacement: a find over the chunk is quadratic in a 1,000-row transform chunk
				const owners = new Map(chunk.toReversed().map((root) => [changeToken(root), root]));
				const replacements: Item[] = again.items.map((item) => {
					const owner = owners.get(changeToken(item));
					return {
						...item,
						supplied: supplied.get(changeToken(item)) ?? [],
						...(owner?.belongs === undefined ? {} : { belongs: owner.belongs })
					};
				});
				// a delete keeps its rows: only what it carries joins the act
				const replacedPaths = new Set(
					verb === 'delete' ? [] : chunk.map((item) => canonical(item.change.path))
				);
				items = [
					...items.filter(
						(item) =>
							!replacedPaths.has(canonical(item.change.path)) &&
							!item.change.path.some((_, index) =>
								replacedPaths.has(canonical(item.change.path.slice(0, index)))
							)
					),
					...replacements
				];
				for (const item of replacements) identities.set(changeToken(item), item.change.id);
				if (items.length > LIMITS.changesPerAct)
					return {
						guest: true,
						outcome: refused('overflow', `An act writes at most ${LIMITS.changesPerAct} rows.`)
					};
				const more = yield* readRows(
					own,
					cat,
					replacements.flatMap((item) =>
						item.change.op === 'update' || item.change.op === 'delete'
							? pre.has(k(item.change.model, item.change.id))
								? []
								: [[item.change.model, item.change.id] as const]
							: []
					)
				);
				for (const [key, row] of more) pre.set(key, row);
			}
		}
	}
	// a system model's engine transform (`ENGINE_TRANSFORMS`) sees every row of its model the act writes, carried ones too
	for (const [model, transform] of Object.entries(ENGINE_TRANSFORMS)) {
		if (!items.some((item) => item.change.model === model)) continue;
		const t = yield* transform(e.db, m, items, pre);
		if ('kind' in t) return { guest: runs, outcome: t };
		items = [...t];
	}
	// Callback output remains subject to the model's sync ownership.
	const owned = syncOwnership(m, r, items);
	if (owned !== null) return { guest: runs, outcome: owned };
	return { guest: runs, items, flow, importRows, upsertOutput, readTables, fingerprints };
});

const materializeChanges = Effect.fn('Bolt.materializeChanges')(function* (
	context: PlanInput, prepared: PreparedPlan
): Effect.fn.Return<DraftPlan | StoppedPlan, EngineError> {
	const { e, r, cat, pre } = context;
	const m = e.manifest, auth = r.authority, b = r.bindings;
	const { imp } = context, { items } = prepared, { sync } = r.mode;
	const stop = (outcome: Outcome): StoppedPlan => ({ guest: prepared.guest, outcome });
	// 7. upsert resolution read, defaults, model rules, no-op updates
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
			// a new record's initial state is the native rules'
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
			// an update that changes nothing is no write: restating a locked row (an unchanged re-import) is no refusal; locks
			// and state moves are the native rules', refused at commit (refusal.ts)
			const rule = Object.keys(set).length === 0 ? null : appRules(m, c.model, row, set);
			if (rule !== null) return stop(refused('invalid_input', rule.message, [...c.path, rule.field]));
			if (Object.keys(set).length > 0)
				writes.push({
					write: {
						model: c.model,
						id: c.id,
						op: 'update',
						set,
						revision: Number(row['revision'])
					},
					item: it
				});
			else unchanged.push({ model: c.model, id: c.id });
		}
	}
	// every custom field value the act writes passes its kind's `validate`
	const invalid = yield* validateCustom(e, r, writes);
	if (invalid !== null) return stop(invalid);
	return { writes, unchanged, report };
});

const routeChanges = Effect.fn('Bolt.routeChanges')(function* (
	context: PlanInput, prepared: PreparedPlan, draft: DraftPlan
): Effect.fn.Return<RoutedPlan | StoppedPlan, EngineError> {
	const { e, r, cat, pre, own } = context;
	const m = e.manifest, auth = r.authority, b = r.bindings;
	const { submitted } = context, { flow, readTables, fingerprints } = prepared, { writes, unchanged } = draft;
	let guest = prepared.guest;
	const stop = (outcome: Outcome): StoppedPlan => ({ guest, outcome });
	// 8. An `approve` verdict routes the act to its flow; a requester's save of requested changes is judged again.
	let approval: Commit['approval'], resubmit: Commit['resubmit'];
	const records = (model: string): HeldRecord[] =>
		writes
			.filter(({ write }) => write.model === model)
			.map(({ write }) => ({
				id: write.id,
				action: write.op,
				values: {
					...pre.get(k(write.model, write.id)),
					...(write.op === 'create' ? write.values : write.op === 'update' ? write.set : {}),
					id: write.id
				}
			}));
	const checked: DraftWrite[] = [...writes];
	// A nested-only update still needs its parent's declared relationship permission.
	for (const item of submitted)
		if (
			!auth.admin &&
			item.parent === undefined &&
			item.change.op === 'update' &&
			!checked.some(({ write }) => write.model === item.change.model && write.id === item.change.id)
		) {
			const row = pre.get(k(item.change.model, item.change.id));
			if (row !== undefined)
				checked.push({
					item,
					write: {
						model: item.change.model,
						id: item.change.id,
						op: 'update',
						set: {},
						revision: Number(row['revision'])
					}
				});
		}
	const held = yield* context.held(holdRefs(m, cat, pre, checked.map(({ write }) => write)));
	// an update that changes nothing is no write, yet its transform may carry `on_approved`: a held record's waits too
	const idle = yield* context.held(unchanged.map(({ model, id }) => [model, id] as const));
	// a change to a held record joins its request: what it carries `on_approved` waits for the approving decision too
	if (held.length > 0 || idle.length > 0)
		writes.splice(
			0,
			writes.length,
			...writes.filter(({ item }) => !item.change.path.includes(APPROVED))
		);
	if (r.readGuards !== undefined && held.length > 0)
		return stop(
			refused(
				'locked',
				'A guarded automation write cannot join or resubmit an existing approval request.'
			)
		);
	const saving = held.filter(
		(request) => request.state === 'ChangesRequested' && request.requester
	);
	if (saving.length > 1)
		return stop(refused('approval_split', 'One act cannot resubmit several approval requests.'));
	if (saving[0] !== undefined) {
		if (e.approval === undefined)
			return yield* BoltError.make('no_approval', 'admission', 'No approval flow is wired.');
		const request = saving[0];
		// a checkpoint the request can no longer supply is the act's conflict; its records stay held
		const reviewed = yield* reviewChange(m, cat, own, b, request, writes, { readTables, fingerprints }).pipe(
			Effect.map(Option.some),
			Effect.catchIf(
				(error) => error instanceof BoltError && error.code === 'conflict',
				() => Effect.succeedNone
			)
		);
		if (Option.isNone(reviewed))
			return stop({ kind: 'conflict', records: [{ model: request.model, id: request.record }] });
		const { change, needs } = reviewed.value;
		const verb = request.action;
		if (change.before === null && verb !== 'create')
			return stop({ kind: 'conflict', records: [{ model: request.model, id: request.record }] });
		if (change.after === null && verb !== 'delete')
			return stop(refused('not_found', 'The approval record does not exist.'));
		const values = change.after ?? change.before ?? {};
		const admits = (arm: WriteArm | DeleteArm) => !('columns' in arm) || needs.every((need) =>
			need.field === undefined ? Object.hasOwn(arm.columns, need.path) : arm.columns[need.path]?.includes(need.field) === true);
		const judged = auth.admin
			? { guest: false, verdict: { kind: 'allow' } satisfies Judgement }
			: yield* judge(
					e,
					own,
					auth,
					b,
					`${r.invocationId}:resubmit:${request.id}`,
					request.model,
					verb,
					(auth.models[request.model]?.[verb] ?? []).filter(admits),
					[change],
					{ tables: readTables, fingerprints }
				);
		guest ||= judged.guest;
		if (judged.verdict.kind === 'refuse') return stop(judged.verdict.outcome);
		const snapshot =
			judged.verdict.kind === 'approve' ? judged.verdict.flow : { kind: 'allow' as const };
		guest = true;
		resubmit = yield* e.approval.resubmit({
			request: request.id,
			authority: auth,
			bindings: b,
			snapshot,
			changed: writes.map(({ write }) => ({
				model: write.model,
				id: write.id,
				fields:
					write.op === 'delete' ? [] : Object.keys(write.op === 'create' ? write.values : write.set)
			})),
			records:
				records(request.model).length > 0
					? records(request.model)
					: [{ id: request.record, action: request.action, values }]
		});
	} else if (flow !== undefined && held.length === 0) {
		if (e.approval === undefined)
			return yield* BoltError.make('no_approval', 'admission', 'No approval flow is wired.');
		const root = checked.find(
			({ item }) => item.parent === undefined && item.change.model === r.model
		)?.write;
		// an unchanged Save writes nothing for a new request to hold
		if (root === undefined || writes.length === 0)
			return stop(refused('forbidden', 'No root record admits this approval.'));
		const route = yield* e.approval.route({
			model: r.model,
			record: root.id,
			action: root.op,
			authority: auth,
			bindings: b,
			seed: `${r.invocationId}:${r.key}`,
			snapshot: flow,
			records: records(r.model)
		});
		if ('kind' in route) return stop(route);
		approval = route;
	}
	// a write a flow requires joins the request already holding its records: the commit asserts that request still holds them
	return { guest, approval, resubmit, joined: resubmit === undefined && flow !== undefined && held.length > 0 };
});

const indexChanges = Effect.fn('Bolt.indexChanges')(function* (
	context: PlanInput, writes: readonly DraftWrite[], initialGuest: boolean
): Effect.fn.Return<boolean | StoppedPlan, EngineError> {
	const { e, r, pre } = context, m = e.manifest, auth = r.authority, b = r.bindings;
	let guest = initialGuest;
	const stop = (outcome: Outcome): StoppedPlan => ({ guest, outcome });
	// Pure search vectors are evaluated in bounded batches, all in one isolate run, and join the same native row writes.
	const parts: { model: string; name: string; dim: number; chunk: DraftWrite[] }[] = [];
	for (const [model, entries] of Map.groupBy(
		writes.filter(({ write }) => write.op !== 'delete'),
		({ write }) => write.model
	))
		for (const [name, index] of Object.entries(m.models[model]?.search?.indexes ?? {}))
			if (index.field === undefined)
				for (let offset = 0; offset < entries.length; offset += LIMITS.writeChunk)
					parts.push({ model, name, dim: index.dim, chunk: entries.slice(offset, offset + LIMITS.writeChunk) });
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
			if (write.op === 'create') entry.write = { ...write, values: { ...write.values, [column]: vector } };
			else if (write.op === 'update') entry.write = { ...write, set: { ...write.set, [column]: vector } };
		}
	}
	return guest;
});

const plan = Effect.fn('Bolt.plan')(function* (
	e: WriteEngine,
	r: ActRequest,
	cat: Catalog,
	submitted: readonly Item[],
	pre: Map<string, RowData>,
	imp?: ImportPlan,
	upserted?: (string | null)[],
	own: TenantDb = e.db,
	visibility: Map<string, boolean> = new Map<string, boolean>(),
	admitted?: Admitted,
	seen: readonly Fingerprint[] = []
): Effect.fn.Return<Planned, EngineError> {
	const context: PlanInput = { e, r, cat, submitted, pre, imp, own, visibility, admitted, held: heldBy(own, r.authority.actor) };
	const prepared = yield* prepareChanges(context);
	if ('outcome' in prepared) return prepared;
	const draft = yield* materializeChanges(context, prepared);
	if ('outcome' in draft) return draft;
	const routed = yield* routeChanges(context, prepared, draft);
	if ('outcome' in routed) return routed;
	const indexed = yield* indexChanges(context, draft.writes, routed.guest);
	if (typeof indexed !== 'boolean') return indexed;
	const guest = indexed, m = e.manifest, auth = r.authority, b = r.bindings;
	const { unchanged, report } = draft, { approval, resubmit, joined } = routed;
	// a held delete commits only its request: its rows, and what its transform carries, wait for the approving decision
	const writes = approval !== undefined && r.verb === 'delete' ? [] : draft.writes;
	const { importRows, upsertOutput, readTables, fingerprints } = prepared, { sync } = r.mode;
	const resolvedImportIndices = new Set(importRows.map((row) => row.index));
	const stop = (outcome: Outcome): StoppedPlan => ({ guest, outcome });
	const embed = embedWrites(
		m,
		writes.map(({ write, item }) => (carried(r, item) ? { ...write, carried: true as const } : write))
	); // hook:integrations — stale embeddings null, `bolt.embed` queued
	const plain = embed.writes;
	const queued = embed.stale
		? [embedQueued(minter(`${r.invocationId}:embed`, b.now)(), b.now)]
		: []; // hook:integrations
	if (utf8Bytes(JSON.stringify(plain)) > LIMITS.changeSetBytes)
		return stop(refused('overflow', 'The change is too large for one act.'));
	const tables = [...new Set([...plain.map((w) => w.model), ...readTables])].sort();
	return {
		guest,
		commit: {
			now: b.now,
			today: b.today,
			actor: auth.actor,
			writer: writerOf(r.authority),
			writes: plain,
			runs: queued,
			output:
				upserted ??
				(r.verb === 'upsert'
					? upsertOutput
					: imp !== undefined
						? {
								rows: [
									...importRows,
									...report.filter(
										(row) => row.index === null || !resolvedImportIndices.has(row.index)
									)
								].sort((a, b) => (a.index ?? Infinity) - (b.index ?? Infinity))
							}
						: null),
			...(plain.length === 0 && unchanged.length > 0 ? { unchanged } : {}),
			...(approval === undefined ? {} : { approval }),
			...(resubmit === undefined ? {} : { resubmit }),
			...(joined ? { joined } : {}),
			...((r.on_conflict === 'keep' || imp?.on_conflict === 'keep') && plain.some((w) => w.op === 'create')
				? { kept: true as const }
				: {}),
			...(r.restored === undefined ? {} : { restored: [{ model: r.model, ...r.restored }] }),
			// the guest's reads, and which rows the caller could read when admitted (a ref's target too)
			...(guest || seen.length > 0 ? { fingerprints: [...(guest ? fingerprints : []), ...seen] } : {}),
			...(sync === undefined ? {} : { pieces: sync.pieces })
		},
		...(guest && readTables.size > 0
			? { lock: { tables, mode: 'SHARE ROW EXCLUSIVE' as const } }
			: {})
	};
});
/**
 * The engine's own transforms, by system model: rules no guest transform can see. `sys_integration` keeps an instance true
 * of the manifest's definition and names only an active envoy (read only when a row names one).
 */
const ENGINE_TRANSFORMS: {
	readonly [model: string]: (
		db: TenantDb,
		m: EngineManifest,
		items: readonly Item[],
		pre: ReadonlyMap<string, RowData>
	) => Effect.Effect<readonly Item[] | Outcome, EngineError>;
} = {
	sys_integration: Effect.fnUntraced(function* (
		db: TenantDb,
		m: EngineManifest,
		items: readonly Item[],
		pre: ReadonlyMap<string, RowData>
	) {
		const envoyNamed = items.some(({ change: c }) =>
			c.model === 'sys_integration' && c.op !== 'delete' && (c.op === 'update' ? c.set : c.values)['envoy'] != null);
		const [envoys] = envoyNamed
			? yield* db.read([{ text: 'SELECT id FROM sys_envoy WHERE active', params: [] }])
			: [undefined];
		const active = new Set((envoys?.rows ?? []).flatMap((row) => (typeof row['id'] === 'string' ? [row['id']] : [])));
		return instanceTransform(m, items, (id) => pre.get(k('sys_integration', id)), active);
	})
};
/** Read-only syncs own their model; caller updates are limited to its declared local columns. */
export function readOnlySync(m: EngineManifest, model: string): string | undefined {
	return Object.entries(m.exposures[model]?.syncs ?? {}).find(
		([, sync]) => sync.with !== 'file' && sync.read === true && sync.write !== true
	)?.[0];
}
function syncOwnership(m: EngineManifest, r: ActRequest, items: readonly Item[]): Outcome | null {
	const { sync } = r.mode;
	for (const { change: c } of items) {
		const written =
			c.op === 'update'
				? Object.keys(c.set)
				: c.op === 'delete'
					? []
					: Object.keys(c.values).filter((field) => field !== 'id');
		if (sync !== undefined) {
			if (c.model !== r.model)
				return refused('forbidden', `A sync writes only ${r.model}.`, c.path);
			const field = written.find((field) => !sync.fields.includes(field));
			if (field !== undefined)
				return refused('forbidden', `'${field}' of ${c.model} is outside this sync's fields.`, [
					...c.path,
					field
				]);
			continue;
		}
		const owner = readOnlySync(m, c.model);
		if (owner === undefined) continue;
		if (c.op !== 'update')
			return refused('forbidden', `${c.model} is written by its sync ${owner}.`, c.path);
		const local = m.exposures[c.model]?.update?.columns[c.model] ?? [];
		const field = written.find((field) => !local.includes(field));
		if (field !== undefined)
			return refused('forbidden', `'${field}' of ${c.model} is written by its sync ${owner}.`, [
				...c.path,
				field
			]);
	}
	return null;
}
export const hasCallback = (m: EngineManifest, model: string, verb: 'create' | 'update' | 'delete'): boolean =>
	m.exposures[model]?.[verb]?.transform === true;
/**
 * The model rules the native rules cannot see: an enum's declared `transitions` and an owned child's fixed parent key.
 * Locks, state moves and owned parents' locks are the native rules' (store `rules.ts`), refused at commit.
 */
function appRules(
	m: EngineManifest,
	model: string,
	row: RowData,
	set: RowData
): { message: string; field: string } | null {
	for (const [field, kind] of Object.entries(m.models[model]?.fields ?? {}))
		if (kind.kind === 'enum' && kind.transitions !== undefined && set[field] !== undefined) {
			const from = String(row[field] ?? ''),
				next = String(set[field]);
			if (from !== next && !(kind.transitions[from] ?? []).includes(next))
				return { message: `'${from}' cannot move to '${next}'.`, field };
		}
	for (const fk of Object.keys(set))
		if (m.relationships[`${model}.${fk}`]?.owned)
			return { message: 'An owned record never changes its parent.', field: fk };
	return null;
}
export const wireRows = Effect.fn('Bolt.wireRows')(function* (
	db: TenantDb,
	cat: Catalog,
	c: string,
	ids: readonly (string | null)[],
	b: Bindings,
	select: SelectIR = { fields: null, relations: {} }
) {
	const want = ids.filter((id) => id !== null);
	if (want.length === 0) return ids.map(() => null);
	const [res] = yield* db.read([
		composable(
			yield* compile_gets(cat, c, want, select, readOptions({ as: 'workspace' }, b)).pipe(
				Effect.mapError(from_store)
			)
		)
	]);
	if (res === undefined) return yield* BoltError.make('internal', 'decode', 'A stored tree read returned no result.');
	const rows = yield* Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({
		j: Schema.NullOr(Schema.StructWithRest(Schema.Struct({ id: Schema.String }), [Schema.Record(Schema.String, Schema.Json)]))
	})))(res.rows).pipe(Effect.mapError((error) => BoltError.make('internal', 'decode', error.message)));
	const byId = new Map<string, RowData>();
	for (const { j } of rows) if (j !== null) byId.set(j.id, j);
	return ids.map((id) => (id === null ? null : (byId.get(id) ?? null)));
});
export type Probe = Pick<WriteEngine, 'manifest' | 'db' | 'guest' | 'bridge'>;
/**
 * What a write's verdict answers for unchanged stored records: the same before/set/after envelope as an act, every row
 * read at once and judged in one verdict. Without a guest no verdict can run, so a guarded verb reads as denied (the
 * act judges for real); a missing row is denied.
 */
export const opened = Effect.fn('Bolt.opened')(function* (
	e: Probe,
	authority: Authority,
	bindings: Bindings,
	model: string,
	verb: 'update' | 'delete',
	ids: readonly string[]
): Effect.fn.Return<Judgement['kind'], EngineError> {
	if (authority.admin) return 'allow';
	const arms = authority.models[model]?.[verb] ?? [];
	if (arms.length === 0) return 'refuse';
	if (arms.some((arm) => !arm.check)) return 'allow';
	if (e.guest === undefined) return 'refuse';
	const cat = catalog_of(e.manifest);
	const before =
		verb === 'update'
			? yield* storedTrees(e.db, e.manifest, cat, model, ids, bindings)
			: yield* wireRows(e.db, cat, model, ids, bindings);
	const rows = before.filter((row) => row !== null);
	if (rows.length !== ids.length) return 'refuse';
	const { verdict } = yield* judge(
		e,
		e.db,
		authority,
		bindings,
		`open:${model}:${ids.join(',')}`,
		model,
		verb,
		arms,
		rows.map((row) => ({ before: row, set: {}, after: verb === 'update' ? row : null }))
	);
	return verdict.kind;
});
/**
 * Whether deleting `ids` of `model` would commit (`allow`), be held for approval (`approve`) or be refused (`refuse`): the
 * delete's admission over every row in one read and one verdict, as the act judges them together.
 */
export const delete_verdict = Effect.fn('Bolt.deleteVerdict')(function* (
	e: Probe,
	model: string,
	ids: readonly string[],
	authority: Authority,
	bindings: Bindings
) {
	const m = Object.hasOwn(SYSTEM.exposures, model) ? layered(e.manifest) : e.manifest;
	if (m.exposures[model]?.delete === undefined || ids.length === 0) return 'refuse' as const;
	return yield* opened({ ...e, manifest: m }, authority, bindings, model, 'delete', [...new Set(ids)]);
});
/**
 * Whether `authority` may update the row at all (its update checks allow it unchanged, or the admin bypass), and `null`
 * when there is no such row. A host verb on a row (an integration instance's pair, unpair, test) authorizes so.
 */
export const mayUpdate = Effect.fn('Bolt.mayUpdate')(function* (
	e: Probe,
	model: string,
	id: string,
	authority: Authority,
	bindings: Bindings
) {
	const m = Object.hasOwn(SYSTEM.exposures, model) ? layered(e.manifest) : e.manifest;
	const pre = yield* readRows(e.db, catalog_of(m), [[model, id]]);
	if (!pre.has(k(model, id))) return null;
	return (
		(yield* opened({ ...e, manifest: m }, authority, bindings, model, 'update', [id])) === 'allow'
	);
});
/**
 * A NOT NULL key column (a field or single-column ref that is not optional): its upsert lookup joins with `=`, which
 * hashes or uses the key index; `IS NOT DISTINCT FROM` admits only a nested loop, rows × table.
 */
const required = (m: EngineManifest, model: string, field: string): boolean => {
	const kind = m.models[model]?.fields[field],
		rel = m.relationships[`${model}.${field}`];
	return kind !== undefined ? kind.optional !== true : rel !== undefined && rel.optional !== true;
};
const resolveUpserts = Effect.fn('Bolt.resolveUpserts')(function* (
	db: TenantDb,
	m: EngineManifest,
	upserts: readonly Item[]
) {
	const found = new Map<Item, RowData>();
	const byTable = new Map<
		string,
		{ on: readonly string[]; items: { item: Item; values: RowData }[] }
	>();
	for (const item of upserts) {
		const change = item.change;
		if (change.op !== 'upsert')
			return yield* Effect.fail(
				BoltError.make('internal', 'decode', 'an upsert lookup received another write')
			);
		const group = byTable.get(change.model);
		const entry = { item, values: change.values };
		if (group === undefined) byTable.set(change.model, { on: change.on, items: [entry] });
		else group.items.push(entry);
	}
	if (byTable.size === 0) return found;
	const tables = [...byTable];
	const cat = catalog_of(m);
	const raw = yield* read_composed(
		db,
		tables.map(([t, { on, items }]) =>
			composable({
				text: `SELECT DISTINCT ${storedRowSql(cat, t, 't')} AS j FROM ${q(t)} t JOIN jsonb_populate_recordset(${null_row_sql(t, cat.models.get(t)?.fields.keys() ?? [])}, $1::jsonb) r
			ON ${on.map((f) => `t.${q(f)} ${required(m, t, f) ? '=' : 'IS NOT DISTINCT FROM'} r.${q(f)}`).join(' AND ')}`,
				params: [
					JSON.stringify(items.map(({ values }) =>
						Object.fromEntries(on.map((field) => [
							field, database_value(values[field] ?? null, cat.models.get(t)?.fields.get(field))
						]))
					))
				]
			})
		)
	);
	for (const [index, [table, { on, items }]] of tables.entries()) {
		const rows = yield* storedRows(cat, table, raw[index]);
		const indexed = new Map(
			rows.map((row) => [canonical(on.map((field) => String(row[field] ?? null))), row])
		);
		for (const { item, values } of items) {
			const row = indexed.get(
				canonical(on.map((field) => String(database_value(values[field] ?? null))))
			);
			if (row !== undefined) found.set(item, row);
		}
	}
	return found;
});
const validateCustom = Effect.fn('Bolt.validateCustom')(function* (
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
	// every custom kind's values cross in one isolate run
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
		const out = yield* Schema.decodeUnknownEffect(Schema.Array(Schema.NullOr(Schema.String)))(g.output).pipe(
			Effect.mapError((error) => BoltError.make('bad_answer', 'guest', `${of}: ${error.message}`, error))
		);
		if (out.length !== values.length)
			return yield* BoltError.make('bad_answer', 'guest', `${of}: validation returns one answer per value.`);
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
	{ readonly failed: BoltError } | { readonly vectors: readonly (readonly (readonly number[] | null)[])[] },
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

/**
 * Rules 42, 72: what a failed guest invocation answers. A throw from tenant code is `internal` (its message reaches
 * members only); a budget keeps its own code; anything else is a platform fault, thrown with its cause (72a).
 */
export function guestFailure(error: BoltError): Effect.Effect<Outcome, BoltError> {
	switch (error.code) {
		case 'guest_error':
		case 'internal':
			return Effect.succeed(refused('internal', error.message));
		case 'read_budget_exceeded':
		case 'cpu_budget':
		case 'crossing_budget':
		case 'memory':
		case 'too_large':
			return Effect.succeed(refused(error.code, error.message));
		default:
			return Effect.fail(error);
	}
}
/** Runs a commit's statements and rolls them back: an import preview's outcome. */
export const dry_run = Effect.fn('Bolt.dry_run')(function* (
	db: TenantDb,
	statements: readonly Sql[],
	lock: Lock | undefined,
	meta: ReadonlyMap<string, ConstraintMeta>
) {
	return yield* db
		.transaction({ statements, rollback: true, ...(lock === undefined ? {} : { lock }) })
		.pipe(
			Effect.flatMap((rows) =>
				Schema.decodeUnknownEffect(CommitAnswer)(rows[statements.length - 1]?.rows[0]).pipe(
					Effect.mapError((error) => BoltError.make('bad_answer', 'commit', error.message, error)),
					Effect.map((answer) => answer.outcome ?? LOST_OUTCOME)
				)
			),
			Effect.catch((error) =>
				error instanceof BoltError
					? Effect.fail(error)
					: decideError(error, meta).pipe(Effect.map((decision) => decision.outcome))
			)
		);
});

/** Workspace reads shared by direct writes and verbs recorded in an atomic batch. */
export function transformBridge(
	manifest: EngineManifest,
	db: TenantDb,
	invocation: Invocation
): Bridge & { tables(): readonly string[]; fingerprints(): readonly Fingerprint[] } {
	const tables = new Set<string>();
	const recorded = fingerprinting(db);
	const reader = read_engine({
		db: recorded.db,
		manifest,
		delegate: {
			history: (read, who, bindings) =>
				read.kind === 'history'
					? read_history(recorded.db, manifest, read, who, bindings)
					: Effect.fail(BoltError.make('invalid', 'decode', 'Expected a history read.'))
		}
	});
	const bindings: Bindings = {
		now: invocation.ctx.now,
		today: invocation.ctx.today,
		tz: invocation.ctx.tz
	};
	return {
		tables: () => [...tables],
		fingerprints: recorded.fingerprints,
		cross: (calls) =>
			Effect.gen(function* () {
				type ReadCall = Extract<Parameters<Bridge['cross']>[0][number], { _tag: 'read' }>;
				const groups = new Map<string, { reads: { index: number; read: ReadCall['read'] }[] }>();
				const answers = calls.map((call): CrossAnswer => ({
					ok: false,
					error: {
						kind: 'bolt',
						code: 'unsupported',
						message: `a write callback cannot ${call._tag}`
					}
				}));
				for (const [index, call] of calls.entries()) {
					if (call._tag !== 'read') continue;
					for (const table of readTargets(reader.catalog, call.read)) tables.add(table);
					const cte =
						call.read.kind === 'read' || call.read.kind === 'get' ? call.read.cte : undefined;
					const scope = cte === undefined ? index : cte.split(':', 1)[0];
					const key = canonical(scope ?? index);
					let group = groups.get(key);
					if (group === undefined) {
						group = { reads: [] };
						groups.set(key, group);
					}
					group.reads.push({ index, read: call.read });
				}
				// Keyed members share their invocation's SQL CTE namespace; independent reads keep separate failures.
				yield* Effect.forEach(
					[...groups.values()],
					(group) =>
						reader
							.run(
								group.reads.map(({ read }) => read),
								{ as: 'workspace' },
								bindings
							)
							.pipe(
								Effect.provideService(ReadDeps, tables),
								Effect.map((values) => {
									for (const [position, { index }] of group.reads.entries())
										answers[index] = { ok: true, value: values[position] ?? null };
								}),
								Effect.catch((error) =>
									Effect.sync(() => {
										for (const { index } of group.reads)
											answers[index] = {
												ok: false,
												error: {
													kind: 'bolt',
													code: error instanceof BoltError ? error.code : 'internal',
													message: error.message
												}
											};
									})
								)
							),
					{ concurrency: 'unbounded' }
				);
				return answers;
			})
	};
}

/** The path segments under which a write's carried rows sit, one level below the rows that carry them. */
const CARRIED = '$with',
	APPROVED = '$on_approved';
/** A carried row: under a callback's `with` or `on_approved`, or a row of an approved write's `on_approved` act. */
const carried = (r: ActRequest, item: Item) =>
	r.mode.carriedBy !== undefined || item.change.path.includes(CARRIED) || item.change.path.includes(APPROVED);
/** A create transform reads its row's id; the id it answers is the act's own, never a value. */
const withoutId = (row: Json | undefined) => {
	if (!record(row)) return row;
	const { id: _id, ...rest } = row;
	return rest;
};
/** A JSON object, narrowed so its values stay JSON. */
const record = (value: Json | undefined): value is { readonly [key: string]: Json } =>
	typeof value === 'object' && value !== null && !Array.isArray(value);
export type CarriedWrite =
	| { readonly model: string; readonly op: 'create'; readonly index: number; readonly row: Json }
	| {
			readonly model: string;
			readonly op: 'update';
			readonly index: number;
			readonly target: { readonly id: string; readonly revision?: number };
			readonly set: RowData;
	  };
/**
 * The callback returns its sets in input order, with optional carried writes in the same commit or on approval. A delete
 * returns no sets: nothing, or only what it carries.
 */
export const answerOf = (
	verb: 'create' | 'update' | 'delete',
	output: Json,
	count: number,
	m: EngineManifest,
	rootModel: string
):
	| {
			readonly sets: readonly Json[];
			readonly with: readonly CarriedWrite[];
			readonly on_approved: readonly CarriedWrite[];
	  }
	| string => {
	try {
	const whole = record(output) ? output : undefined;
	if (verb === 'delete' && output !== null && (whole === undefined || 'sets' in whole))
		return 'a delete callback returns nothing, or only with and on_approved';
	if (whole !== undefined && Object.keys(whole).some((key) => !['sets', 'with', 'on_approved'].includes(key)))
		return 'a callback answer contains only sets, with and on_approved';
	// a delete keeps its rows: it answers no sets
	const sets = verb === 'delete' ? [] : whole === undefined ? output : (whole['sets'] ?? null);
	if (!Array.isArray(sets) || (verb !== 'delete' && sets.length !== count))
		return 'a write callback returns one set per input';
	const groups: { with: CarriedWrite[]; on_approved: CarriedWrite[] } = { with: [], on_approved: [] };
	for (const key of ['with', 'on_approved'] as const) {
		const declared = whole?.[key];
		if (declared === undefined) continue;
		if (!record(declared)) return `${key} maps a model to its creates and updates`;
		for (const [model, spec] of Object.entries(declared)) {
			if (!record(spec)) return `${key}.${model} holds create and update lists`;
			const { create = [], update = [], ...rest } = spec;
			if (Object.keys(rest).length > 0 || !Array.isArray(create) || !Array.isArray(update))
				return `${key}.${model} holds create and update lists`;
			create.forEach((row, index) => groups[key].push({ model, op: 'create', index, row: writeFields(m, model, row, 'create') }));
			for (const [index, change] of update.entries()) {
				const at = `${key}.${model}.update[${index}]`;
				if (!record(change) || Object.keys(change).some((field) => field !== 'target' && field !== 'set'))
					return `${at} is { target, set }`;
				const target = writeTarget(m, model, change['target']);
				const set = change['set'];
				if (!record(set)) return `${at}.set must be an object`;
				const normalized = writeFields(m, model, set, 'update');
				if (!record(normalized)) return `${at}.set must be an object`;
				groups[key].push({ model, op: 'update', index, target, set: normalized });
			}
		}
	}
	return { sets: verb === 'delete' ? [] : sets.map((set) => writeFields(m, rootModel, set, verb)), ...groups };
	} catch (error) {
		return error instanceof BoltError ? error.message : String(error);
	}
};
