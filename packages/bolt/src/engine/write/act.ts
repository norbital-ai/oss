// The act pipeline (rule 19), in rule order: rate admission → decode → marked-retry lookup → the records named and the
// columns admitted per write path → observed-revision checks → the policies' checks on the submitted trees → batched
// per-verb callbacks → defaults and model rules → the approval route → one write statement (rule 20), or the outcome record.
import type { Json } from '../../decl/values.ts';
const jsonArray = (value: Json | undefined): value is readonly Json[] => Array.isArray(value);
import { encode_wire } from '@norbital-ai/std/wire';
import { audited, auditActor } from '../audit-operation.ts';
import { Audit } from '../audit.ts';
import type { ApprovalSnapshot } from '../../decl/access/policy.ts';
import { WriteOutcome as OutcomeSchema } from '../../protocol/schema.ts';
import { HistorySnapshotSchema } from '../../protocol/record-contracts.ts';
import type {
	RecordCapabilities,
	RecordRestriction,
	RecordParentContext
} from '../../protocol/record-contracts.ts';
import type {
	Authority,
	Bindings,
	Change,
	CrossAnswer,
	Invocation,
	InputPath,
	Lock,
	Outcome,
	RowData,
	Sql,
	DeleteArm,
	WriteArm
} from '../contracts.ts';
import type { SelectIR } from '@norbital-ai/store';
import type { Bridge } from '../services.ts';
import { layered, type EngineManifest } from '../manifest.ts';
import type { GuestShape as GuestPort } from '../services.ts';
import type { TenantDbShape as TenantDb } from '../db/tenant-db.ts';
import { storedChanges, storedField, storedRow, storedRowSql } from '../db/stored.ts';
import { storedRows } from '../db/rows.ts';
import { LIMITS, utf8Bytes } from '../contracts.ts';
import { SerializationReplay, type EngineError } from '../errors.ts';
import { LOST_OUTCOME, settleCommit } from './result.ts';
import { RATE_LIMITED } from '../../protocol/wire.ts';
import { BoltError, from_store } from '../../protocol/errors.ts';
import { admitMove, readPredicates, readsAny } from '../access/authority.ts';
import { catalog_of } from '../access/pred.ts';
import { approval_hook } from '../approvals/approvals.ts';

import { read_history } from '../query/history.ts';
import { holders } from '../approvals/lock.ts';
import { Snapshot } from '../approvals/snapshot.ts';
import { Effect, Layer, Option, Predicate, Schema } from 'effect';
import * as EffectArray from 'effect/Array';
import {
	Guest,
	Live,
	Links,
	Manifest,
	Telemetry,
	Wake,
	Writes,
	type ActMode,
	type ActRequest,
	type ActResult,
	type PlannedCommit,
	type InvocationEvents
} from '../services.ts';
import { TenantDb as TenantDbService } from '../db/tenant-db.ts';
export type { ActRequest, ActResult } from '../services.ts';
import { index_column, null_row_sql, q, type Catalog, type Pred } from '@norbital-ai/store';
import { evaluate, type EvalEnv } from '../query/eval.ts';
import { toPred } from '../access/pred.ts';
import { compile_gets, grant_sql } from '@norbital-ai/store';
import {
	coalescing,
	memo_reads,
	read_composed,
	read_engine,
	readTargets,
	ReadDeps
} from '../query/engine.ts';
import { scopeOf, composable, readOptions, resolverOf } from '../query/reader.ts';
import { constraintIndex } from '../schema/plan.ts';
import { type ConstraintMeta } from '@norbital-ai/store';
import {
	compileCommit,
	executeCommit,
	compile_outcome_record,
	committed,
	CommitAnswer,
	type Commit,
	type OwnedLock,
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
import { canonical, sha256_hex, database_value } from '@norbital-ai/store';
import { decideError, KEY_REUSE, minter, fingerprinting, type Fingerprint } from './sql.ts';
import { prospectiveBridge } from './prospective.ts';
import { writeFields, writeTarget } from '../callables/parse.ts';
import { replayOnce } from './replay.ts';
import { erase } from './erase.ts';
import { importPlan, importRefs, type ImportPlan } from './import.ts';
import { embedQueued, embedWrites } from '../integrations/embed.ts'; // hook:integrations
import { instanceTransform } from '../integrations/instances.ts';
import { SYSTEM } from '../../system/index.ts';
/** The generated verbs (X-24): `import` (rule 30) and `erase` (rule 38e) included. */
type Obj = {
	readonly [k: string]: Json;
};
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
	committed?: (
		answer: Pick<CommitAnswer, 'captured' | 'next_due' | 'changed_instances'>
	) => Effect.Effect<number>;
	manifest: EngineManifest;
	db: TenantDb;
	guest?: GuestPort;
	/**
	 * The transform's reads as the workspace (rule 15); `tables()` names what it read, for rule 26's lock, and
	 * `fingerprints()` digests them, for rule 26's assert.
	 */
	bridge?: (
		invocation: Invocation,
		db?: TenantDb
	) => Bridge & {
		tables?(): readonly string[];
		fingerprints?(): readonly Fingerprint[];
	};
	/** Rule 38: the serving cell's in-memory windows, charged before decode. */
	admit?: (request: ActRequest) => {
		retryAfter: number;
	} | null;
	approval?: ApprovalHook;
};
type ModeContext = {
	sync?: Extract<ActMode, { _tag: 'Sync' }>;
	sink?: Extract<ActMode, { _tag: 'Record' }>['sink'];
	pending?: ReadonlyMap<string, RowData>;
};
export const modeContext = (mode: ActMode): ModeContext => {
	switch (mode._tag) {
		case 'Direct':
			return {};
		case 'Sync':
			return { sync: mode };
		case 'Record':
			return { sink: mode.sink, pending: mode.pending };
	}
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
const HOUR = 3600000;
export const k = (model: string, id: string) => `${model}\u0000${id}`;
export type Taker = (
	severity: 'info' | 'warn',
	event: string,
	attributes: {
		readonly [key: string]: Json;
	}
) => Effect.Effect<void>;
/**
 * Runs one act (a generated verb) to its outcome. §5.12: the statement that writes (the commit or the outcome record)
 * takes the event buffer as a piece; a refusal decided before guest code writes no row, so its event is stdout only.
 */
export const act = Effect.fn('Bolt.act')(function* (e: WriteEngine, r: ActRequest) {
	let took = false;
	const take: Taker = (severity, event, attributes) =>
		Effect.gen(function* () {
			took = true;
			if (e.log === undefined) return;
			yield* e.log.emit(severity, event, { callable: `${r.model}.${r.verb}`, ...attributes });
		});
	const res = yield* r.verb === 'erase' ? erase(e, r, take) : pipeline(e, r, take);
	const o = res.outcome;
	if (!took && e.log !== undefined && (o.kind === 'refused' || o.kind === 'conflict')) {
		yield* e.log.emit('warn', 'act.refused', {
			callable: `${r.model}.${r.verb}`,
			code: o.kind === 'refused' ? o.code : 'conflict'
		});
	}
	return res;
});
/** Rule 31: the record's key (principal, callable, client key) and the request digest, and the stored-outcome lookup. */
export const idempotency = Effect.fn('Bolt.idempotency')(function* (
	e: WriteEngine,
	r: ActRequest,
	auth: Authority
) {
	const principal = canonical({
		actor: auth.actor.kind === 'member' ? auth.actor.id : auth.actor,
		callable: `${r.model}.${r.verb}`
	});
	const key = sha256_hex(`${principal}\u0000${r.key}`);
	const digest = sha256_hex(
		canonical({
			callable: `${r.model}.${r.verb}`,
			input: r.input,
			on_conflict: r.on_conflict ?? null
		})
	);
	const stored = Effect.fnUntraced(function* () {
		const [rows] = yield* e.db.read([
			{
				text: `SELECT i.digest, o.outcome FROM bolt_idem i JOIN bolt_idem_outcome o USING (key)
			WHERE i.key = $1 AND i.issued_at > $2::timestamptz - interval '24 hours'`,
				params: [key, r.issuedAt]
			}
		]);
		const row = rows?.rows[0];
		if (row === undefined) return null;
		const value = yield* Schema.decodeUnknownEffect(
			Schema.Struct({ digest: Schema.String, outcome: OutcomeSchema })
		)(row).pipe(
			Effect.mapError((error) => BoltError.make('corrupt', 'decode', error.message, error))
		);
		return value.digest === digest ? value.outcome : KEY_REUSE;
	});
	return { key, digest, stored };
});
/** Rule 31: an `issuedAt` older than 23 h or more than 5 min ahead is `expired`, before anything is read. */
export const expired = (r: ActRequest): Outcome | null => {
	const age = Date.parse(r.bindings.now) - Date.parse(r.issuedAt);
	return age <= 23 * HOUR && age >= -5 * 60000
		? null
		: refused('expired', 'The request expired; send it again.');
};
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
	const { sync, sink, pending } = modeContext(r.mode);
	const auth = sync ? { ...r.authority, admin: true } : r.authority; // A sync page is workspace work, outside caller grants.
	const none = (outcome: Outcome): ActResult => ({ outcome, captured: [], v: 0 });
	// 1. rate admission (host memory, rule 38): never recorded
	const limited = e.admit?.(r);
	if (limited) return none(refused('rate_limited', RATE_LIMITED));
	const late = expired(r);
	if (late !== null) return none(late);
	// 2. decode against the model's input allowlist, every offender at once (rule 23)
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
	// rule 30: an import's options and its refs by key values, resolved before decode (one read per target)
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
	// rule 28: an upsert row whose `id` is on file is an update of it (`keep`: left as it is), resolved here, before the
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
		if (r.verb === 'create' || (imp !== undefined && imp.on_conflict === undefined))
			f.create(r.model, sel, x, path);
		else if (imp !== undefined)
			f.create(r.model, sel, x, path, undefined, {
				on: key0,
				on_conflict: imp.on_conflict === 'update' ? 'update' : 'keep'
			});
		else if (byId && r.on_conflict !== undefined) {
			const { id, ...row } = x as Obj;
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
	// 3. the idempotency record (rule 31): looked up before guest code only on a marked retry
	const { key, digest, stored } = yield* idempotency(e, r, auth);
	if (r.retry) {
		const o = yield* stored();
		if (o !== null) return none(o);
	}
	// the act's own reads: those issued together cross as one round trip and one statement, and a read repeated
	// before the commit (an import's key resolution, after its transform) is answered from the first
	const own = yield* memo_reads(yield* coalescing(e.db));
	// rule 30: `prune` deletes the caller-readable rows inside its `Where` whose key the import does not name; an
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
	const scope = { authority: auth, bindings: b, visibility };
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
	for (const [key, row] of pending ?? []) if (!pre.has(key)) pre.set(key, row); // hook:callables
	const created = new Map<string, RowData>();
	for (const i of f.items)
		if (i.change.op === 'create' || i.change.op === 'upsert')
			created.set(k(i.change.model, i.change.id), storedRow(cat, i.change.model, { ...i.change.values, id: i.change.id }));
	const env: EvalEnv = {
		cat,
		bindings: b,
		authority: auth,
		related: (c, rel, target, row) => {
			if (!cat.models.get(c)?.one.has(rel))
				throw BoltError.make(
					'unsupported',
					'admission',
					`a model rule cannot scope through many-relation '${rel}'`
				);
			const descriptor = cat.models.get(c)?.fields.get(rel), value = descriptor === undefined ? row[rel] : storedField(descriptor, row);
			const id = Predicate.isObject(value) && value['model'] === target ? value['id'] : value,
				hit =
					typeof id === 'string'
						? (pre.get(k(target, id)) ?? created.get(k(target, id)))
						: undefined;
			return hit === undefined ? [] : [hit];
		}
	};
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
	// 4. the records the batch names exist, belong where it names them and are readable (rules 13, 36)
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
	// 5. the caller's write arms admit every column the batch writes, per path, before any guest code (rule 35)
	const admitted = auth.admin ? undefined : admit(cat, auth, r.model, f.items, pre);
	if (admitted !== undefined && 'kind' in admitted) return none(admitted);
	// Observed revisions are checked before transformations run.
	for (const it of f.items) {
		const c = it.change,
			named =
				c.op === 'upsert' &&
				c.on.length === 1 &&
				c.on[0] === 'id' &&
				typeof c.values['id'] === 'string'
					? c.values['id']
					: c.id;
		const row = pre.get(k(c.model, named));
		if (row === undefined) continue;
		const seen =
			c.op === 'update' || c.op === 'delete' ? (c.revision ?? r.observed?.[c.id] ?? null) : null;
		if (seen !== null && seen !== row['revision'])
			return none({
				kind: 'conflict',
				records: [{ model: c.model, id: c.id }]
			});
	}
	// 6–9, replayed once on a serialization failure with the same clock and minted ids (rule 26)
	const common = {
		key,
		digest,
		issuedAt: r.issuedAt,
		rate: r.rate ?? [],
		...(r.restored === undefined ? {} : { restored: [{ model: r.model, ...r.restored }] })
	};
	const record = Effect.fnUntraced(function* (outcome: Outcome) {
		yield* take(
			'warn',
			'act.refused',
			outcome.kind === 'refused'
				? { code: outcome.code, message: outcome.message }
				: { code: outcome.kind }
		);
		const value = yield* Schema.decodeUnknownEffect(Schema.Json)(outcome).pipe(
			Effect.mapError((error) => BoltError.make('bad_answer', 'commit', error.message, error))
		);
		const res = yield* e.db.returning(
			Schema.Struct({ outcome: Schema.NullOr(OutcomeSchema) }),
			compile_outcome_record(common, value)
		);
		return none(res[0]?.outcome ?? (yield* stored()) ?? outcome);
	});
	return yield* replayOnce(
		Effect.fnUntraced(function* (
			replay: (
				settle: Effect.Effect<ActResult, EngineError>
			) => Effect.Effect<never, SerializationReplay>
		) {
			const planned = yield* plan(
				e,
				r,
				env,
				f.items,
				pre,
				imp,
				byId ? upserted : undefined,
				own,
				visibility,
				admitted
			);
			if ('outcome' in planned)
				return planned.guest && sink === undefined
					? yield* record(planned.outcome)
					: none(planned.outcome);
			if (imp?.dry_run)
				return none(
					yield* dry_run(
						e.db,
						[yield* compileCommit(m, cat, { ...planned.commit, ...common })],
						planned.lock,
						yield* constraintIndex(m)
					)
				);
			if (sink !== undefined) {
				// hook:callables
				sink(planned);
				const records = planned.commit.writes.map((w) => ({
					model: w.model,
					id: w.id,
					revision: w.op === 'create' ? 1 : w.revision + 1
				}));
				const request =
					planned.commit.approval?.request_id ??
					(planned.commit.resubmit?.pending === true ? planned.commit.resubmit.request : undefined);
				return none(
					request === undefined
						? {
								kind: 'committed',
								output: planned.commit.output,
								records,
								...(planned.commit.unchanged === undefined
									? {}
									: { unchanged: planned.commit.unchanged })
							}
						: { kind: 'pending_approval', request_id: request, records }
				);
			}
			return yield* Effect.gen(function* () {
				yield* take('info', 'act.settled', { writes: planned.commit.writes.length });
				const rows = yield* executeCommit(
					e.db,
					m,
					cat,
					{ ...planned.commit, ...common },
					planned.lock
				);
				return yield* settleCommit(rows[0], stored, e.committed);
			}).pipe(
				Effect.catch((err) =>
					Effect.gen(function* () {
						const d = yield* decideError(err, yield* constraintIndex(m));
						if (d.replay && planned.guest)
							return yield* replay(d.record ? record(d.outcome) : Effect.succeed(none(d.outcome)));
						return d.record ? yield* record(d.outcome) : none(d.outcome);
					})
				)
			);
		})
	);
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
type Need = { readonly path: string; readonly field?: string; readonly row?: number };
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
		kind: Schema.Literal('deny'),
		message: Schema.String,
		at: Schema.optionalKey(
			Schema.Struct({
				row: Schema.optionalKey(Schema.Number),
				path: Schema.optionalKey(Schema.String),
				field: Schema.optionalKey(Schema.String)
			})
		)
	}),
	Schema.Struct({ kind: Schema.Literal('approve'), flow: Snapshot })
]);
export type Judgement =
	| { readonly kind: 'allow' }
	| { readonly kind: 'approve'; readonly flow: StepsSnapshot }
	| { readonly kind: 'deny'; readonly outcome: Outcome };
/**
 * Rule 35's guest half: each admitting arm's `verdict` judges the verb's batch (invocation kind `policy`, workspace reads
 * within a transform's budget). Any `allow` executes, an arm without a verdict among them; else the first `approve` in
 * the team's policy order holds the batch for its flow; else the first `deny` refuses it (its `row` indexes `input`).
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
			verdict: { kind: 'deny', outcome: refused('forbidden', 'You may not make this change.') }
		};
	if (arms.some((arm) => !arm.check)) return { guest: false, verdict: { kind: 'allow' } };
	const port = yield* guest_port(e.guest);
	let approve: Judgement | undefined, deny: Judgement | undefined;
	for (const arm of arms) {
		const target = `${arm.policy}.${model}.${verb}`;
		const invocation: Invocation = {
			id: `${seed}:policy:${target}`,
			kind: 'policy',
			target,
			input,
			ctx: { ...guest_context(auth.actor, b, seed), policies: auth.policies },
			budget: { crossings: LIMITS.crossings.write, readBytes: LIMITS.readBytes }
		};
		const bridge = e.bridge?.(invocation, db) ?? transformBridge(e.manifest, db, invocation);
		const g = yield* port.invoke(invocation, bridge);
		for (const table of bridge.tables?.() ?? []) reads?.tables.add(table);
		reads?.fingerprints.push(...(bridge.fingerprints?.() ?? []));
		if (g.kind === 'failed')
			return { guest: true, verdict: { kind: 'deny', outcome: yield* guestFailure(g.error) } };
		if (g.kind === 'refused')
			return {
				guest: true,
				verdict: {
					kind: 'deny',
					outcome: { kind: 'refused', code: 'refused', message: g.message, rule: target }
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
			deny ??= {
				kind: 'deny',
				outcome: {
					kind: 'refused',
					code: 'refused',
					message: data.message,
					rule: target,
					...data.at
				}
			};
	}
	return {
		guest: true,
		verdict: approve ??
			deny ?? { kind: 'deny', outcome: refused('forbidden', 'You may not make this change.') }
	};
});
/** A write callback's stored tree: each declared child layer, refusing a list beyond the native bound. */
const treeSelect = (
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
const writeTree = (cat: Catalog, model: string, row: RowData | null): RowData | null => row === null ? null : Object.fromEntries(
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
};
/**
 * Reads raw rows and, with a caller `scope`, which of them its native read scope admits, in one composed statement, keyed
 * `model␀id`: a row any output the caller holds admits. Only a model the caller reads is checked; any other row is not
 * readable.
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
	const res = yield* read_composed(db, [
		...grouped.map(([t, targets]) =>
			composable({
				text: `SELECT ${storedRowSql(cat, t, 't')} AS j FROM ${q(t)} t JOIN jsonb_populate_recordset(${null_row_sql(t, cat.models.get(t)?.fields.keys() ?? [])}, $1::jsonb) r ON t.id = r.id`,
				params: [
					JSON.stringify([...new Set(targets.map(([, id]) => id))].map((id) => ({ id })))
				]
			})
		),
		...(yield* Effect.forEach(checks, (table) => {
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
		}))
	]);
	for (const [index, table] of checks.entries())
		for (const row of res[tables.length + index]?.rows ?? []) {
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
	env: EvalEnv;
	submitted: readonly Item[];
	pre: Map<string, RowData>;
	imp: ImportPlan | undefined;
	own: TenantDb;
	visibility: Map<string, boolean>;
	admitted: Admitted | undefined;
};
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
type RoutedPlan = { guest: boolean; approval: Commit['approval']; resubmit: Commit['resubmit'] };

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
	const { e, r, own, pre, env } = context, m = e.manifest, cat = env.cat;
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
	reads.readTables.add('bolt_approvals');
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
	const { e, r, pre, own, admitted } = context;
	const auth = r.authority, b = r.bindings;
	const { readTables, fingerprints } = reads;
	let guest = false, flow: StepsSnapshot | undefined;
	// 6. each admitting arm's verdict judges its verb's batch as submitted, before any transform (rule 35); a requester's
	// save of their own request in ChangesRequested is judged against its checkpoint when it resubmits (step 8) instead
	if (admitted !== undefined) {
		const checked = Object.values(admitted).some((arms) => arms?.some((arm) => arm.check) === true);
		const saving = new Set(
			(checked
				? yield* holders(
						own,
						items.flatMap((item) =>
							item.parent === undefined && pre.has(k(item.change.model, named(item.change)))
								? [[item.change.model, named(item.change)] as const]
								: []
						),
						auth.actor
					)
				: []
			)
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
			if (verdict.kind === 'deny') {
				const o = verdict.outcome;
				if (o.kind !== 'refused' || o.row === undefined) return { guest, outcome: o };
				// a deny's row indexes the check's batch; the act's refusal names the input row
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
	const { identities, importRows, upsertOutput } = state, { sync } = modeContext(r.mode);
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
	const { e, r, env, pre, own } = context;
	const m = e.manifest, auth = r.authority, b = r.bindings, cat = env.cat;
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
		const groups = Map.groupBy(
			items.filter((item) => changeDepth(item) === level),
			(item) => canonical([item.change.model, item.change.op])
		);
		for (const roots of groups.values()) {
			const first = roots[0];
			if (first === undefined || first.change.op === 'upsert' || first.change.op === 'delete') continue;
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
				const carriedBy =
					from.includes(CARRIED) || from.includes(APPROVED)
						? r.model
						: r.mode._tag === 'Record'
							? r.mode.carriedBy
							: undefined;
				const invocation: Invocation = {
					id: seed,
					kind: verb,
					target: model,
					input,
					ctx: {
						...guest_context(auth.actor, b, seed),
						policies: auth.policies,
						admin: auth.admin,
						...(carriedBy === undefined ? {} : { carriedBy })
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
				// rows of other models this write carries sit one level down: their own callbacks run next, in this commit
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
				const replacedPaths = new Set(
					chunk.map((item) => canonical(item.change.path))
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
	// sys_integration's transform is the engine's: it reads the manifest's definitions and the tenant's envoys
	if (r.model === 'sys_integration') {
		const [envoys] = yield* e.db.read([
			{ text: 'SELECT id FROM sys_envoy WHERE active', params: [] }
		]);
		const runtimeEnvoys = new Set(
			(envoys?.rows ?? []).flatMap((row) => (typeof row['id'] === 'string' ? [row['id']] : []))
		);
		const t = instanceTransform(m, items, (id) => pre.get(k(r.model, id)), runtimeEnvoys);
		if ('kind' in t) return { guest: false, outcome: t };
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
	const { e, r, env, pre } = context;
	const m = e.manifest, auth = r.authority, b = r.bindings, cat = env.cat;
	const { imp } = context, { items } = prepared, { sync } = modeContext(r.mode);
	const stop = (outcome: Outcome): StoppedPlan => ({ guest: prepared.guest, outcome });
	// 7. upsert resolution read, defaults (rule 23a), model rules (rules 34, 40, 41), no-op updates (rule 29)
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
			const state = stateField(m, c.model);
			const stateKind = state === undefined ? undefined : m.models[c.model]?.fields[state];
			const initial = stateKind?.kind === 'state' ? stateKind.initial : undefined;
			if (state !== undefined && values[state] !== initial)
				return stop(
					refused('invalid_input', `A new record starts in '${initial}'.`, [...c.path, state])
				);
			writes.push({
				write: { model: c.model, id: c.id, op: 'create', values },
				item: it
			});
		} else {
			const row = pre.get(k(c.model, c.id));
			if (row === undefined) return stop(missing_record(c.path));
			if (c.op === 'delete') {
				const locked = yield* modelLock(env, m, c.model, row);
				if (locked !== null) return stop(refused('locked', locked.message, c.path));
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
			// an update that changes nothing is no write: restating a locked row (an unchanged re-import) is no refusal
			const locked = Object.keys(set).length === 0 ? null : yield* modelRules(env, m, c.model, row, set, Object.keys(stamps));
			if (locked !== null)
				return stop(refused(locked.code, locked.message, [...c.path, locked.field])); // hook:envoys, hook:integrations
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
	// §3.3.2: every custom field value the act writes passes its kind's `validate`
	const invalid = yield* validateCustom(e, r, writes);
	if (invalid !== null) return stop(invalid);
	return { writes, unchanged, report };
});

/** A resubmission compares the request's own checkpoint with the final proposal, including held child changes. */
const reviewChange = Effect.fn('Bolt.reviewChange')(function* (
	context: PlanInput,
	request: { readonly id: string; readonly model: string; readonly record: string; readonly action: Judged },
	writes: readonly DraftWrite[],
	reads: Pick<PreparedPlan, 'readTables' | 'fingerprints'>
): Effect.fn.Return<{ change: { before: RowData | null; set: RowData; after: RowData | null }; needs: Need[] }, EngineError> {
	const { e, r, env } = context, m = e.manifest, cat = env.cat;
	const recorded = fingerprinting(context.own), own = recorded.db;
	const columns: Readonly<Record<string, readonly string[]>> = request.action === 'delete' ? {} : m.exposures[request.model]?.[request.action]?.columns ?? {};
	const targets = new Map([[request.model, request.model]]);
	for (const path of Object.keys(columns).sort()) {
		let parentPath = request.model, model = request.model;
		for (const rel of path.slice(request.model.length + 1).split('.').filter(Boolean)) {
			const edge = cat.models.get(model)?.many.get(rel);
			if (edge === undefined) return yield* BoltError.make('invalid_spec', 'admission', `The review tree has no ${parentPath}.${rel} relationship.`);
			model = edge.child;
			parentPath += `.${rel}`;
			targets.set(parentPath, model);
		}
	}
	const records = yield* own.rows(Schema.Struct({ model: Schema.String, id: Schema.String, before: Schema.NullOr(Schema.Int) }), {
		text: `SELECT entry.collection AS model, entry.id, entry.before FROM bolt_approvals a,
		jsonb_to_recordset(a.records) AS entry(collection text,id text,before int) WHERE a.id=$1::uuid`,
		params: [request.id]
	});
	if (!records.some((record) => record.model === request.model && record.id === request.record))
		return yield* BoltError.make('conflict', 'admission', 'The approval checkpoint is missing; its records remain held.');
	const saved = new Map<string, RowData | null>();
	for (const record of records) {
		if (![...targets.values()].includes(record.model)) continue;
		if (record.before === null) { saved.set(k(record.model, record.id), null); continue; }
		const value = yield* read_history(own, m, {
			kind: 'history', model: record.model, id: record.id,
			at: { _tag: 'Before', before: request.id }, view: true
		}, { as: 'workspace' }, r.bindings);
		if (value === null) return yield* BoltError.make('conflict', 'admission', 'An approval checkpoint is missing; its records remain held.');
		const snapshot = yield* Schema.decodeUnknownEffect(HistorySnapshotSchema)(value).pipe(
			Effect.mapError((error) => BoltError.make('schema', 'decode', error.message))
		);
		const row = snapshot.compatible;
		for (const field of cat.models.get(record.model)?.fields.values() ?? [])
			if (!field.computed && !field.derived && !['seq', 'sum', 'count'].includes(field.kind) && !field.name.startsWith('bolt_') && !Object.hasOwn(row, field.name))
				return yield* BoltError.make('conflict', 'admission', `The approval checkpoint cannot supply ${record.model}.${field.name}; its records remain held.`);
		saved.set(k(record.model, record.id), row);
	}
	const live = new Map<string, RowData | null>();
	const paths = [...targets.keys()];
	for (const [path, model] of targets) {
		const ids = [...new Set([
			...(path === request.model ? [request.record] : []),
			...records.filter((record) => record.model === model).map((record) => record.id),
			...writes.filter(({ write }) => write.model === model).map(({ write }) => write.id)
		])];
		const rows = yield* wireRows(own, cat, model, ids, r.bindings, treeSelect(cat, paths, path, model));
		for (const [index, id] of ids.entries()) live.set(k(path, id), rows[index] ?? null);
	}
	for (const table of [...targets.values(), 'bolt_approvals', 'bolt_history', 'bolt_history_schema', 'bolt_history_current', 'bolt_audit_erase']) reads.readTables.add(table);
	reads.fingerprints.push(...recorded.fingerprints());
	const drafted = Map.groupBy(writes, ({ write }) => k(write.model, write.id));
	const rowList = (value: Json | undefined, path: string): readonly RowData[] => {
		if (!jsonArray(value)) throw BoltError.make('internal', 'decode', `The stored review tree is missing ${path}.`);
		if (value.length > LIMITS.page.max) throw BoltError.make('too_large', 'admission', `The stored ${path} exceeds the review tree limit.`);
		return value.map((row) => {
			if (!Predicate.isObject(row) || typeof row['id'] !== 'string') throw BoltError.make('internal', 'decode', `The stored review tree has an invalid ${path} row.`);
			return row;
		});
	};
	const tree = (side: 'before' | 'after', path: string, model: string, id: string, fallback: RowData | null): RowData | null => {
		const current = live.has(k(path, id)) ? live.get(k(path, id)) ?? null : fallback, key = k(model, id);
		let row = side === 'before' && saved.has(key) ? saved.get(key) ?? null : current;
		if (side === 'after')
			for (const { write } of drafted.get(key) ?? [])
				row = write.op === 'delete' ? null : write.op === 'create' ? { ...write.values, id } : row === null ? null : { ...row, ...write.set };
		if (row === null) return null;
		const answer: Record<string, Json> = { ...row };
		if (side === 'after')
			for (const field of cat.models.get(model)?.fields.values() ?? [])
				if (field.computed || field.derived || field.kind === 'sum' || field.kind === 'count') delete answer[field.name];
		for (const [rel, edge] of cat.models.get(model)?.many ?? []) {
			const childPath = `${path}.${rel}`;
			if (!targets.has(childPath)) continue;
			const candidates = new Map<string, RowData>();
			for (const child of current === null ? [] : rowList(current[rel], childPath)) candidates.set(String(child['id']), child);
			for (const record of records) {
				if (record.model !== edge.child) continue;
				const old = saved.get(k(edge.child, record.id));
				const present = live.get(k(childPath, record.id));
				if (old?.[edge.column] === id || present?.[edge.column] === id) candidates.set(record.id, present ?? old ?? { id: record.id });
			}
			for (const { write } of writes)
				if (write.model === edge.child && write.op !== 'delete' && (write.op === 'create' ? write.values : write.set)[edge.column] === id)
					candidates.set(write.id, live.get(k(childPath, write.id)) ?? { id: write.id });
			const children: RowData[] = [];
			for (const [childId, child] of candidates) {
				const next = tree(side, childPath, edge.child, childId, child);
				if (next?.[edge.column] === id) children.push(next);
			}
			if (children.length > LIMITS.page.max) throw BoltError.make('too_large', 'admission', `The approval's ${childPath} exceeds the review tree limit.`);
			answer[rel] = children;
		}
		return answer;
	};
	const targetOf = (row: RowData): RowData => {
		if (typeof row['id'] !== 'string' || typeof row['revision'] !== 'number') throw BoltError.make('conflict', 'admission', 'An approval child has no stored revision; its records remain held.');
		return { id: row['id'], revision: row['revision'] };
	};
	const needs: Need[] = [];
	const inputTree = (path: string, model: string, before: RowData | null, after: RowData, create: boolean): RowData => {
		const values: Record<string, Json> = {};
		const at = path.lastIndexOf('.');
		const parent = at < 0 ? undefined : targets.get(path.slice(0, at));
		const fixed = parent === undefined ? undefined : cat.models.get(parent)?.many.get(path.slice(at + 1))?.column;
		for (const field of columns[path] ?? []) {
			if (field === fixed) continue;
			const value = after[field];
			if (value !== undefined && (create || Object.hasOwn(storedChanges(cat, model, before ?? {}, { [field]: value }), field))) {
				values[field] = value;
				needs.push({ path, field });
			}
		}
		for (const [rel, edge] of cat.models.get(model)?.many ?? []) {
			const childPath = `${path}.${rel}`;
			if (!targets.has(childPath)) continue;
			const previous = new Map((before === null ? [] : rowList(before[rel], childPath)).map((row) => [String(row['id']), row]));
			const next = new Map(rowList(after[rel], childPath).map((row) => [String(row['id']), row]));
			const owned = m.relationships[`${edge.child}.${edge.column}`]?.owned === true;
			const groups: Record<string, Json[]> = {};
			const add = (action: string, value: Json) => { (groups[action] ??= []).push(value); };
			for (const [id, row] of next) {
				const old = previous.get(id);
				if (old === undefined) {
					const key = k(edge.child, id);
					const checkpoint = saved.has(key) ? saved.get(key) : live.get(k(childPath, id));
					if (!owned && checkpoint != null) {
						add('link', targetOf(checkpoint));
						if (!create) {
							const baseline = tree('before', childPath, edge.child, id, checkpoint) ?? checkpoint;
							const set = inputTree(childPath, edge.child, baseline, row, false);
							if (Object.keys(set).length > 0) add('update', { target: targetOf(checkpoint), set });
						}
					}
					else add('create', inputTree(childPath, edge.child, null, row, true));
				} else if (!create) {
					const set = inputTree(childPath, edge.child, old, row, false);
					if (Object.keys(set).length > 0) add('update', { target: targetOf(old), set });
				}
			}
			for (const [id, row] of previous)
				if (!next.has(id)) add(owned || live.get(k(childPath, id)) === null ? 'delete' : 'unlink', targetOf(row));
			if (Object.keys(groups).length > 0) {
				values[rel] = create ? Object.values(groups).flat() : groups;
				needs.push({ path: childPath });
			}
		}
		return values;
	};
	return yield* Effect.try({
		try: () => {
			const before = request.action === 'create' ? null : tree('before', request.model, request.model, request.record, null);
			const after = request.action === 'delete' ? null : tree('after', request.model, request.model, request.record, null);
			return { change: { before: writeTree(cat, request.model, before), after: writeTree(cat, request.model, after), set: after === null ? {} : inputTree(request.model, request.model, before, after, request.action === 'create') }, needs };
		},
		catch: (error) => error instanceof BoltError ? error : BoltError.make('internal', 'decode', String(error))
	});
});

const routeChanges = Effect.fn('Bolt.routeChanges')(function* (
	context: PlanInput, prepared: PreparedPlan, draft: DraftPlan
): Effect.fn.Return<RoutedPlan | StoppedPlan, EngineError> {
	const { e, r, env, pre, own } = context;
	const m = e.manifest, auth = r.authority, b = r.bindings, cat = env.cat;
	const { submitted } = context, { flow, readTables, fingerprints } = prepared, { writes } = draft;
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
	const fresh = new Set(
		writes.filter(({ write }) => write.op === 'create').map(({ write }) => k(write.model, write.id))
	);
	const held = yield* holders(
		own,
		checked.flatMap(({ write }): (readonly [string, string])[] => [
			...(write.op === 'create' ? [] : [[write.model, write.id] as const]),
			...[...(cat.models.get(write.model)?.one ?? [])].flatMap(([fk, one]) => {
				const parent =
					write.op === 'create' ? write.values[fk] : pre.get(k(write.model, write.id))?.[fk];
				const target = one.targets[0];
				return m.relationships[`${write.model}.${fk}`]?.owned &&
					target !== undefined &&
					typeof parent === 'string' &&
					!fresh.has(k(target, parent))
					? [[target, parent] as const]
					: [];
			})
		]),
		auth.actor
	);
	// a change to a held record joins its request: what it carries `on_approved` waits for the approving decision too
	if (held.length > 0)
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
		const reviewed = yield* reviewChange(context, request, writes, { readTables, fingerprints }).pipe(
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
		if (judged.verdict.kind === 'deny') return stop(judged.verdict.outcome);
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
	return { guest, approval, resubmit };
});

const indexChanges = Effect.fn('Bolt.indexChanges')(function* (
	context: PlanInput, writes: readonly DraftWrite[], initialGuest: boolean
): Effect.fn.Return<boolean | StoppedPlan, EngineError> {
	const { e, r, pre } = context, m = e.manifest, auth = r.authority, b = r.bindings;
	let guest = initialGuest;
	const stop = (outcome: Outcome): StoppedPlan => ({ guest, outcome });
	// Pure search vectors are evaluated in bounded batches and join the same native row writes.
	for (const [model, entries] of Map.groupBy(
		writes.filter(({ write }) => write.op !== 'delete'),
		({ write }) => write.model
	)) {
		for (const [name, index] of Object.entries(m.models[model]?.search?.indexes ?? {})) {
			if (index.field !== undefined) continue;
			const port = yield* guest_port(e.guest);
			for (let offset = 0; offset < entries.length; offset += LIMITS.writeChunk) {
				const chunk = entries.slice(offset, offset + LIMITS.writeChunk);
				const g = yield* pureVectors(
					port,
					model,
					name,
					index.dim,
					chunk.map(({ write }) => ({
						...pre.get(k(model, write.id)),
						...(write.op === 'create' ? write.values : write.op === 'update' ? write.set : {}),
						id: write.id
					})),
					guest_context(auth.actor, b, `${r.invocationId}:vector:${model}:${name}:${offset / LIMITS.writeChunk}`)
				);
				guest = true;
				if ('failed' in g) return stop(yield* guestFailure(g.failed));
				const vectors = g.vectors;
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
		}
	}
	return guest;
});

const plan = Effect.fn('Bolt.plan')(function* (
	e: WriteEngine,
	r: ActRequest,
	env: EvalEnv,
	submitted: readonly Item[],
	pre: Map<string, RowData>,
	imp?: ImportPlan,
	upserted?: (string | null)[],
	own: TenantDb = e.db,
	visibility: Map<string, boolean> = new Map<string, boolean>(),
	admitted?: Admitted
): Effect.fn.Return<Planned, EngineError> {
	const context: PlanInput = { e, r, env, submitted, pre, imp, own, visibility, admitted };
	const prepared = yield* prepareChanges(context);
	if ('outcome' in prepared) return prepared;
	const draft = yield* materializeChanges(context, prepared);
	if ('outcome' in draft) return draft;
	const routed = yield* routeChanges(context, prepared, draft);
	if ('outcome' in routed) return routed;
	const indexed = yield* indexChanges(context, draft.writes, routed.guest);
	if (typeof indexed !== 'boolean') return indexed;
	const guest = indexed, m = e.manifest, auth = r.authority, b = r.bindings, cat = env.cat;
	const { writes, unchanged, report } = draft, { approval, resubmit } = routed;
	const { importRows, upsertOutput, readTables, fingerprints } = prepared, { sync } = modeContext(r.mode);
	const resolvedImportIndices = new Set(importRows.map((row) => row.index));
	const stop = (outcome: Outcome): StoppedPlan => ({ guest, outcome });
	const embed = embedWrites(
		m,
		writes.map((w) => w.write)
	); // hook:integrations — rule 16: stale embeddings null, `bolt.embed` queued
	const plain = embed.writes;
	const queued = embed.stale
		? [embedQueued(minter(`${r.invocationId}:embed`, b.now)(), b.now)]
		: []; // hook:integrations
	if (utf8Bytes(JSON.stringify(plain)) > LIMITS.changeSetBytes)
		return stop(refused('overflow', 'The change is too large for one act.'));
	const priorGuards = r.mode._tag === 'Record' ? undefined : r.readGuards;
	const tables = [
		...new Set([...plain.map((w) => w.model), ...readTables, ...(priorGuards?.tables ?? [])])
	].sort();
	return {
		guest,
		commit: {
			now: b.now,
			today: b.today,
			actor: auth.actor,
			writer: writerOf(r.authority),
			writes: plain,
			owned: yield* ownedLocks(
				m,
				cat,
				writes.map((w) => w.write),
				pre
			),
			runs: queued,
			notices: [],
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
			...(guest && fingerprints.length > 0 ? { fingerprints } : {}),
			...(priorGuards === undefined ? {} : { readGuards: priorGuards }),
			...(sync === undefined ? {} : { pieces: sync.pieces })
		},
		...(priorGuards !== undefined || (guest && readTables.size > 0)
			? { lock: { tables, mode: 'SHARE ROW EXCLUSIVE' as const } }
			: {})
	};
});
/** Read-only syncs own their model; caller updates are limited to its declared local columns. */
function readOnlySync(m: EngineManifest, model: string): string | undefined {
	return Object.entries(m.exposures[model]?.syncs ?? {}).find(
		([, sync]) => sync.with !== 'file' && sync.read === true && sync.write !== true
	)?.[0];
}
function syncOwnership(m: EngineManifest, r: ActRequest, items: readonly Item[]): Outcome | null {
	const { sync } = modeContext(r.mode);
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
export const hasCallback = (m: EngineManifest, model: string, verb: 'create' | 'update'): boolean =>
	m.exposures[model]?.[verb]?.transform === true;
/** Without fields this checks deletion. An update checks only the fields it changes. */
const modelLock = Effect.fnUntraced(function* (
	env: EvalEnv,
	m: EngineManifest,
	model: string,
	row: RowData,
	fields?: readonly string[]
): Effect.fn.Return<{ code: 'locked'; message: string; field: string } | null, BoltError> {
	for (const { where, except } of Object.values(m.models[model]?.locks ?? {})) {
		const field =
			fields === undefined || (except?.length ?? 0) === 0
				? 'id'
				: fields.find((name) => !except?.includes(name));
		if (field !== undefined && evaluate(env, model, yield* toPred(m, model, where), row))
			return { code: 'locked', message: 'This record is locked and cannot be changed.', field };
	}
	return null;
});
/** Rules 34, 40, 41 on an update's changed fields: `to` edges, state constraints, and an owned child's fixed parent key. */
const modelRules = Effect.fnUntraced(function* (
	env: EvalEnv,
	m: EngineManifest,
	model: string,
	row: RowData,
	set: RowData,
	generated: readonly string[] = []
): Effect.fn.Return<{
	code: RefusalCode;
	message: string;
	field: string;
} | null, BoltError> {
	const locked = yield* modelLock(env, m, model, row, Object.keys(set).filter((field) => !generated.includes(field)));
	if (locked !== null) return locked;
	for (const [field, kind] of Object.entries(m.models[model]?.fields ?? {}))
		if (kind.kind === 'enum' && kind.transitions !== undefined && set[field] !== undefined) {
			const from = String(row[field] ?? ''),
				next = String(set[field]);
			if (from !== next && !(kind.transitions[from] ?? []).includes(next))
				return {
					code: 'invalid_input',
					message: `'${from}' cannot move to '${next}'.`,
					field
				};
		}
	for (const fk of Object.keys(set))
		if (m.relationships[`${model}.${fk}`]?.owned)
			return {
				code: 'invalid_input',
				message: 'An owned record never changes its parent.',
				field: fk
			};
	const state = stateField(m, model);
	if (state === undefined) return null;
	const kind = m.models[model]?.fields[state];
	if (kind?.kind !== 'state') return null;
	const spec = kind.states;
	const from = String(row[state]);
	const next = set[state];
	if (next !== undefined && !(spec[from]?.to ?? []).includes(String(next)))
		return {
			code: 'invalid_input',
			message: `'${from}' cannot move to '${String(next)}'.`,
			field: state
		};
	return null;
});
/** Owned child writes re-test the parent's constraint predicates under FOR SHARE. */
export const ownedLocks = Effect.fnUntraced(function* (
	m: EngineManifest,
	cat: Catalog,
	writes: readonly Write[],
	pre: Map<string, RowData>
): Effect.fn.Return<OwnedLock[], BoltError> {
	const created = new Set(writes.filter((write) => write.op === 'create').map((write) => k(write.model, write.id)));
	const locks = new Map<string, { child: string; parent: string; where: Pred; ids: Set<string> }>();
	for (const write of writes)
		for (const [fk, one] of cat.models.get(write.model)?.one ?? []) {
			const relation = m.relationships[`${write.model}.${fk}`];
			const parent = one.targets[0];
			if (!relation?.owned || relation.inverse === undefined || parent === undefined) continue;
			const id = write.op === 'create' ? write.values[fk] : pre.get(k(write.model, write.id))?.[fk];
			if (typeof id !== 'string' || created.has(k(parent, id))) continue;
			const blocked = Object.values(m.models[parent]?.locks ?? {}).filter((rule) =>
				!rule.except?.includes(relation.inverse ?? '')
			);
			if (blocked.length === 0) continue;
			const key = `${parent}.${relation.inverse}`;
			const lock = locks.get(key) ?? {
				child: write.model, parent,
				where: { t: 'not' as const, of: { t: 'or' as const, of: yield* Effect.forEach(blocked, (rule) => toPred(m, parent, rule.where)) } },
				ids: new Set<string>()
			};
			lock.ids.add(id);
			locks.set(key, lock);
		}
	return [...locks.values()].map((lock) => ({ ...lock, ids: [...lock.ids] }));
});
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
type Probe = Pick<WriteEngine, 'manifest' | 'db' | 'guest' | 'bridge'>;
/**
 * What a write's verdict answers for an unchanged stored record: the same before/set/after envelope as an act.
 * Without a guest no verdict can run, so a guarded verb reads as denied (the act judges for real).
 */
const opened = Effect.fn('Bolt.opened')(function* (
	e: Probe,
	authority: Authority,
	bindings: Bindings,
	model: string,
	verb: 'update' | 'delete',
	id: string
): Effect.fn.Return<Judgement['kind'], EngineError> {
	if (authority.admin) return 'allow';
	const arms = authority.models[model]?.[verb] ?? [];
	if (arms.length === 0) return 'deny';
	if (arms.some((arm) => !arm.check)) return 'allow';
	if (e.guest === undefined) return 'deny';
	const cat = catalog_of(e.manifest);
	const [before] =
		verb === 'update'
			? yield* storedTrees(e.db, e.manifest, cat, model, [id], bindings)
			: yield* wireRows(e.db, cat, model, [id], bindings);
	if (before === null || before === undefined) return 'deny';
	const { verdict } = yield* judge(
		e,
		e.db,
		authority,
		bindings,
		`open:${model}:${id}`,
		model,
		verb,
		arms,
		[{ before, set: {}, after: verb === 'update' ? before : null }]
	);
	return verdict.kind;
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
		(yield* opened({ ...e, manifest: m }, authority, bindings, model, 'update', id)) === 'allow'
	);
});
/**
 * Current-row advice from the act's own admission: the columns the caller's update arms name at the record's write path,
 * its checks' verdict on the unchanged record (allow: writable; approve: a proposal), and the model rules. A child opened
 * under its parent is edited through the parent's access point: the parent's permission on that relation gates it.
 */
export const record_capabilities = Effect.fn('Bolt.recordCapabilities')(function* (
	e: Probe,
	model: string,
	id: string,
	authority: Authority,
	bindings: Bindings,
	readable: (model: string, id: string) => Effect.Effect<RowData | null, EngineError>,
	parent?: RecordParentContext
): Effect.fn.Return<RecordCapabilities | null, EngineError> {
	const m = Object.hasOwn(SYSTEM.exposures, model) ? layered(e.manifest) : e.manifest,
		spec = m.exposures[model],
		stored = m.models[model];
	if (stored === undefined || (spec === undefined && parent === undefined)) return null;
	const visible = yield* readable(model, id);
	if (visible === null) return null;
	const cat = catalog_of(m),
		pre = yield* readRows(e.db, cat, [[model, id]]);
	const row = pre.get(k(model, id));
	// the stored row must be the revision the caller just read: a change between them may move it out of scope
	if (
		row === undefined ||
		typeof row['revision'] !== 'number' ||
		visible['revision'] !== row['revision']
	)
		return null;
	const probe = { ...e, manifest: m };
	// the write path the record's fields sit at, and the root whose arms and checks judge it
	let path = model,
		owner = model,
		gate: Judgement['kind'],
		parentReasons: readonly RecordRestriction[] = [],
		fk: string | undefined,
		freeLink = false,
		unlink = false,
		deleteDeclared = spec?.delete !== undefined;
	if (parent !== undefined) {
		const relation = cat.models.get(parent.model)?.many.get(parent.relation);
		if (relation?.child !== model) return null;
		const parentCaps = yield* record_capabilities(
			e,
			parent.model,
			parent.id,
			authority,
			bindings,
			readable
		);
		if (parentCaps === null || parentCaps.revision !== parent.revision) return null;
		const permission = parentCaps.fields[parent.relation];
		if (permission === undefined) return null;
		path = `${parent.model}.${parent.relation}`;
		// the child is read through the root's layer: that layer's scope in any output the caller holds (absent =
		// unscoped), never the child's own grant
		const predicates = readPredicates(authority, path);
		if (predicates !== undefined && predicates.length > 0) {
			const statement = yield* grant_sql(
				cat,
				model,
				{
					t: 'and',
					of: [
						{ t: 'cmp', field: 'id', op: 'eq', arg: { _tag: 'Lit', value: id } },
						{ t: 'cmp', field: 'revision', op: 'eq', arg: { _tag: 'Lit', value: row['revision'] } },
						{ t: 'or', of: predicates }
					]
				},
				{ resolve: resolverOf(bindings, authority), tz: bindings.tz }
			).pipe(Effect.mapError(from_store));
			const [admitted] = yield* e.db.read([statement]);
			if (!admitted?.rows.length) return null;
		}
		owner = parent.model;
		fk = relation.column;
		const relationship = m.relationships[`${model}.${fk}`];
		freeLink = row[fk] == null && relationship?.owned !== true;
		if (row[fk] !== parent.id && !freeLink) return null;
		unlink = relationship?.owned !== true && relationship?.optional === true;
		gate = permission.writable ? 'allow' : permission.proposal ? 'approve' : 'deny';
		parentReasons = permission.reasons.filter((reason) => reason !== 'no_grant');
		deleteDeclared = !freeLink;
	} else
		gate =
			spec?.update === undefined
				? 'deny'
				: yield* opened(probe, authority, bindings, model, 'update', id);
	const declared = m.exposures[owner]?.update?.columns ?? {};
	const arms = authority.models[owner]?.update ?? [];
	const covered = (at: string, field?: string) =>
		Object.hasOwn(declared, at) &&
		(authority.admin ||
			arms.some(
				(arm) =>
					Object.hasOwn(arm.columns, at) &&
					(field === undefined || (arm.columns[at]?.includes(field) ?? false))
			));
	const granted = (field: string) =>
		freeLink
			? field === fk && covered(path)
			: field === fk
				? unlink && covered(path)
				: (declared[path]?.includes(field) ?? false) && covered(path, field);
	const restrictions: RecordRestriction[] = [];
	const locks = yield* ownedLocks(
		m,
		cat,
		[{ model, id, op: 'update', set: {}, revision: row['revision'] }],
		pre
	);
	const parents = locks.flatMap((lock) => lock.ids.map((parent) => [lock.parent, parent] as const));
	for (const [key, value] of yield* readRows(e.db, cat, parents)) pre.set(key, value);
	if (
		locks.some((lock) =>
			lock.ids.some(
				(parent) => {
					const row = pre.get(k(lock.parent, parent));
					return row === undefined || !evaluate({ cat, bindings }, lock.parent, lock.where, row);
				}
			)
		)
	)
		restrictions.push('owned_parent_locked');
	// the approval lock (lock.ts): an open request holding this record, or its owned parent, that the caller may not change
	const owned: (readonly [string, string])[] = [[model, id]];
	for (const [fk, one] of cat.models.get(model)?.one ?? []) {
		const value = row[fk];
		if (!m.relationships[`${model}.${fk}`]?.owned || typeof value !== 'string') continue;
		const target = one.targets[0];
		if (target === undefined) return yield* BoltError.make('invalid_spec', 'admission', `The owned reference ${model}.${fk} has no target.`);
		owned.push([target, value]);
	}
	const holding = yield* holders(e.db, owned, authority.actor);
	if (holding.some((h) => !h.eligible || h.readGuarded)) restrictions.push('under_approval');
	const local = spec?.update?.columns[model] ?? [];
	const remote =
		readOnlySync(m, model) === undefined
			? []
			: Object.keys(stored.fields).filter((field) => !local.includes(field));
	const env: EvalEnv = {
		cat,
		bindings,
		authority,
			related: (model, relation, target, current) => {
			const descriptor = cat.models.get(model)?.fields.get(relation), link = descriptor === undefined ? current[relation] : storedField(descriptor, current);
			const key = Predicate.isObject(link) && link['model'] === target ? link['id'] : link,
				value = typeof key === 'string' ? pre.get(k(target, key)) : undefined;
			return value === undefined ? [] : [value];
		}
	};
	const state = stateField(m, model);
	const stateKind = state === undefined ? undefined : stored.fields[state];
	const transitions =
		stateKind?.kind === 'state' ? (stateKind.states[String(row[state ?? ''])]?.to ?? []) : [];
	const moves =
		state === undefined
			? []
			: transitions.filter((next) => admitMove(authority, model, state, String(row[state]), next));
	/** A field's or relation's advice: its own reasons, then the checks' verdict on the record. */
	const advise = (reasons: RecordRestriction[]) => ({
		writable: reasons.length === 0 && gate === 'allow',
		proposal: reasons.length === 0 && gate === 'approve',
		reasons: [...new Set(gate === 'allow' ? reasons : [...reasons, 'no_grant' as const])]
	});
	const fields: Record<string, ReturnType<typeof advise>> = {};
	for (const field of Object.keys(visible)) {
		if (
			stored.fields[field] === undefined &&
			stored.computed?.[field] === undefined &&
			m.relationships[`${model}.${field}`] === undefined
		)
			continue;
		const value = visible[field];
		const reasons = [...restrictions, ...parentReasons];
		if (!granted(field)) reasons.push('no_grant');
		if (remote.includes(field)) reasons.push('sync_owned');
		if (field !== fk && m.relationships[`${model}.${field}`]?.owned) reasons.push('owned_parent');
		if (field === state) {
			if ((yield* modelLock(env, m, model, row, [field])) !== null) reasons.push('state_locked');
			if (moves.length === 0) reasons.push(transitions.length === 0 ? 'state_locked' : 'no_grant');
		} else if ((yield* modelRules(env, m, model, row, { [field]: row[field] ?? null }))?.code === 'locked')
			reasons.push('state_locked');
		fields[field] = advise(reasons);
	}
	// the child layers declared under this path: each relation a change of the record may act on
	for (const at of Object.keys(declared)) {
		const relation = at.startsWith(`${path}.`) ? at.slice(path.length + 1) : '';
		if (relation === '' || relation.includes('.') || !cat.models.get(model)?.many.has(relation))
			continue;
		const reasons = [...restrictions, ...parentReasons];
		if (!covered(at)) reasons.push('no_grant');
		if ((yield* modelRules(env, m, model, row, { [relation]: null }))?.code === 'locked')
			reasons.push('state_locked');
		fields[relation] = advise(reasons);
	}
	const advice = Object.values(fields);
	const updateReasons = [...restrictions, ...parentReasons];
	if (!advice.some((field) => field.writable)) updateReasons.push('no_grant');
	const deleteGate =
		parent !== undefined
			? gate
			: deleteDeclared
				? yield* opened(probe, authority, bindings, model, 'delete', id)
				: 'deny';
	const deleteReasons = [...restrictions, ...parentReasons];
	if ((yield* modelLock(env, m, model, row)) !== null) deleteReasons.push('state_locked');
	if (!deleteDeclared || deleteGate !== 'allow') deleteReasons.push('no_grant');
	return {
		model,
		id,
		revision: row['revision'],
		fields,
		update: {
			allowed: updateReasons.length === 0,
			proposal: restrictions.length === 0 && advice.some((field) => field.proposal),
			reasons: [...new Set(updateReasons)]
		},
		delete: {
			allowed: deleteReasons.length === 0,
			proposal:
				deleteDeclared &&
				deleteGate === 'approve' &&
				deleteReasons.every((reason) => reason === 'no_grant'),
			reasons: [...new Set(deleteReasons)]
		},
		moves: state !== undefined && fields[state]?.writable ? { [state]: moves } : {},
		proposal_moves: state !== undefined && fields[state]?.proposal ? { [state]: transitions } : {}
	};
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
	for (const [of, values] of byKind) {
		const first = values[0];
		if (first === undefined) continue;
		const port = yield* guest_port(e.guest);
		const b = r.bindings;
		const g = yield* port.invoke(
			{
				id: `${r.invocationId}:validate:${of}`,
				kind: 'validation',
				target: of,
				input: values.map((x) => x.value),
				ctx: guest_context(r.authority.actor, b, r.invocationId),
				budget: {
					crossings: LIMITS.crossings.sync,
					readBytes: LIMITS.readBytes
				}
			},
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
		if (g.kind === 'failed') return yield* guestFailure(g.error);
		if (g.kind === 'refused') return refused('invalid_input', g.message, first.path);
		const out = yield* Schema.decodeUnknownEffect(Schema.Array(Schema.NullOr(Schema.String)))(g.output).pipe(
			Effect.mapError((error) => BoltError.make('bad_answer', 'guest', `${of}: ${error.message}`, error))
		);
		if (out.length !== values.length)
			return yield* BoltError.make('bad_answer', 'guest', `${of}: validation returns one answer per value.`);
		for (const [index, message] of out.entries()) {
			if (message === null) continue;
			const value = values[index];
			if (value === undefined)
				return yield* BoltError.make('bad_answer', 'guest', `${of}: validation named no input value.`);
			return refused('invalid_input', message, value.path);
		}
	}
	return null;
});
/**
 * One batch (at most `LIMITS.writeChunk` rows) of a pure search index's vectors, guest-evaluated: an act joins them into
 * its row writes, `bolt.index` backfills seeded rows with them. `failed` is the guest's failure, for the caller to map.
 */
export const pureVectors = Effect.fn('Bolt.pureVectors')(function* (
	guest: GuestPort,
	model: string,
	name: string,
	dim: number,
	rows: readonly RowData[],
	ctx: Invocation['ctx']
): Effect.fn.Return<
	{ readonly failed: BoltError } | { readonly vectors: readonly (readonly number[] | null)[] },
	EngineError
> {
	const g = yield* guest.invoke(
		{
			id: ctx.seed,
			kind: 'vector',
			target: `${model}.${name}`,
			input: rows,
			ctx,
			budget: { crossings: 0, readBytes: 0 }
		},
		{ cross: () => Effect.succeed([]) }
	);
	if (g.kind === 'failed') return { failed: g.error };
	if (g.kind === 'refused')
		return {
			failed: BoltError.make('internal', 'guest', 'A pure search vector cannot refuse a write.')
		};
	const vectors = yield* Schema.decodeUnknownEffect(
		Schema.Array(Schema.NullOr(Schema.Array(Schema.Number)))
	)(g.output).pipe(
		Effect.mapError((error) => BoltError.make('bad_answer', 'guest', error.message, error))
	);
	if (
		vectors.length !== rows.length ||
		vectors.some(
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
	return { vectors };
});

/**
 * Rules 42, 72: what a failed guest invocation answers. A throw from tenant code is `internal` (its message reaches
 * members only, rule 32); a budget keeps its own code; anything else is a platform fault, thrown with its cause (72a).
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
const dry_run = Effect.fn('Bolt.dry_run')(function* (
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

/** Workspace reads shared by direct writes and verbs recorded in an atomic batch (rules 15, 26). */
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

/** One activation's write service; every request chooses its mode before planning starts. */
export const WritesLive = Layer.effect(
	Writes,
	Effect.gen(function* () {
		const manifest = yield* Manifest;
		const db = yield* TenantDbService;
		const guest = yield* Guest;
		const telemetry = yield* Telemetry;
		const live = yield* Live;
		const wake = yield* Wake;
		const links = yield* Links;
		const audit = yield* Audit;
		const engine: WriteEngine = {
			manifest,
			db,
			guest,
			approval: approval_hook(manifest, db, live.publish),
			committed: (answer) =>
				committed(answer).pipe(
					Effect.provideService(Live, live),
					Effect.provideService(Wake, wake),
					Effect.provideService(Links, links)
				),
			bridge: (invocation, over = db) => transformBridge(manifest, over, invocation)
		};
		return {
			act: (request) =>
				Effect.scoped(
					Effect.gen(function* () {
						const log = yield* telemetry.open({ invocation: request.invocationId });
						const operation = yield* idempotency(engine, request, request.authority);
						const work = act({ ...engine, log }, request);
						const result = yield* request.mode._tag === 'Record'
							? work
							: audited(
									db,
									{
										category: 'write',
										action: `${request.model}.${request.verb}`,
										actor: auditActor(request.authority.actor),
										invocation: request.invocationId,
										outcomeKey: operation.key,
										digest: operation.digest,
										payload: encode_wire({
											input: request.input,
											observed: request.observed,
											on_conflict: request.on_conflict
										})
									},
									work
								);
						const v = yield* live.v;
						return { ...result, v };
					})
				).pipe(Effect.provideService(Audit, audit))
		};
	})
);

/** The path segments under which a write's carried rows sit, one level below the rows that carry them. */
const CARRIED = '$with',
	APPROVED = '$on_approved';
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
/** The callback returns its sets in input order, with optional carried writes in the same commit or on approval. */
export const answerOf = (
	verb: 'create' | 'update',
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
	if (whole !== undefined && Object.keys(whole).some((key) => !['sets', 'with', 'on_approved'].includes(key)))
		return 'a callback answer contains only sets, with and on_approved';
	const sets = whole === undefined ? output : (whole['sets'] ?? null);
	if (!Array.isArray(sets) || sets.length !== count)
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
	return { sets: sets.map((set) => writeFields(m, rootModel, set, verb)), ...groups };
	} catch (error) {
		return error instanceof BoltError ? error.message : String(error);
	}
};
