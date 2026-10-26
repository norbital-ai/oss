// The act pipeline (rule 19), in rule order: rate admission → decode → marked-retry lookup → the caller judged once on
// the submitted shape → observed-revision checks → batched per-verb callbacks → defaults and
// model rules → post-image scope and the approval route → one write statement (rule 20), or the outcome record.
import type { Json } from '../../decl/values.ts';
const jsonArray = (value: Json | undefined): value is readonly Json[] => Array.isArray(value);
import { encodeWire } from '@norbital-ai/std/wire';
import { inputSchema } from '@norbital-ai/std/kind';
import { audited, auditActor } from '../audit-operation.ts';
import { Audit } from '../audit.ts';
import type { ApprovalSnapshot } from '../../decl/access/policy.ts';
import { WriteOutcome as OutcomeSchema } from '../../protocol/schema.ts';
import type {
	RecordCapabilities,
	RecordRestriction,
	RecordParentContext
} from '../../protocol/record-contracts.ts';
import type {
	Arm,
	Authority,
	Bindings,
	CrossAnswer,
	Invocation,
	InputPath,
	Lock,
	Outcome,
	RowData,
	Sql,
	WriteArm
} from '../contracts.ts';
import type { Pred } from '@norbital-ai/store';
import type { Bridge } from '../services.ts';
import { layered, type EngineManifest } from '../manifest.ts';
import type { GuestShape as GuestPort } from '../services.ts';
import type { TenantDbShape as TenantDb } from '../db/tenant-db.ts';
import { LIMITS } from '../contracts.ts';
import { SerializationReplay, type EngineError } from '../errors.ts';
import { BoltError, fromStore } from '../../protocol/errors.ts';
import { admitMove, readScope } from '../access/authority.ts';
import { catalogOf } from '../access/pred.ts';
import { approvalHook } from '../approvals/approvals.ts';

const MiB = 1024 * 1024;
/** One act holds every row until its single insert: the cell's safe input budget, measured at ten-chunk bulk creates. */
const ACT_INPUT_BYTES = 8 * MiB;
const ACT_ROWS = 4_000;
import { readHistory } from '../query/history.ts';
import { heldFields, holders } from '../approvals/lock.ts';
import { Snapshot } from '../approvals/snapshot.ts';
import { Effect, Layer, Predicate, Schema } from 'effect';
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
import { indexColumn, nullRowSql, q, SYSTEM_COLUMNS, type Catalog } from '@norbital-ai/store';
import { evaluate, type EvalEnv } from '../query/eval.ts';
import { toPred } from '../access/pred.ts';
import { compileGets } from '@norbital-ai/store';
import {
	coalescing,
	memoReads,
	readComposed,
	readEngine,
	readTargets,
	ReadDeps
} from '../query/engine.ts';
import { composable, readOptions } from '../query/reader.ts';
import { constraintIndex } from '../schema/plan.ts';
import { type ConstraintMeta } from '@norbital-ai/store';
import {
	compileCommit,
	executeCommit,
	compileOutcomeRecord,
	committed,
	CommitAnswer,
	type Commit,
	type OwnedLock,
	type Write
} from './commit.ts';
import { changed, Flattener, modelKey, withDefaults, type Item, type Sel } from './flatten.ts';
import { canonical, sha256Hex, databaseValue } from '@norbital-ai/store';
import { decided, KEY_REUSE, minter, fingerprinting, type Fingerprint } from './sql.ts';
import { prospectiveBridge } from './prospective.ts';
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
		readonly collection: string;
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
			readonly collection: string;
			readonly id: string;
			readonly fields: readonly string[];
		}[];
		readonly records: readonly HeldRecord[];
	}): Effect.Effect<NonNullable<Commit['resubmit']>, EngineError>;
}
export type WriteEngine = {
	log?: InvocationEvents;
	committed?: (
		answer: Pick<CommitAnswer, 'captured' | 'next_due' | 'changed_instances'>,
		outcome?: Outcome
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
const constraints = new WeakMap<EngineManifest, ReadonlyMap<string, ConstraintMeta>>();
export const constraintsOf = (m: EngineManifest): ReadonlyMap<string, ConstraintMeta> => {
	let c = constraints.get(m);
	if (c === undefined) constraints.set(m, (c = constraintIndex(m)));
	return c;
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
const HOUR = 3600000;
export const k = (collection: string, id: string) => `${collection}\u0000${id}`;
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
			yield* e.log.emit(severity, event, { callable: `${r.collection}.${r.verb}`, ...attributes });
		});
	const res = yield* r.verb === 'erase' ? erase(e, r, take) : pipeline(e, r, take);
	const o = res.outcome;
	if (!took && e.log !== undefined && (o.kind === 'refused' || o.kind === 'conflict')) {
		yield* e.log.emit('warn', 'act.refused', {
			callable: `${r.collection}.${r.verb}`,
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
		callable: `${r.collection}.${r.verb}`
	});
	const key = sha256Hex(`${principal}\u0000${r.key}`);
	const digest = sha256Hex(
		canonical({
			callable: `${r.collection}.${r.verb}`,
			input: r.input,
			onConflict: r.onConflict ?? null
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
		...(Object.hasOwn(SYSTEM.collections, r.collection)
			? { manifest: layered(engine.manifest) }
			: {})
	};
	const m = e.manifest,
		cat = catalogOf(m),
		b = r.bindings;
	const { sync, sink, pending } = modeContext(r.mode);
	const auth = sync ? { ...r.authority, admin: true } : r.authority; // A sync page is workspace work, outside caller grants.
	const none = (outcome: Outcome): ActResult => ({ outcome, captured: [], v: 0 });
	// 1. rate admission (host memory, rule 38): never recorded
	const limited = e.admit?.(r);
	if (limited)
		return none(refused('rateLimited', `Too many requests; retry in ${limited.retryAfter} s.`));
	const late = expired(r);
	if (late !== null) return none(late);
	// 2. decode against the collection's input allowlist, every offender at once (rule 23)
	const spec = m.collections[r.collection];
	if (spec === undefined)
		return yield* Effect.fail(
			BoltError.make('unknownCollection', 'decode', `unknown collection '${r.collection}'`)
		);
	const sel = (
		sync
			? { columns: sync.fields } // hook:integrations
			: r.verb === 'update'
				? spec.update?.input
				: r.verb === 'delete'
					? spec.delete && { columns: [] }
					: spec.create?.input
	) as Sel | undefined;
	const key0 = modelKey(m, r.collection);
	// An upsert uses an explicit id or the model's natural key and needs both caller-facing write arms.
	const byId = r.verb === 'upsert';
	if (
		sel === undefined ||
		(r.verb === 'upsert' &&
			(r.onConflict === undefined ||
				(byId ? sync === undefined && spec.update === undefined : key0.length === 0)))
	)
		return none(refused('forbidden', `${r.collection} does not accept ${r.verb}.`));
	// rule 30: an import's options and its refs by key values, resolved before decode (one read per target)
	let imp: ImportPlan | undefined;
	if (r.verb === 'import') {
		const planned = importPlan(m, r.collection, r.input, key0);
		if ('kind' in planned) return none(planned);
		const refs = yield* importRefs(e.db, m, cat, r.collection, planned.rows);
		if ('kind' in refs) return none(refs);
		imp = { ...planned, rows: refs };
	}
	const mint = minter(r.invocationId, b.now);
	const f = new Flattener(m, cat, mint);
	const inputs = imp?.rows ?? list(r.input, r.verb);
	// A bulk act holds every row until one atomic insert: refuse before the flattener copies them past the cell's budget.
	let inputBytes = 0;
	for (const input of inputs) {
		inputBytes += JSON.stringify(input)?.length ?? 0;
		if (inputBytes > ACT_INPUT_BYTES)
			return none(
				refused(
					'overflow',
					`An act writes at most ${ACT_INPUT_BYTES / MiB} MiB of input; split the work into smaller acts.`
				)
			);
	}
	if (inputs.length > ACT_ROWS)
		return none(
			refused(
				'overflow',
				`An act writes at most ${ACT_ROWS} rows; split the work into smaller acts.`
			)
		);
	if (byId) {
		const invalid = inputs.findIndex((x) => !Predicate.isObject(x));
		if (invalid >= 0)
			return none(
				refused(
					'invalidInput',
					'Expected an object.',
					inputs.length > 1 || Array.isArray(r.input) ? [invalid] : []
				)
			);
		const badId = inputs.findIndex(
			(x) => Predicate.isObject(x) && x['id'] !== undefined && typeof x['id'] !== 'string'
		);
		if (badId >= 0)
			return none(
				refused('invalidInput', 'Expected an id.', [
					...(inputs.length > 1 || Array.isArray(r.input) ? [badId] : []),
					'id'
				])
			);
	}
	// rule 28: an upsert row whose `id` is on file is an update of it (`keep`: left as it is), resolved here, before the
	// transform, so the transform sees the stored row; a row without an id is a create; an id on no row is refused
	const upserted: (string | null)[] = [];
	const onFile = byId
		? yield* readRows(
				e.db,
				cat,
				inputs.flatMap((x) =>
					Predicate.isObject(x) && typeof x['id'] === 'string'
						? [[r.collection, x['id']] as const]
						: []
				)
			)
		: new Map<string, RowData>();
	const missing = byId
		? inputs.findIndex(
				(x) =>
					Predicate.isObject(x) &&
					x['id'] !== undefined &&
					!onFile.has(k(r.collection, String(x['id'])))
			)
		: -1;
	if (missing >= 0 && sync === undefined)
		return none(
			refused('notFound', `No ${r.collection} has this id.`, [
				...(inputs.length > 1 || Array.isArray(r.input) ? [missing] : []),
				'id'
			])
		);
	inputs.forEach((x, i) => {
		const path = inputs.length > 1 || Array.isArray(r.input) || imp !== undefined ? [i] : [];
		if (r.verb === 'create' || (imp !== undefined && imp.onConflict === undefined))
			f.create(r.collection, sel, x, path);
		else if (imp !== undefined)
			f.create(r.collection, sel, x, path, undefined, {
				on: key0,
				onConflict: imp.onConflict === 'update' ? 'update' : 'keep'
			});
		else if (byId) {
			const { id, ...row } = x as Obj;
			if (typeof id !== 'string') {
				const at = f.items.length;
				f.create(
					r.collection,
					sel,
					row,
					path,
					undefined,
					key0.length === 0 ? undefined : { on: key0, onConflict: r.onConflict! }
				);
				upserted.push(f.items[at]?.change.id ?? null);
			} else {
				upserted.push(id);
				if (sync !== undefined && !onFile.has(k(r.collection, id)))
					f.create(r.collection, sel, row, path, undefined, undefined, id);
				else if (r.onConflict === 'update')
					f.update(
						r.collection,
						sync === undefined ? (spec.update!.input as Sel) : sel,
						id,
						row,
						r.observed?.[id] ?? null,
						path
					);
			}
		} else if (r.verb === 'update')
			f.update(
				r.collection,
				sel,
				(
					x as {
						target?: Json;
					}
				).target,
				(
					x as {
						set?: Json;
					}
				).set,
				r.observed?.[
					String(
						(
							x as {
								target?: Json;
							}
						).target
					)
				] ?? null,
				path
			);
		else
			f.delete(
				r.collection,
				(
					x as {
						target?: Json;
					}
				).target,
				r.observed?.[
					String(
						(
							x as {
								target?: Json;
							}
						).target
					)
				] ?? null,
				path
			);
	});
	sync?.deletes.forEach((id, i) => f.delete(r.collection, id, null, ['deletes', i]));
	if (f.problems.length > 0) {
		const [first] = f.problems;
		return none(
			refused(
				'invalidInput',
				f.problems.map((p) => `${p.path.join('.') || 'input'}: ${p.message}`).join('; '),
				first!.path
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
	const own = yield* memoReads(yield* coalescing(e.db));
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
		for (const id of ids) f.delete(r.collection, id, null, ['prune']);
	}
	const visibility = new Map<string, boolean>();
	const scope = { authority: auth, bindings: b, visibility };
	const pre = yield* readRows(
		own,
		cat,
		[
			...f.items
				.filter((i) => i.change.op === 'update' || i.change.op === 'delete')
				.map((i) => [i.change.collection, i.change.id] as const),
			...f.items.flatMap((i) =>
				i.change.op === 'upsert' &&
				i.change.on.length === 1 &&
				i.change.on[0] === 'id' &&
				typeof i.change.values['id'] === 'string'
					? [[i.change.collection, i.change.values['id']] as const]
					: []
			),
			...[...matched].map(([item, row]) => [item.change.collection, String(row['id'])] as const),
			...f.items.flatMap((i) => i.refs.map((x) => [x.to, x.id] as const))
		],
		scope
	);
	for (const [item, row] of matched) {
		const id = String(row['id']);
		pre.set(k(item.change.collection, id), row);
		if (byId && item.change.collection === r.collection && item.parent === undefined) {
			const index = typeof item.change.path[0] === 'number' ? item.change.path[0] : 0;
			upserted[index] = id;
			onFile.set(k(r.collection, id), row);
		}
		if (item.change.op === 'upsert') {
			const previous = item.change.id;
			item.change.id = id;
			for (const child of f.items)
				if (child.parent?.collection === item.change.collection && child.parent.id === previous) {
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
	// a relation predicate (a `via` arm, rule 35, or an `{ is }` scope) walks one-relations to any depth: every stored
	// row it reaches is preloaded in one more round trip, only when the caller holds such an arm
	const created = new Map<string, RowData>();
	for (const i of f.items)
		if (i.change.op === 'create' || i.change.op === 'upsert')
			created.set(k(i.change.collection, i.change.id), { ...i.change.values, id: i.change.id });
	if (!auth.admin) {
		const sources: HopSource[] = [...pre].map(([key, row]) => ({
			collection: key.slice(0, key.indexOf('\u0000')),
			row,
			operations: ['read']
		}));
		if (byId && r.onConflict === 'keep')
			for (const row of onFile.values())
				sources.push({ collection: r.collection, row, operations: ['read', 'update'] });
		for (const item of f.items) {
			const change = item.change;
			const operations: Write['op'][] = change.op === 'upsert' ? ['create', 'update'] : [change.op];
			const judged = operations.filter(
				(operation) =>
					item.parent === undefined ||
					(auth.collections[change.collection]?.[operation] ?? []).length > 0
			);
			const named =
				change.op === 'upsert' &&
				change.on.length === 1 &&
				change.on[0] === 'id' &&
				typeof change.values['id'] === 'string'
					? change.values['id']
					: change.id;
			const row = pre.get(k(change.collection, named));
			if (row !== undefined)
				sources.push({ collection: change.collection, row, operations: judged });
			if (change.op !== 'delete')
				sources.push({
					collection: change.collection,
					row: { ...row, ...(change.op === 'update' ? change.set : change.values), id: named },
					operations: judged
				});
		}
		for (const [key, row] of yield* readHops(
			e.db,
			m,
			auth,
			cat,
			sources,
			(c, id) => pre.get(k(c, id)) ?? created.get(k(c, id))
		))
			pre.set(key, row);
	}
	const env: EvalEnv = {
		cat,
		bindings: b,
		authority: auth,
		related: (c, rel, target, row) => {
			if (!cat.models.get(c)!.one.has(rel))
				throw BoltError.make(
					'unsupported',
					'admission',
					`a write grant cannot scope through many-relation '${rel}'`
				);
			const id = row[rel],
				hit =
					typeof id === 'string'
						? (pre.get(k(target, id)) ?? created.get(k(target, id)))
						: undefined;
			return hit === undefined ? [] : [hit];
		}
	};
	if (byId && r.onConflict === 'keep')
		for (const id of upserted) {
			if (id === null) continue;
			const row = onFile.get(k(r.collection, id));
			if (row === undefined) continue;
			if (!readableBy(env, r.collection, row, visibility))
				return none(refused('notFound', 'The record does not exist.'));
			if (!auth.admin && judgePre(auth, env, r.collection, 'update', row, []) !== true)
				return none(refused('forbidden', 'You may not make this change.'));
		}
	// 4. the caller, judged once on the shape it submitted (rules 19, 34, 35, 36)
	const readable = (c: string, row: RowData) => readableBy(env, c, row, visibility);
	const unchanged = f.items.flatMap((item): (readonly [string, string])[] =>
		item.parent === undefined &&
		item.change.op === 'update' &&
		suppliedChanges(item, pre.get(k(item.change.collection, item.change.id)) ?? null).length === 0
			? [[item.change.collection, item.change.id]]
			: []
	);
	const resubmitting = new Set(
		(auth.admin ? [] : yield* holders(e.db, unchanged, auth.actor))
			.filter((request) => request.state === 'ChangesRequested' && request.requester)
			.map((request) => k(request.collection, request.record))
	);
	for (const it of f.items) {
		const c = it.change,
			named =
				c.op === 'upsert' &&
				c.on.length === 1 &&
				c.on[0] === 'id' &&
				typeof c.values['id'] === 'string'
					? c.values['id']
					: c.id;
		const row = pre.get(k(c.collection, named)),
			action = c.op === 'upsert' && row !== undefined ? 'update' : op(c.op);
		// a relation action on a collection the caller holds no grant on is judged `via` its parent (the parent row was)
		const via = it.parent !== undefined && auth.collections[c.collection] === undefined;
		if (action === 'update' || c.op === 'delete') {
			if (row === undefined || (!via && !readable(c.collection, row)))
				return none(refused('notFound', 'The record does not exist.', c.path));
			if (it.belongs === 'parent' && row[it.parent!.fk] !== it.parent!.id)
				return none(refused('notFound', 'The record does not belong here.', c.path));
		}
		for (const ref of it.refs) {
			const target = pre.get(k(ref.to, ref.id));
			if (target === undefined || !readable(ref.to, target))
				return none(
					refused('notFound', `No readable ${ref.to} has this id.`, [...c.path, ref.field])
				);
		}
		if (
			auth.admin ||
			(it.parent !== undefined && (auth.collections[c.collection]?.[action] ?? []).length === 0)
		)
			continue; // `via` the parent
		const supplied = suppliedChanges(it, row ?? null);
		const verdict = judgePre(auth, env, c.collection, action, row ?? null, supplied);
		if (
			action === 'update' &&
			supplied.length === 0 &&
			verdict !== true &&
			!resubmitting.has(k(c.collection, named))
		)
			return none(refused('forbidden', 'You may not make this change.', c.path));
		const candidates = approvalArms(env, c.collection, action, row ?? null, supplied);
		if (verdict !== true && candidates.length === 0)
			return none(
				refused(
					'forbidden',
					'You may not make this change.',
					verdict.field === undefined ? c.path : [...c.path, verdict.field]
				)
			);
		const state = stateField(m, c.collection);
		const next = c.op === 'update' ? c.set[state ?? ''] : undefined;
		if (
			state !== undefined &&
			typeof next === 'string' &&
			row !== undefined &&
			!admitMove(auth, c.collection, state, String(row[state]), next) &&
			candidates.length === 0
		)
			return none(
				refused('forbidden', `You may not move ${state} to '${next}'.`, [...c.path, state])
			);
	}
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
		const row = pre.get(k(c.collection, named));
		if (row === undefined) continue;
		const seen =
			c.op === 'update' || c.op === 'delete' ? (c.revision ?? r.observed?.[c.id] ?? null) : null;
		if (seen !== null && seen !== row['revision'])
			return none({
				kind: 'conflict',
				records: [{ collection: c.collection, id: c.id, fields: [] }]
			});
	}
	// 6–9, replayed once on a serialization failure with the same clock and minted ids (rule 26)
	const common = {
		key,
		digest,
		issuedAt: r.issuedAt,
		rate: r.rate ?? [],
		...(r.restored === undefined ? {} : { restored: [{ collection: r.collection, ...r.restored }] })
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
			Effect.mapError((error) => BoltError.make('badAnswer', 'commit', error.message, error))
		);
		const res = yield* e.db.returning(
			Schema.Struct({ outcome: Schema.NullOr(OutcomeSchema) }),
			compileOutcomeRecord(common, value)
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
				visibility
			);
			if ('outcome' in planned)
				return planned.guest && sink === undefined
					? yield* record(planned.outcome)
					: none(planned.outcome);
			if (sink !== undefined) {
				// hook:callables
				sink(planned);
				const records = planned.commit.writes.map((w) => ({
					collection: w.collection,
					id: w.id,
					revision: w.op === 'create' ? 1 : w.revision + 1
				}));
				const request =
					planned.commit.approval?.requestId ??
					(planned.commit.resubmit?.pending === true ? planned.commit.resubmit.request : undefined);
				return none(
					request === undefined
						? { kind: 'committed', output: planned.commit.output, records }
						: { kind: 'pendingApproval', requestId: request, records }
				);
			}
			if (imp?.dryRun)
				return none(
					yield* dryRun(
						e.db,
						compileCommit(m, cat, { ...planned.commit, ...common }),
						planned.lock,
						constraintsOf(m)
					)
				);
			return yield* Effect.gen(function* () {
				yield* take('info', 'act.settled', { writes: planned.commit.writes.length });
				const rows = yield* executeCommit(
					e.db,
					m,
					cat,
					{ ...planned.commit, ...common },
					planned.lock
				);
				const row = rows[0];
				if (row === undefined)
					return yield* Effect.fail(
						BoltError.make('badAnswer', 'commit', 'The commit returned no answer.')
					);
				const outcome =
					row.outcome ?? (yield* stored()) ?? refused('refused', 'The outcome was lost.');
				return {
					outcome,
					captured: row.captured,
					...(row.read_guards_applied === true &&
					(outcome.kind === 'committed' || outcome.kind === 'pendingApproval')
						? { readGuardsConsumed: true as const }
						: {}),
					v: e.committed === undefined ? 0 : yield* e.committed(row, outcome)
				};
			}).pipe(
				Effect.catch((err) =>
					Effect.gen(function* () {
						const d = yield* Effect.try({
							try: () => decided(err, constraintsOf(m)),
							catch: (error) =>
								error instanceof BoltError
									? error
									: BoltError.make('bug', 'commit', String(error), error)
						});
						if (d.replay && planned.guest)
							return yield* replay(d.record ? record(d.outcome) : Effect.succeed(none(d.outcome)));
						return d.record ? yield* record(d.outcome) : none(d.outcome);
					})
				)
			);
		})
	);
});
const op = (o: 'create' | 'upsert' | 'update' | 'delete') => (o === 'upsert' ? 'create' : o);
type HopOperation = 'read' | Write['op'];
type HopSource = {
	readonly collection: string;
	readonly row: RowData;
	readonly operations: readonly HopOperation[];
};
/** The one-relation paths (`[fk, target]` hops) the evaluated operations on `c` walk. */
function hopPaths(
	m: EngineManifest,
	auth: Authority,
	c: string,
	operations: readonly HopOperation[]
): (readonly (readonly [string, string])[])[] {
	const a = auth.collections[c];
	const walk = (p: Pred): (readonly (readonly [string, string])[])[] =>
		p.t === 'one'
			? [[[p.rel, p.target]], ...walk(p.pred).map((rest) => [[p.rel, p.target] as const, ...rest])]
			: p.t === 'and' || p.t === 'or'
				? p.of.flatMap(walk)
				: p.t === 'not'
					? walk(p.of)
					: [];
	const arms = operations.flatMap((operation) => a?.[operation] ?? []);
	return [
		...arms.flatMap(
			(
				x: Arm & {
					previous?: Pred;
				}
			) => [...walk(x.where), ...(x.previous === undefined ? [] : walk(x.previous))]
		)
	];
}
const readHops = Effect.fn('Bolt.readHops')(function* (
	db: TenantDb,
	m: EngineManifest,
	auth: Authority,
	cat: Catalog,
	from: readonly HopSource[],
	local: (c: string, id: string) => RowData | undefined
) {
	const seeds = new Map<
		string,
		{
			path: readonly (readonly [string, string])[];
			ids: Set<string>;
		}
	>();
	const paths = new Map<string, ReturnType<typeof hopPaths>>();
	for (const { collection: c, row, operations } of from) {
		const key = JSON.stringify([c, operations]);
		const selected = paths.get(key) ?? hopPaths(m, auth, c, operations);
		paths.set(key, selected);
		for (const path of selected) {
			let cur: RowData | undefined = row;
			for (let i = 0; i < path.length && cur !== undefined; i++) {
				const [fk, target] = path[i]!,
					id = cur[fk];
				if (typeof id !== 'string' || cat.models.get(target) === undefined) break;
				cur = local(target, id);
				if (cur !== undefined) continue;
				const rest = path.slice(i),
					sk = JSON.stringify(rest);
				(seeds.get(sk) ?? seeds.set(sk, { path: rest, ids: new Set() }).get(sk)!).ids.add(id);
			}
		}
	}
	const statements = [...seeds.values()].flatMap(({ path, ids }) =>
		path.map((_, d) => {
			const joins = path
				.slice(1, d + 1)
				.map(([fk, t], j) => `JOIN ${q(t)} t${j + 1} ON t${j + 1}.id = t${j}.${q(fk)}`)
				.join(' ');
			return {
				target: path[d]![1],
				text: `SELECT ${exactRowSql(cat, path[d]![1], `t${d}`)} AS j FROM ${q(path[0]![1])} t0 JOIN jsonb_populate_recordset(${nullRowSql(path[0]![1], cat.models.get(path[0]![1])?.fields.keys() ?? [])}, $1::jsonb) r ON t0.id = r.id ${joins}`,
				params: [JSON.stringify([...ids].map((id) => ({ id })))]
			};
		})
	);
	if (statements.length === 0) return new Map<string, RowData>();
	const res = yield* readComposed(
		db,
		statements.map(({ text, params }) => composable({ text, params }))
	);
	return new Map(
		statements.flatMap((s, i) =>
			res[i]!.rows.map((row) => {
				const got = exactRow(cat, s.target, row['j']!);
				return [k(s.target, String(got['id'])), got] as const;
			})
		)
	);
});
const list = (input: Json, verb: Verb): readonly Json[] => {
	if (Array.isArray(input)) return input;
	const t =
		verb === 'update' || verb === 'delete'
			? (
					input as {
						target?: Json;
					} | null
				)?.target
			: undefined;
	return EffectArray.isArray<typeof t>(t)
		? t.map((target) => ({ ...(input as object), target }))
		: [input];
};
export const stateField = (m: EngineManifest, model: string): string | undefined =>
	Object.entries(m.models[model]?.fields ?? {}).find(([, x]) => x.kind === 'state')?.[0];
/**
 * Rule 35 on the rows as the engine will write them: `create` on the post-image, `update` on both (or `previous` on the
 * pre-image), `delete` on the stored row. Each changed scalar or explicit relationship action needs a scoped field grant.
 */
function judgePost(
	env: EvalEnv,
	c: string,
	o: 'create' | 'update' | 'delete',
	pre: RowData | null,
	post: RowData | null,
	supplied: readonly string[]
):
	| {
			ok: true;
	  }
	| {
			ok: false;
			field?: string;
	  } {
	const is = (p: Parameters<typeof evaluate>[2], row: RowData | null) =>
		row !== null && evaluate(env, c, p, row);
	const scoped = (env.authority!.collections[c]?.[o] ?? []).filter(
		(a) =>
			!a.approval &&
			(o === 'create'
				? is(a.where, post)
				: o === 'delete'
					? is(a.where, pre)
					: is(a.previous ?? a.where, pre) && is(a.where, post))
	);
	if (scoped.length === 0) return { ok: false };
	const admits = (a: WriteArm, f: string) => a.fields === 'all' || a.fields.includes(f);
	const field = supplied.find((f) => !scoped.some((a) => admits(a, f)));
	return field !== undefined ? { ok: false, field } : { ok: true };
}
/** An unchanged scalar restatement needs no field grant; relationship actions remain explicit changes. */
function suppliedChanges(item: Item, row: RowData | null): readonly string[] {
	const c = item.change;
	if ((c.op !== 'update' && c.op !== 'upsert') || row === null) return item.supplied;
	const values = c.op === 'update' ? c.set : c.values;
	const differences = changed(row, values);
	return item.supplied.filter(
		(field) => !Object.hasOwn(values, field) || Object.hasOwn(differences, field)
	);
}
/** Approval arms whose pre-image and fields admit a submitted shape, in policy order. */
function approvalArms(
	env: EvalEnv,
	collection: string,
	operation: Write['op'],
	row: RowData | null,
	supplied: readonly string[]
): readonly WriteArm[] {
	return (env.authority?.collections[collection]?.[operation] ?? []).filter(
		(arm) =>
			arm.approval === true &&
			(operation === 'create' ||
				(row !== null && evaluate(env, collection, arm.previous ?? arm.where, row))) &&
			supplied.every((field) => arm.fields === 'all' || arm.fields.includes(field))
	);
}
const FlowSnapshot = Schema.Union([
	Snapshot,
	Schema.Struct({ kind: Schema.Literal('allow') }),
	Schema.Struct({ kind: Schema.Literal('deny'), message: Schema.String })
]);
const approvalFlow = Effect.fn('Bolt.approvalFlow')(function* (
	e: WriteEngine,
	request: ActRequest,
	env: EvalEnv,
	write: Write,
	previous: RowData | null,
	fields: readonly string[],
	changes?: readonly string[]
): Effect.fn.Return<{ snapshot: ApprovalSnapshot | Outcome; guest: boolean }, EngineError> {
	const post =
		write.op === 'create'
			? { ...write.values, id: write.id }
			: write.op === 'update'
				? { ...previous, ...write.set, id: write.id }
				: null;
	const state = stateField(e.manifest, write.collection),
		next = write.op === 'update' && state !== undefined ? write.set[state] : undefined;
	const moveDenied =
		state !== undefined &&
		typeof next === 'string' &&
		previous !== null &&
		!admitMove(env.authority!, write.collection, state, String(previous[state]), next);
	if (judgePost(env, write.collection, write.op, previous, post, fields).ok && !moveDenied)
		return { snapshot: { kind: 'allow' }, guest: false };
	const arm = approvalArms(env, write.collection, write.op, previous, fields).find((candidate) => {
		const image = write.op === 'delete' ? previous : post;
		return image !== null && evaluate(env, write.collection, candidate.where, image);
	});
	if (arm === undefined)
		return { snapshot: refused('forbidden', 'You may not make this change.'), guest: false };
	if (e.guest === undefined)
		return yield* BoltError.make('noGuest', 'guest', 'this host runs no guest code');
	const b = request.bindings,
		actor = env.authority!.actor;
	const decimal = inputSchema({ kind: 'decimal', scale: 0 });
	const image = (row: RowData | null) =>
		Effect.try({
			try: () =>
				row === null
					? null
					: Object.fromEntries(
							Object.entries(row).map(([name, value]) => {
								const field = env.cat.models.get(write.collection)?.fields.get(name);
								return [
									name,
									field?.pg === 'numeric' && value !== null
										? encodeWire(
												Schema.decodeUnknownSync(field.many ? Schema.Array(decimal) : decimal)(
													value
												)
											)
										: value
								];
							})
						),
			catch: (error) =>
				BoltError.make('badAnswer', 'guest', 'The approval row did not decode.', error)
		});
	const invocation: Invocation = {
		id: `${request.invocationId}:approval:${write.collection}:${write.op}:${write.id}`,
		kind: 'approval',
		target: `${arm.policy}.${write.collection}.${write.op}`,
		input: {
			op: write.op,
			record: yield* image(post ?? previous),
			previous: write.op === 'update' ? yield* image(previous) : null,
			changed:
				changes ??
				(write.op === 'create'
					? Object.keys(write.values)
					: write.op === 'update'
						? Object.keys(write.set)
						: []),
			requester: actor.kind === 'member' ? { id: actor.id, team: actor.teams[0] ?? null } : null
		},
		ctx: { actor, now: b.now, today: b.today, tz: b.tz, seed: request.invocationId },
		budget: { crossings: 0, readBytes: 0 }
	};
	const g = yield* e.guest.invoke(invocation, { cross: () => Effect.succeed([]) });
	if (g.kind === 'failed') return { snapshot: yield* guestFailure(g.error), guest: true };
	if (g.kind === 'refused') return { snapshot: refused('refused', g.message), guest: true };
	const snapshot = yield* Schema.decodeUnknownEffect(FlowSnapshot)(g.output).pipe(
		Effect.mapError((error) => BoltError.make('invalidSpec', 'guest', error.message, error))
	);
	return { snapshot, guest: true };
});
/** Rule 13: the caller's read scope admits `row` (an administrator reads everything). */
function readableBy(
	env: EvalEnv,
	c: string,
	row: RowData,
	visibility?: ReadonlyMap<string, boolean>
): boolean {
	const key = typeof row['id'] === 'string' ? k(c, row['id']) : undefined;
	if (key !== undefined && visibility?.has(key)) return visibility.get(key) === true;
	const s = env.authority!.admin ? undefined : readScope(env.authority!, c);
	return env.authority!.admin || (s !== undefined && evaluate(env, c, s, row));
}
/** Pre-guest judgement: the pre-image scope of an update or delete, and `fields` of every supplied field. */
export function judgePre(
	auth: Authority,
	env: EvalEnv,
	collection: string,
	o: 'create' | 'update' | 'delete',
	row: RowData | null,
	supplied: readonly string[]
):
	| true
	| {
			field?: string;
	  } {
	const arms = (auth.collections[collection]?.[o] ?? []).filter(
		(a: WriteArm) =>
			!a.approval &&
			(o === 'create' || (row !== null && evaluate(env, collection, a.previous ?? a.where, row)))
	);
	if (arms.length === 0) return {};
	const field = supplied.find((s) => !arms.some((a) => a.fields === 'all' || a.fields.includes(s)));
	return field === undefined ? true : { field };
}
/** The array types the adapters parse element by element (`db/wire.ts`); any other array arrives as its text. */
const PARSED_ARRAYS = new Set([
	'bool',
	'int2',
	'int4',
	'int8',
	'text',
	'varchar',
	'uuid',
	'date',
	'timestamptz',
	'jsonb'
]);
const lit = (s: string) => `'${s.replaceAll("'", "''")}'`;
/**
 * A stored row of `table` at alias `a` as one jsonb that equals what the adapters parse of `SELECT a.*` (numerics and
 * unparsed arrays as their text, the id as text), so an act's own reads compose into one statement (`exactRow` ends it).
 */
function exactRowSql(cat: Catalog, table: string, a: string): string {
	const over = [`'id', ${a}.id::text`];
	for (const f of cat.models.get(table)?.fields.values() ?? [])
		if (f.name !== 'id' && (f.many ? !PARSED_ARRAYS.has(f.pg) : f.pg === 'numeric'))
			over.push(`${lit(f.column)}, ${a}.${q(f.column)}::text`);
	return `(to_jsonb(${a}) || jsonb_build_object(${over.join(', ')}))`;
}
/** `exactRowSql`'s jsonb as the parsed row: an instant reads `Z`, as the adapters give it. */
function exactRow(cat: Catalog, table: string, j: Json): RowData {
	const row = {
		...(j as {
			[column: string]: Json;
		})
	};
	const z = (v: Json): Json => (typeof v === 'string' ? v.replace(/\+00:00$/, 'Z') : v);
	for (const f of cat.models.get(table)?.fields.values() ?? []) {
		if (f.pg !== 'timestamptz' || row[f.column] == null) continue;
		const v = row[f.column]!;
		row[f.column] = Array.isArray(v) ? v.map(z) : z(v);
	}
	return row;
}
type ReadVisibility = {
	authority: Authority;
	bindings: Bindings;
	visibility: Map<string, boolean>;
};
const databaseRead = (pred: Pred): boolean =>
	pred.t === 'many' ||
	pred.t === 'count' ||
	pred.t === 'agg' ||
	pred.t === 'search' ||
	pred.t === 'similar' ||
	(pred.t === 'one' && databaseRead(pred.pred)) ||
	((pred.t === 'and' || pred.t === 'or') && pred.of.some(databaseRead)) ||
	(pred.t === 'not' && databaseRead(pred.of));
const databaseReadScope = (authority: Authority, collection: string): boolean =>
	!authority.admin &&
	(authority.collections[collection]?.read.some((arm) => databaseRead(arm.where)) ?? false);
/** Reads raw rows and required native visibility checks in one composed statement, keyed `collection␀id`. */
export const readRows = Effect.fn('Bolt.readRows')(function* (
	db: TenantDb,
	cat: Catalog,
	want: readonly (readonly [string, string])[],
	scope?: ReadVisibility
): Effect.fn.Return<Map<string, RowData>, EngineError> {
	const byTable = Map.groupBy(want, ([c]) => c);
	if (byTable.size === 0) return new Map();
	const tables = [...byTable.keys()];
	const checks =
		scope === undefined ? [] : tables.filter((table) => databaseReadScope(scope.authority, table));
	const res = yield* readComposed(db, [
		...tables.map((t) =>
			composable({
				text: `SELECT ${exactRowSql(cat, t, 't')} AS j FROM ${q(t)} t JOIN jsonb_populate_recordset(${nullRowSql(t, cat.models.get(t)?.fields.keys() ?? [])}, $1::jsonb) r ON t.id = r.id`,
				params: [
					JSON.stringify([...new Set(byTable.get(t)!.map(([, id]) => id))].map((id) => ({ id })))
				]
			})
		),
		...(yield* Effect.forEach(checks, (table) => {
			if (scope === undefined)
				return Effect.fail(
					BoltError.make('internal', 'admission', 'read visibility requires its caller scope')
				);
			const ids = [
				...new Set(want.filter(([collection]) => collection === table).map(([, id]) => id))
			];
			for (const id of ids) scope.visibility.set(k(table, id), false);
			return compileGets(
				cat,
				table,
				ids,
				{ fields: ['id'], relations: {} },
				readOptions({ as: 'caller', authority: scope.authority }, scope.bindings)
			).pipe(Effect.map(composable), Effect.mapError(fromStore));
		}))
	]);
	for (const [index, table] of checks.entries())
		for (const row of res[tables.length + index]?.rows ?? []) {
			const value = row['j'];
			if (Predicate.isObject(value) && typeof value['id'] === 'string')
				scope?.visibility.set(k(table, value['id']), true);
		}
	return new Map(
		tables.flatMap((t, i) =>
			res[i]!.rows.map((row) => {
				const got = exactRow(cat, t, row['j']!);
				return [k(t, String(got['id'])), got] as const;
			})
		)
	);
});
type Planned = {
	guest: boolean;
} & (
	| {
			outcome: Outcome;
	  }
	| PlannedCommit
);
const plan = Effect.fn('Bolt.plan')(function* (
	e: WriteEngine,
	r: ActRequest,
	env: EvalEnv,
	submitted: readonly Item[],
	pre: Map<string, RowData>,
	imp?: ImportPlan,
	upserted?: (string | null)[],
	own: TenantDb = e.db,
	visibility: Map<string, boolean> = new Map<string, boolean>()
): Effect.fn.Return<Planned, EngineError> {
	const { sync } = modeContext(r.mode);
	const m = e.manifest,
		auth = env.authority!,
		b = r.bindings,
		cat = env.cat;
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
	let runs = false;
	const readTables = new Set<string>(),
		fingerprints: Fingerprint[] = [];
	const token = (item: Item) => canonical([item.change.collection, item.change.path]);
	const identities = new Map(submitted.map((item) => [token(item), item.change.id]));
	const supplied = new Map(submitted.map((item) => [token(item), item.supplied]));
	const importRows: { index: number | null; id: string | null; action: string }[] = [];
	const upsertOutput: string[] = [];
	const descendants = (item: Item, root: Item) =>
		item !== root &&
		item.change.path.length > root.change.path.length &&
		root.change.path.every((part, at) => item.change.path[at] === part);
	const depth = (item: Item) =>
		item.change.path.filter(
			(part, index) =>
				typeof part === 'string' &&
				typeof item.change.path[index + 1] === 'number' &&
				['create', 'update', 'upsert', 'delete', 'link', 'unlink'].includes(part)
		).length;
	let children: ReadonlyMap<string, readonly Item[]> = new Map();
	const payload = (item: Item, nested = false): RowData => {
		const c = item.change;
		if (c.op === 'delete') return {};
		const values: Record<string, Json> = { ...(c.op === 'update' ? c.set : c.values) };
		if (nested && item.parent !== undefined && c.op !== 'update') delete values[item.parent.fk];
		for (const child of (children.get(k(c.collection, c.id)) ?? []).filter(
			(one) => depth(one) === depth(item) + 1 && descendants(one, item)
		)) {
			const rel = child.parent!.rel;
			const action = child.change.path.findLast(
				(part) =>
					typeof part === 'string' &&
					['create', 'update', 'upsert', 'delete', 'link', 'unlink'].includes(part)
			);
			if (typeof action !== 'string') continue;
			const group: { [key: string]: Json } = Predicate.isObject(values[rel])
				? { ...values[rel] }
				: {};
			const existing = group[action];
			const list: Json[] = jsonArray(existing) ? [...existing] : [];
			const sub = payload(child, true);
			list.push(
				action === 'update'
					? { target: child.change.id, set: sub }
					: action === 'upsert'
						? { id: child.change.id, ...sub }
						: ['delete', 'link', 'unlink'].includes(action)
							? child.change.id
							: sub
			);
			group[action] = list;
			values[rel] = group;
		}
		return values;
	};
	// Parent callbacks may replace their native children. Each following level resolves its own keys before callbacks.
	for (let level = 0; level <= LIMITS.writeDepth; level++) {
		const current = items.filter((item) => depth(item) === level);
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
				(!readableBy(env, c.collection, found, visibility) || (root && imp.onConflict === 'refuse'))
			)
				return {
					guest: runs,
					outcome: refused('unique', 'A record with these values already exists.', c.path)
				};
			if (found === undefined && c.on.length === 1 && c.on[0] === 'id' && sync === undefined)
				return {
					guest: runs,
					outcome: refused('notFound', `No ${c.collection} has this id.`, [...c.path, 'id'])
				};
			const id = found === undefined ? c.id : String(found['id']);
			const skip = found === undefined && root && imp.onMissing === 'skip';
			if (r.verb === 'upsert' && item.parent === undefined) upsertOutput.push(id);
			if (root)
				importRows.push({
					index: Number(c.path[0]),
					id: skip ? null : id,
					action: skip
						? 'skipped'
						: found === undefined
							? 'created'
							: c.onConflict === 'keep'
								? 'kept'
								: 'updated'
				});
			if (skip || (found !== undefined && c.onConflict === 'keep')) {
				items = items.filter((one) => one !== item && !descendants(one, item));
				continue;
			}
			if (found !== undefined) pre.set(k(c.collection, id), found);
			const values = Object.fromEntries(
				Object.entries(c.values).filter(
					([field]) => field !== 'id' && (found === undefined || !c.on.includes(field))
				)
			);
			item.change =
				found === undefined
					? { collection: c.collection, id, path: c.path, op: 'create', values }
					: {
							collection: c.collection,
							id,
							path: c.path,
							op: 'update',
							set: values,
							revision: Number(found['revision'])
						};
			identities.set(token(item), id);
			if (id !== c.id)
				for (const child of items) {
					if (
						child.parent?.collection !== c.collection ||
						child.parent.id !== c.id ||
						!descendants(child, item)
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
		const groups = Map.groupBy(
			items.filter((item) => depth(item) === level),
			(item) => canonical([item.change.collection, item.change.op])
		);
		for (const roots of groups.values()) {
			const first = roots[0];
			if (first === undefined || first.change.op === 'upsert') continue;
			const collection = first.change.collection,
				verb = first.change.op;
			if (!hasCallback(m, collection, verb)) continue;
			if (e.guest === undefined)
				return yield* BoltError.make('noGuest', 'guest', 'this host runs no guest code');
			children = Map.groupBy(
				items.filter((item) => item.parent !== undefined),
				(item) => k(item.parent!.collection, item.parent!.id)
			);
			const ids = roots.map((item) => (item.change.op === 'create' ? null : item.change.id));
			const before = yield* wireRows(own, cat, collection, ids, b);
			for (let offset = 0; offset < roots.length; offset += LIMITS.writeChunk) {
				const chunk = roots.slice(offset, offset + LIMITS.writeChunk),
					seed = `${r.invocationId}:${collection}:${verb}:${level}:${offset / LIMITS.writeChunk}`;
				const input: Json[] = [];
				for (const [index, item] of chunk.entries()) {
					const stored = before[offset + index];
					if (verb !== 'create' && stored == null)
						return {
							guest: runs,
							outcome: refused('notFound', 'The record does not exist.', item.change.path)
						};
					input.push(
						verb === 'create'
							? payload(item)
							: verb === 'update'
								? { before: stored!, set: payload(item) }
								: stored!
					);
				}
				const invocation: Invocation = {
					id: seed,
					kind: verb,
					target: collection,
					input,
					ctx: {
						actor: auth.actor,
						policies: auth.policies,
						admin: auth.admin,
						now: b.now,
						today: b.today,
						tz: b.tz,
						seed
					},
					budget: { crossings: LIMITS.crossings.write, readBytes: LIMITS.readBytes }
				};
				const original = e.bridge?.(invocation, own) ?? transformBridge(m, own, invocation);
				const bridge = prospectiveBridge(e, cat, b, auth.actor, items, pre, original);
				const g = yield* e.guest.invoke(invocation, bridge);
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
							rule: `${collection}.${verb}`,
							...(g.field === undefined ? {} : { field: g.field }),
							...(typeof row === 'number' ? { row } : {})
						}
					};
				}
				if (g.kind === 'failed') return { guest: true, outcome: yield* guestFailure(g.error) };
				if (verb === 'delete') {
					if (g.output !== null)
						return yield* BoltError.make(
							'transformShape',
							'guest',
							'A delete check returns no payload.'
						);
					continue;
				}
				if (!Array.isArray(g.output) || g.output.length !== chunk.length)
					return yield* BoltError.make(
						'transformShape',
						'guest',
						'a write callback returns one payload per input'
					);
				const again = new Flattener(m, cat, minter(seed, b.now), identities);
				for (const [index, item] of chunk.entries()) {
					const c = item.change;
					if (c.op === 'create')
						again.create(collection, 'any', g.output[index], c.path, item.parent);
					else if (c.op === 'update')
						again.update(collection, 'any', c.id, g.output[index], c.revision, c.path, item.parent);
				}
				if (again.problems.length)
					return yield* BoltError.make(
						'transformPayload',
						'guest',
						again.problems
							.map((problem) => `${problem.path.join('.')}: ${problem.message}`)
							.join('; ')
					);
				const replacements: Item[] = again.items.map((item) => {
					const belongs = chunk.find((root) => token(root) === token(item))?.belongs;
					return {
						...item,
						supplied: supplied.get(token(item)) ?? [],
						...(belongs === undefined ? {} : { belongs })
					};
				});
				const replacedPaths = new Set(chunk.map((item) => canonical(item.change.path)));
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
				for (const item of replacements) identities.set(token(item), item.change.id);
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
							? pre.has(k(item.change.collection, item.change.id))
								? []
								: [[item.change.collection, item.change.id] as const]
							: []
					)
				);
				for (const [key, row] of more) pre.set(key, row);
			}
		}
	}
	// sys_integration's transform is the engine's: it reads the manifest's definitions and envoys
	if (r.collection === 'sys_integration') {
		const t = instanceTransform(m, items, (id) => pre.get(k(r.collection, id)));
		if ('kind' in t) return { guest: false, outcome: t };
		items = [...t];
	}
	// Callback output remains subject to the model's sync ownership.
	const owned = syncOwnership(m, r, items);
	if (owned !== null) return { guest: runs, outcome: owned };
	let guest = runs;
	const stop = (outcome: Outcome): Planned => ({ guest, outcome });
	// 7. upsert resolution read, defaults (rule 23a), model rules (rules 34, 40, 41), no-op updates (rule 29)
	const writes: {
		write: Write;
		item: Item;
	}[] = [];
	const resolvedImportIndices = new Set(importRows.map((row) => row.index));
	const report: {
		index: number | null;
		id: string | null;
		action: string;
	}[] = [];
	const deletedIds = new Set(
		items.filter((i) => i.change.op === 'delete').map((i) => k(i.change.collection, i.change.id))
	);
	for (const it of items) {
		const c = it.change;
		if (c.op !== 'delete' && deletedIds.has(k(c.collection, c.id)))
			return stop(
				refused(
					'invalidInput',
					'A row deleted in this act cannot also be changed (deletedInAct).',
					c.path
				)
			);
		const root = imp !== undefined && it.parent === undefined;
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
			const missing = withDefaults(m, cat, c.collection, values, auth.actor, b);
			if (missing !== null)
				return stop(refused('required', `${missing} is required.`, [...c.path, missing]));
			const state = stateField(m, c.collection);
			const stateKind = state === undefined ? undefined : m.models[c.collection]?.fields[state];
			const initial = stateKind?.kind === 'state' ? stateKind.initial : undefined;
			if (state !== undefined && values[state] !== initial)
				return stop(
					refused('invalidInput', `A new record starts in '${initial}'.`, [...c.path, state])
				);
			writes.push({
				write: { collection: c.collection, id: c.id, op: 'create', values },
				item: it
			});
		} else {
			const row = pre.get(k(c.collection, c.id));
			if (row === undefined) return stop(refused('notFound', 'The record does not exist.', c.path));
			if (c.op === 'delete') {
				const locked = modelLock(env, m, c.collection, row);
				if (locked !== null) return stop(refused('locked', locked, c.path));
				writes.push({
					write: {
						collection: c.collection,
						id: c.id,
						op: 'delete',
						revision: Number(row['revision'])
					},
					item: it
				});
				continue;
			}
			const set = changed(row, c.set);
			const locked = modelRules(env, m, c.collection, row, set);
			if (locked !== null && !(sync !== undefined && locked.code === 'locked'))
				return stop(refused(locked.code, locked.message, [...c.path, locked.field])); // hook:envoys, hook:integrations
			if (Object.keys(set).length > 0)
				writes.push({
					write: {
						collection: c.collection,
						id: c.id,
						op: 'update',
						set,
						revision: Number(row['revision'])
					},
					item: it
				});
		}
	}
	// §3.3.2: every custom field value the act writes passes its kind's `validate`
	const invalid = yield* validateCustom(e, r, writes);
	if (invalid !== null) return stop(invalid);
	// Transform output and resolved upserts may introduce a mutation or change its relation targets.
	// Load that mutation's own scopes on both images, without borrowing write scopes from readable refs.
	if (!auth.admin) {
		const sources: HopSource[] = [];
		const creating = new Map<string, RowData>();
		for (const { write } of writes)
			if (write.op === 'create')
				creating.set(k(write.collection, write.id), { ...write.values, id: write.id });
		for (const { write, item } of writes) {
			if (
				item.parent !== undefined &&
				(auth.collections[write.collection]?.[write.op] ?? []).length === 0
			)
				continue;
			const row = pre.get(k(write.collection, write.id));
			if (row !== undefined)
				sources.push({ collection: write.collection, row, operations: [write.op] });
			if (write.op !== 'delete')
				sources.push({
					collection: write.collection,
					row: { ...row, ...(write.op === 'create' ? write.values : write.set), id: write.id },
					operations: [write.op]
				});
		}
		for (const [key, row] of yield* readHops(
			own,
			m,
			auth,
			cat,
			sources,
			(c, id) => pre.get(k(c, id)) ?? creating.get(k(c, id))
		))
			pre.set(key, row);
	}
	// 8. Direct admitting arms win; otherwise the first admitting approval arm evaluates its flow.
	let approval: Commit['approval'], resubmit: Commit['resubmit'];
	const records = (collection: string): HeldRecord[] =>
		writes
			.filter(({ write }) => write.collection === collection)
			.map(({ write }) => ({
				id: write.id,
				action: write.op,
				values: {
					...pre.get(k(write.collection, write.id)),
					...(write.op === 'create' ? write.values : write.op === 'update' ? write.set : {}),
					id: write.id
				}
			}));
	const checked: { write: Write; item: Item }[] = [...writes];
	// A nested-only update still needs its parent's declared relationship permission.
	for (const item of submitted)
		if (
			!auth.admin &&
			item.parent === undefined &&
			item.change.op === 'update' &&
			!checked.some(
				({ write }) => write.collection === item.change.collection && write.id === item.change.id
			)
		) {
			const row = pre.get(k(item.change.collection, item.change.id));
			if (row !== undefined)
				checked.push({
					item,
					write: {
						collection: item.change.collection,
						id: item.change.id,
						op: 'update',
						set: {},
						revision: Number(row['revision'])
					}
				});
		}
	const fresh = new Set(
		writes
			.filter(({ write }) => write.op === 'create')
			.map(({ write }) => k(write.collection, write.id))
	);
	const held = yield* holders(
		own,
		checked.flatMap(({ write }): (readonly [string, string])[] => [
			...(write.op === 'create' ? [] : [[write.collection, write.id] as const]),
			...[...(cat.models.get(write.collection)?.one ?? [])].flatMap(([fk, one]) => {
				const parent =
					write.op === 'create' ? write.values[fk] : pre.get(k(write.collection, write.id))?.[fk];
				return m.relationships[`${write.collection}.${fk}`]?.owned &&
					typeof parent === 'string' &&
					!fresh.has(k(one.targets[0]!, parent))
					? [[one.targets[0]!, parent] as const]
					: [];
			})
		]),
		auth.actor
	);
	const routed: { write: Write; snapshot: StepsSnapshot }[] = [];
	for (const { write, item } of checked) {
		if (
			auth.admin ||
			(item.parent !== undefined &&
				(auth.collections[write.collection]?.[write.op] ?? []).length === 0)
		)
			continue;
		// Resubmission judges the whole pending change against its checkpoint below, including an unchanged Save.
		if (
			held.some(
				(request) =>
					request.state === 'ChangesRequested' &&
					request.requester &&
					request.collection === write.collection &&
					request.record === write.id
			)
		)
			continue;
		const previous = pre.get(k(write.collection, write.id)) ?? null;
		const evaluated = yield* approvalFlow(
			e,
			r,
			env,
			write,
			previous,
			suppliedChanges(item, previous),
			[
				...new Set([
					...(write.op === 'create'
						? Object.keys(write.values)
						: write.op === 'update'
							? Object.keys(write.set)
							: []),
					...suppliedChanges(item, previous).filter((field) =>
						cat.models.get(write.collection)?.many.has(field)
					)
				])
			]
		);
		guest ||= evaluated.guest;
		const snapshot = evaluated.snapshot;
		if (
			snapshot.kind === 'refused' ||
			snapshot.kind === 'conflict' ||
			snapshot.kind === 'unknown' ||
			snapshot.kind === 'committed' ||
			snapshot.kind === 'pendingApproval'
		)
			return stop(snapshot);
		if (snapshot.kind === 'deny')
			return stop(refused('refused', snapshot.message, item.change.path));
		if (snapshot.kind === 'steps') {
			guest = true;
			routed.push({ write, snapshot });
		}
	}
	if (routed.some((entry) => canonical(entry.snapshot) !== canonical(routed[0]!.snapshot)))
		return stop(refused('approvalSplit', 'The rows in one act require different approval flows.'));
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
		return stop(refused('approvalSplit', 'One act cannot resubmit several approval requests.'));
	if (saving[0] !== undefined) {
		if (e.approval === undefined)
			return yield* BoltError.make('noApproval', 'admission', 'No approval flow is wired.');
		const request = saving[0];
		const written = writes.find(
			({ write }) => write.collection === request.collection && write.id === request.record
		)?.write;
		const previous =
			pre.get(k(request.collection, request.record)) ??
			(yield* readRows(own, cat, [[request.collection, request.record]])).get(
				k(request.collection, request.record)
			);
		if (previous === undefined && written?.op !== 'create')
			return stop(refused('notFound', 'The approval record does not exist.'));
		const values: RowData = {
			...previous,
			...(written?.op === 'create' ? written.values : written?.op === 'update' ? written.set : {}),
			id: request.record
		};
		const checkpoint = yield* readHistory(
			own,
			m,
			{
				kind: 'history',
				collection: request.collection,
				id: request.record,
				at: { _tag: 'Before', before: request.id },
				full: true
			},
			{ as: 'workspace' },
			b
		);
		const before = Schema.is(Schema.Record(Schema.String, Schema.Json))(checkpoint)
			? checkpoint
			: null;
		if (before === null && request.action !== 'create')
			return stop({
				kind: 'conflict',
				records: [{ collection: request.collection, id: request.record, fields: [] }]
			});
		const system = new Set<string>(SYSTEM_COLUMNS);
		const columns = new Map(
			[...(cat.models.get(request.collection)?.fields.values() ?? [])].map((column) => [
				column.column,
				column
			])
		);
		const pending = Object.fromEntries(
			Object.entries(changed(before ?? {}, values)).filter(([field]) => {
				const column = columns.get(field);
				return (
					!system.has(field) &&
					!field.startsWith('bolt_') &&
					column !== undefined &&
					!column.computed &&
					!column.derived &&
					column.kind !== 'sum' &&
					column.kind !== 'count'
				);
			})
		);
		const pendingFields = [
			...new Set([
				...Object.keys(pending).map((field) => columns.get(field)?.name.split('.')[0] ?? field),
				...(yield* heldFields(own, m, cat, request.id)),
				...submitted.flatMap((item) =>
					item.change.collection === request.collection && item.change.id === request.record
						? item.supplied.filter((field) => cat.models.get(request.collection)?.many.has(field))
						: []
				)
			])
		];
		const root: Write =
			request.action === 'create'
				? { collection: request.collection, id: request.record, op: 'create', values }
				: request.action === 'delete'
					? {
							collection: request.collection,
							id: request.record,
							op: 'delete',
							revision: Number(previous?.['revision'])
						}
					: {
							collection: request.collection,
							id: request.record,
							op: 'update',
							set: pending,
							revision: Number(previous?.['revision'])
						};
		guest = true;
		const { snapshot } = yield* approvalFlow(
			e,
			r,
			env,
			root,
			before,
			root.op === 'create'
				? written?.op === 'update'
					? Object.keys(written.set)
					: []
				: pendingFields,
			pendingFields
		);
		if (snapshot.kind !== 'steps' && snapshot.kind !== 'allow')
			return stop(snapshot.kind === 'deny' ? refused('refused', snapshot.message) : snapshot);
		guest = true;
		resubmit = yield* e.approval.resubmit({
			request: request.id,
			authority: auth,
			bindings: b,
			snapshot,
			changed: writes.map(({ write }) => ({
				collection: write.collection,
				id: write.id,
				fields:
					write.op === 'delete' ? [] : Object.keys(write.op === 'create' ? write.values : write.set)
			})),
			records:
				records(request.collection).length > 0
					? records(request.collection)
					: [{ id: request.record, action: request.action, values }]
		});
	} else if (routed.length > 0 && held.length === 0) {
		if (e.approval === undefined)
			return yield* BoltError.make('noApproval', 'admission', 'No approval flow is wired.');
		const root = checked.find(
			({ item }) => item.parent === undefined && item.change.collection === r.collection
		)?.write;
		if (root === undefined)
			return stop(refused('forbidden', 'No root record admits this approval.'));
		const route = yield* e.approval.route({
			collection: r.collection,
			record: root.id,
			action: root.op,
			authority: auth,
			bindings: b,
			seed: `${r.invocationId}:${r.key}`,
			snapshot: routed[0]!.snapshot,
			records: records(r.collection)
		});
		if ('kind' in route) return stop(route);
		approval = route;
	}
	// Pure search vectors are evaluated in bounded batches and join the same native row writes.
	for (const [collection, entries] of Map.groupBy(
		writes.filter(({ write }) => write.op !== 'delete'),
		({ write }) => write.collection
	)) {
		for (const [name, index] of Object.entries(m.models[collection]?.search?.indexes ?? {})) {
			if (index.field !== undefined) continue;
			if (e.guest === undefined)
				return yield* BoltError.make('noGuest', 'guest', 'this host runs no guest code');
			for (let offset = 0; offset < entries.length; offset += LIMITS.writeChunk) {
				const chunk = entries.slice(offset, offset + LIMITS.writeChunk),
					seed = `${r.invocationId}:vector:${collection}:${name}:${offset / LIMITS.writeChunk}`;
				const g = yield* e.guest.invoke(
					{
						id: seed,
						kind: 'vector',
						target: `${collection}.${name}`,
						input: chunk.map(({ write }) => ({
							...pre.get(k(collection, write.id)),
							...(write.op === 'create' ? write.values : write.op === 'update' ? write.set : {}),
							id: write.id
						})),
						ctx: { actor: auth.actor, now: b.now, today: b.today, tz: b.tz, seed },
						budget: { crossings: 0, readBytes: 0 }
					},
					{ cross: () => Effect.succeed([]) }
				);
				guest = true;
				if (g.kind === 'failed') return stop(yield* guestFailure(g.error));
				if (g.kind === 'refused')
					return stop(refused('internal', 'A pure search vector cannot refuse a write.'));
				const vectors = yield* Schema.decodeUnknownEffect(
					Schema.Array(Schema.NullOr(Schema.Array(Schema.Number)))
				)(g.output).pipe(
					Effect.mapError((error) => BoltError.make('badAnswer', 'guest', error.message, error))
				);
				if (
					vectors.length !== chunk.length ||
					vectors.some(
						(vector) =>
							vector !== null &&
							(vector.length !== index.dim || vector.some((value) => !Number.isFinite(value)))
					)
				)
					return yield* BoltError.make(
						'badAnswer',
						'guest',
						`Index ${collection}.${name} returns exactly ${index.dim} finite numbers per row, or null.`
					);
				for (const [position, entry] of chunk.entries()) {
					const write = entry.write,
						column = indexColumn(name),
						vector = vectors[position] ?? null;
					if (write.op === 'create')
						entry.write = { ...write, values: { ...write.values, [column]: vector } };
					else if (write.op === 'update')
						entry.write = { ...write, set: { ...write.set, [column]: vector } };
				}
			}
		}
	}
	const embed = embedWrites(
		m,
		writes.map((w) => w.write)
	); // hook:integrations — rule 16: stale embeddings null, `bolt.embed` queued
	const plain = embed.writes;
	const queued = embed.stale
		? [embedQueued(minter(`${r.invocationId}:embed`, b.now)(), b.now)]
		: []; // hook:integrations
	if (JSON.stringify(plain).length > LIMITS.changeSetBytes)
		return stop(refused('overflow', 'The change is too large for one act.'));
	const priorGuards = r.mode._tag === 'Record' ? undefined : r.readGuards;
	const tables = [
		...new Set([...plain.map((w) => w.collection), ...readTables, ...(priorGuards?.tables ?? [])])
	].sort();
	return {
		guest,
		commit: {
			now: b.now,
			today: b.today,
			actor: auth.actor,
			writes: plain,
			owned: ownedLocks(
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
function readOnlySync(m: EngineManifest, collection: string): string | undefined {
	return Object.entries(m.collections[collection]?.syncs ?? {}).find(
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
			if (c.collection !== r.collection)
				return refused('forbidden', `A sync writes only ${r.collection}.`, c.path);
			const field = written.find((field) => !sync.fields.includes(field));
			if (field !== undefined)
				return refused(
					'forbidden',
					`'${field}' of ${c.collection} is outside this sync's fields.`,
					[...c.path, field]
				);
			continue;
		}
		const owner = readOnlySync(m, c.collection);
		if (owner === undefined) continue;
		if (c.op !== 'update')
			return refused('forbidden', `${c.collection} is written by its sync ${owner}.`, c.path);
		const local = m.collections[c.collection]?.update?.input.columns ?? [];
		const field = written.find((field) => !local.includes(field));
		if (field !== undefined)
			return refused(
				'forbidden',
				`'${field}' of ${c.collection} is written by its sync ${owner}.`,
				[...c.path, field]
			);
	}
	return null;
}
const hasCallback = (m: EngineManifest, collection: string, verb: Write['op']): boolean =>
	verb === 'delete'
		? m.collections[collection]?.delete?.check === true
		: m.collections[collection]?.[verb]?.transform === true;
/** A model-level lock over the row's own fields, or `null`: application-layer immutability, never a database grant. */
function modelLock(env: EvalEnv, m: EngineManifest, model: string, row: RowData): string | null {
	const locked = m.models[model]?.locked;
	return locked !== undefined && evaluate(env, model, toPred(m, model, locked), row)
		? 'This record is locked and cannot be changed.'
		: null;
}
/** Rules 34, 40, 41 on an update's changed fields: `to` edges, per-state `edit`, and an owned child's fixed parent key. */
function modelRules(
	env: EvalEnv,
	m: EngineManifest,
	model: string,
	row: RowData,
	set: RowData
): {
	code: RefusalCode;
	message: string;
	field: string;
} | null {
	const locked = modelLock(env, m, model, row);
	if (locked !== null) return { code: 'locked', message: locked, field: 'id' };
	for (const [field, kind] of Object.entries(m.models[model]?.fields ?? {}))
		if (kind.kind === 'enum' && kind.transitions !== undefined && set[field] !== undefined) {
			const from = String(row[field] ?? ''),
				next = String(set[field]);
			if (from !== next && !(kind.transitions[from] ?? []).includes(next))
				return {
					code: 'invalidInput',
					message: `'${from}' cannot move to '${next}'.`,
					field
				};
		}
	for (const fk of Object.keys(set))
		if (m.relationships[`${model}.${fk}`]?.owned)
			return {
				code: 'invalidInput',
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
			code: 'invalidInput',
			message: `'${from}' cannot move to '${String(next)}'.`,
			field: state
		};
	const edit = spec[from]?.edit ?? 'all';
	if (edit === 'all') return null;
	const other = Object.keys(set).find((f) => f !== state && (edit === 'none' || !edit.includes(f)));
	return other === undefined
		? null
		: {
				code: 'locked',
				message: `The record is locked while ${state} is '${from}'.`,
				field: other
			};
}
/** Rule 41: every write on an owned relationship's child re-tests its parent's admitting states under `FOR SHARE`. */
export function ownedLocks(
	m: EngineManifest,
	cat: Catalog,
	writes: readonly Write[],
	pre: Map<string, RowData>
): OwnedLock[] {
	const created = new Set(
		writes.filter((w) => w.op === 'create').map((w) => k(w.collection, w.id))
	);
	const locks = new Map<
		string,
		{
			child: string;
			parent: string;
			field: string;
			states: string[];
			ids: Set<string>;
		}
	>();
	for (const w of writes)
		for (const [fk, one] of cat.models.get(w.collection)!.one) {
			const rel = m.relationships[`${w.collection}.${fk}`];
			if (!rel?.owned || rel.inverse === undefined) continue;
			const parent = one.targets[0]!,
				state = stateField(m, parent);
			const id = w.op === 'create' ? w.values[fk] : pre.get(k(w.collection, w.id))?.[fk];
			if (state === undefined || typeof id !== 'string' || created.has(k(parent, id))) continue;
			const kind = m.models[parent]?.fields[state];
			if (kind?.kind !== 'state') continue;
			const inverse = rel.inverse;
			const states = Object.entries(kind.states)
				.filter(
					([, spec]) =>
						(spec.edit ?? 'all') === 'all' ||
						(Array.isArray(spec.edit) && spec.edit.includes(inverse))
				)
				.map(([name]) => name);
			const lock = locks.get(`${parent}.${rel.inverse}`) ?? {
				child: w.collection,
				parent,
				field: state,
				states,
				ids: new Set<string>()
			};
			lock.ids.add(id);
			locks.set(`${parent}.${rel.inverse}`, lock);
		}
	return [...locks.values()].map((l) => ({ ...l, ids: [...l.ids] }));
}
export const wireRows = Effect.fn('Bolt.wireRows')(function* (
	db: TenantDb,
	cat: Catalog,
	c: string,
	ids: readonly (string | null)[],
	b: Bindings
) {
	const want = ids.filter((id) => id !== null);
	if (want.length === 0) return ids.map(() => null);
	const [res] = yield* db.read([
		composable(
			yield* compileGets(
				cat,
				c,
				want,
				{ fields: null, relations: {} },
				readOptions({ as: 'workspace' }, b)
			).pipe(Effect.mapError(fromStore))
		)
	]);
	const byId = new Map(
		res!.rows.map((row) => [String((row['j'] as RowData | null)?.['id']), row['j'] as RowData])
	);
	return ids.map((id) => (id === null ? null : (byId.get(id) ?? null)));
});
/**
 * Whether `authority` may update the row at all — an update arm whose pre-image scope admits it, or the admin bypass —
 * and `null` when there is no such row. A host verb on a row (an integration instance's pair, unpair, test) authorizes so.
 */
export const mayUpdate = Effect.fn('Bolt.mayUpdate')(function* (
	e: Pick<WriteEngine, 'manifest' | 'db'>,
	collection: string,
	id: string,
	authority: Authority,
	bindings: Bindings
) {
	const m = Object.hasOwn(SYSTEM.collections, collection) ? layered(e.manifest) : e.manifest,
		cat = catalogOf(m);
	const pre = yield* readRows(e.db, cat, [[collection, id]]);
	const row = pre.get(k(collection, id));
	if (row === undefined) return null;
	if (authority.admin) return true;
	for (const [key, value] of yield* readHops(
		e.db,
		m,
		authority,
		cat,
		[{ collection, row, operations: ['update'] }],
		(c, key) => pre.get(k(c, key))
	))
		pre.set(key, value);
	const env: EvalEnv = {
		cat,
		bindings,
		authority,
		related: (_c, relation, target, current) => {
			const key = current[relation],
				value = typeof key === 'string' ? pre.get(k(target, key)) : undefined;
			return value === undefined ? [] : [value];
		}
	};
	return judgePre(authority, env, collection, 'update', row, []) === true;
});
/** Current-row advice from the same pre-image admission and model rules as an act. */
export const recordCapabilities = Effect.fn('Bolt.recordCapabilities')(function* (
	e: WriteEngine,
	collection: string,
	id: string,
	authority: Authority,
	bindings: Bindings,
	readable: (collection: string, id: string) => Effect.Effect<RowData | null, EngineError>,
	parent?: RecordParentContext
): Effect.fn.Return<RecordCapabilities | null, EngineError> {
	const m = Object.hasOwn(SYSTEM.collections, collection) ? layered(e.manifest) : e.manifest,
		spec = m.collections[collection],
		model = m.models[collection];
	if (spec === undefined || model === undefined) return null;
	const visible = yield* readable(collection, id);
	if (visible === null) return null;
	const visibility = new Map<string, boolean>();
	const cat = catalogOf(m),
		pre = yield* readRows(e.db, cat, [[collection, id]], { authority, bindings, visibility });
	const row = pre.get(k(collection, id));
	if (row === undefined || typeof row['revision'] !== 'number') return null;
	for (const [key, value] of yield* readHops(
		e.db,
		m,
		authority,
		cat,
		[{ collection, row, operations: ['read', 'update', 'delete'] }],
		(c, key) => pre.get(k(c, key))
	))
		pre.set(key, value);
	let updateInput = spec.update?.input,
		deleteInput = spec.delete !== undefined;
	let parentPermission: RecordCapabilities['fields'][string] | undefined;
	if (parent !== undefined) {
		const relation = cat.models.get(parent.collection)?.many.get(parent.relation);
		if (relation?.child !== collection) return null;
		const parentCaps = yield* recordCapabilities(
			e,
			parent.collection,
			parent.id,
			authority,
			bindings,
			readable
		);
		if (parentCaps === null || parentCaps.revision !== parent.revision) return null;
		parentPermission = parentCaps.fields[parent.relation];
		if (parentPermission === undefined) return null;
		const input = m.collections[parent.collection]?.update?.input.with?.[parent.relation];
		const relationship = m.relationships[`${collection}.${relation.column}`];
		const freeLink =
			row[relation.column] == null && !relationship?.owned && input?.['link'] !== undefined;
		if (row[relation.column] !== parent.id && !freeLink) return null;
		const update = input?.['update'];
		updateInput =
			Predicate.isObject(update) &&
			Array.isArray(update['columns']) &&
			update['columns'].every((field: unknown): field is string => typeof field === 'string')
				? { columns: update['columns'] }
				: undefined;
		if (freeLink) updateInput = { columns: [relation.column] };
		else if (!relationship?.owned && relationship?.optional && input?.['unlink'] !== undefined)
			updateInput = { columns: [...(updateInput?.columns ?? []), relation.column] };
		deleteInput = !freeLink && input?.['delete'] !== undefined;
	}
	const via = (verb: 'update' | 'delete') =>
		parent !== undefined && (authority.collections[collection]?.[verb].length ?? 0) === 0;
	const parentAdmits =
		parentPermission === undefined || parentPermission.writable || parentPermission.proposal;
	const parentReasons = parentPermission === undefined ? [] : parentPermission.reasons;
	const env: EvalEnv = {
		cat,
		bindings,
		authority,
		related: (_c, relation, target, current) => {
			const key = current[relation],
				value = typeof key === 'string' ? pre.get(k(target, key)) : undefined;
			return value === undefined ? [] : [value];
		}
	};
	const restrictions: RecordRestriction[] = [];
	if (!readableBy(env, collection, row, visibility)) return null;
	const locks = ownedLocks(
		m,
		cat,
		[{ collection, id, op: 'update', set: {}, revision: row['revision'] }],
		pre
	);
	const parents = locks.flatMap((lock) => lock.ids.map((parent) => [lock.parent, parent] as const));
	for (const [key, value] of yield* readRows(e.db, cat, parents)) pre.set(key, value);
	if (
		locks.some((lock) =>
			lock.ids.some(
				(parent) => !lock.states.includes(String(pre.get(k(lock.parent, parent))?.[lock.field]))
			)
		)
	)
		restrictions.push('ownedParentLocked');
	// the approval lock (lock.ts): an open request holding this record, or its owned parent, that the caller may not change
	const holding = yield* holders(
		e.db,
		[
			[collection, id],
			...[...(cat.models.get(collection)?.one ?? [])].flatMap(([fk, one]) =>
				m.relationships[`${collection}.${fk}`]?.owned && typeof row[fk] === 'string'
					? [[one.targets[0]!, String(row[fk])] as const]
					: []
			)
		],
		authority.actor
	);
	if (holding.some((h) => !h.eligible || h.readGuarded)) restrictions.push('underApproval');
	const remote =
		readOnlySync(m, collection) === undefined
			? []
			: Object.keys(model.fields).filter(
					(field) => !(spec.update?.input.columns ?? []).includes(field)
				);
	const state = stateField(m, collection);
	const stateKind = state === undefined ? undefined : model.fields[state];
	const transitions =
		stateKind?.kind === 'state' ? (stateKind.states[String(row[state ?? ''])]?.to ?? []) : [];
	const moves =
		state === undefined
			? []
			: transitions.filter((next) =>
					admitMove(authority, collection, state, String(row[state]), next)
				);
	const fields: Record<
		string,
		{
			writable: boolean;
			proposal: boolean;
			reasons: readonly RecordRestriction[];
		}
	> = {};
	const readArms = authority.collections[collection]?.read ?? [];
	for (const field of Object.keys(visible)) {
		if (
			model.fields[field] === undefined &&
			model.computed?.[field] === undefined &&
			m.relationships[`${collection}.${field}`] === undefined
		)
			continue;
		if (
			!authority.admin &&
			readArms.length > 0 &&
			!readArms.some((arm) => arm.fields === 'all' || arm.fields.includes(field))
		)
			continue;
		const value = visible[field];
		if (Predicate.isObject(value) && value['$masked'] === true) continue;
		const mask = authority.admin ? undefined : authority.collections[collection]?.masks[field];
		if (mask !== undefined && !evaluate(env, collection, mask, row)) continue;
		const reasons = [...restrictions, ...parentReasons];
		if (
			updateInput === undefined ||
			!updateInput.columns.includes(field) ||
			(!authority.admin &&
				!via('update') &&
				judgePre(authority, env, collection, 'update', row, [field]) !== true)
		)
			reasons.push('noGrant');
		if (remote.includes(field)) reasons.push('syncOwned');
		if (m.relationships[`${collection}.${field}`]?.owned) reasons.push('ownedParent');
		if (field === state) {
			if (moves.length === 0) reasons.push(transitions.length === 0 ? 'stateLocked' : 'noGrant');
		} else if (modelRules(env, m, collection, row, { [field]: row[field] ?? null })?.code === 'locked')
			reasons.push('stateLocked');
		const proposal =
			updateInput !== undefined &&
			updateInput.columns.includes(field) &&
			parentAdmits &&
			reasons.every((reason) => reason === 'noGrant') &&
			((parentPermission?.proposal === true &&
				(via('update') ||
					authority.admin ||
					judgePre(authority, env, collection, 'update', row, [field]) === true)) ||
				approvalArms(env, collection, 'update', row, [field]).length > 0);
		fields[field] = { writable: reasons.length === 0, proposal, reasons: [...new Set(reasons)] };
	}
	for (const relation of Object.keys(spec.update?.input.with ?? {})) {
		const exposed = spec.read.relations ?? (spec.read.fields === 'all' ? 'all' : []);
		if (
			!cat.models.get(collection)?.many.has(relation) ||
			(exposed !== 'all' && !exposed.includes(relation)) ||
			(!authority.admin &&
				!readArms.some((arm) => arm.fields === 'all' || arm.fields.includes(relation)))
		)
			continue;
		const mask = authority.admin ? undefined : authority.collections[collection]?.masks[relation];
		if (mask !== undefined && !evaluate(env, collection, mask, row)) continue;
		const reasons = [...restrictions];
		if (
			!authority.admin &&
			judgePre(authority, env, collection, 'update', row, [relation]) !== true
		)
			reasons.push('noGrant');
		if (modelRules(env, m, collection, row, { [relation]: null })?.code === 'locked')
			reasons.push('stateLocked');
		fields[relation] = {
			writable: reasons.length === 0,
			proposal:
				reasons.every((reason) => reason === 'noGrant') &&
				approvalArms(env, collection, 'update', row, [relation]).length > 0,
			reasons: [...new Set(reasons)]
		};
	}
	const updateReasons = [...restrictions, ...parentReasons];
	const nested = parent === undefined ? Object.keys(spec.update?.input.with ?? {}) : [];
	const nestedWrite =
		spec.update !== undefined &&
		nested.some(
			(relation) =>
				modelRules(env, m, collection, row, { [relation]: null }) === null &&
				judgePre(authority, env, collection, 'update', row, [relation]) === true
		);
	const nestedProposal =
		spec.update !== undefined &&
		nested.some(
			(relation) =>
				modelRules(env, m, collection, row, { [relation]: null }) === null &&
				approvalArms(env, collection, 'update', row, [relation]).length > 0
		);
	if (!Object.values(fields).some((field) => field.writable) && !nestedWrite)
		updateReasons.push('noGrant');
	const deleteReasons = [...restrictions, ...parentReasons];
	if (
		!deleteInput ||
		(!authority.admin &&
			!via('delete') &&
			judgePre(authority, env, collection, 'delete', row, []) !== true)
	)
		deleteReasons.push('noGrant');
	const proposalMoves =
		state !== undefined && fields[state]?.proposal ? { [state]: transitions } : {};
	return {
		collection,
		id,
		revision: row['revision'],
		fields,
		update: {
			allowed: updateReasons.length === 0,
			proposal:
				restrictions.length === 0 &&
				(Object.values(fields).some((field) => field.proposal) || nestedProposal),
			reasons: [...new Set(updateReasons)]
		},
		delete: {
			allowed: deleteReasons.length === 0,
			proposal:
				deleteInput &&
				parentAdmits &&
				deleteReasons.every((reason) => reason === 'noGrant') &&
				((parentPermission?.proposal === true &&
					(via('delete') ||
						authority.admin ||
						judgePre(authority, env, collection, 'delete', row, []) === true)) ||
					approvalArms(env, collection, 'delete', row, []).length > 0),
			reasons: [...new Set(deleteReasons)]
		},
		moves: state !== undefined && fields[state]?.writable ? { [state]: moves } : {},
		proposalMoves
	};
});
const resolveUpserts = Effect.fn('Bolt.resolveUpserts')(function* (
	db: TenantDb,
	m: EngineManifest,
	upserts: readonly Item[]
) {
	const found = new Map<Item, RowData>();
	const byTable = Map.groupBy(upserts, (i) => i.change.collection);
	if (byTable.size === 0) return found;
	const tables = [...byTable.keys()];
	const cat = catalogOf(m);
	const raw = yield* readComposed(
		db,
		tables.map((t) => {
			const on = (
				byTable.get(t)![0]!.change as {
					on: readonly string[];
				}
			).on; // hook:integrations — the act's own key
			return composable({
				text: `SELECT DISTINCT ${exactRowSql(cat, t, 't')} AS j FROM ${q(t)} t JOIN jsonb_populate_recordset(${nullRowSql(t, cat.models.get(t)?.fields.keys() ?? [])}, $1::jsonb) r
			ON ${on.map((f) => `t.${q(f)} IS NOT DISTINCT FROM r.${q(f)}`).join(' AND ')}`,
				params: [
					JSON.stringify(
						byTable.get(t)!.map((i) =>
							Object.fromEntries(
								on.map((f) => [
									f,
									databaseValue(
										(
											i.change as {
												values: RowData;
											}
										).values[f] ?? null,
										cat.models.get(t)?.fields.get(f)
									)
								])
							)
						)
					)
				]
			});
		})
	);
	const res = raw.map((x, i) => ({
		...x,
		rows: x.rows.map((row) => exactRow(cat, tables[i]!, row['j']!))
	}));
	tables.forEach((t, i) => {
		const on = (
			byTable.get(t)![0]!.change as {
				on: readonly string[];
			}
		).on;
		const indexed = new Map(
			res[i]!.rows.map((row) => [canonical(on.map((field) => String(row[field] ?? null))), row])
		);
		for (const it of byTable.get(t)!) {
			const v = (
				it.change as {
					values: RowData;
				}
			).values;
			const row = indexed.get(
				canonical(on.map((field) => String(databaseValue(v[field] ?? null))))
			);
			if (row !== undefined) found.set(it, row);
		}
	});
	return found;
});
const validateCustom = Effect.fn('Bolt.validateCustom')(function* (
	e: WriteEngine,
	r: ActRequest,
	writes: readonly {
		write: Write;
		item: Item;
	}[]
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
			const spec = m.models[w.collection]?.fields[f] as
				| {
						kind: string;
						of?: string;
						many?: true;
				  }
				| undefined;
			if (
				spec?.kind !== 'custom' ||
				v === null ||
				(
					m.customFields[spec.of!] as
						| {
								check?: true;
						  }
						| undefined
				)?.check !== true
			)
				continue;
			const values = byKind.get(spec.of!) ?? byKind.set(spec.of!, []).get(spec.of!)!;
			for (const x of spec.many && EffectArray.isArray<typeof v>(v) ? v : [v])
				values.push({ value: x, path: [...item.change.path, f] });
		}
	}
	for (const [of, values] of byKind) {
		if (e.guest === undefined)
			return yield* Effect.fail(BoltError.make('noGuest', 'guest', 'this host runs no guest code'));
		const b = r.bindings;
		const g = yield* e.guest.invoke(
			{
				id: `${r.invocationId}:validate:${of}`,
				kind: 'validation',
				target: of,
				input: values.map((x) => x.value),
				ctx: {
					actor: r.authority.actor,
					now: b.now,
					today: b.today,
					tz: b.tz,
					seed: r.invocationId
				},
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
							error: { kind: 'bolt', code: 'noBridge', message: 'a validation reads nothing' }
						}))
					)
			}
		);
		if (g.kind === 'failed') return yield* guestFailure(g.error);
		if (g.kind === 'refused') return refused('invalidInput', g.message, values[0]!.path);
		const out = EffectArray.isArray<typeof g.output>(g.output) ? g.output : [];
		const i = out.findIndex((x) => typeof x === 'string');
		if (i >= 0) return refused('invalidInput', String(out[i]), values[i]!.path);
	}
	return null;
});
/**
 * Rules 42, 72: what a failed guest invocation answers. A throw from tenant code is `internal` (its message reaches
 * members only, rule 32); a budget keeps its own code; anything else is a platform fault, thrown with its cause (72a).
 */
function guestFailure(error: BoltError): Effect.Effect<Outcome, BoltError> {
	switch (error.code) {
		case 'guestError':
		case 'internal':
			return Effect.succeed(refused('internal', error.message));
		case 'readBudgetExceeded':
		case 'cpuBudget':
		case 'crossingBudget':
		case 'memory':
		case 'tooLarge':
			return Effect.succeed(refused(error.code, error.message));
		default:
			return Effect.fail(error);
	}
}
const dryRun = Effect.fn('Bolt.dryRun')(function* (
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
					Effect.mapError((error) => BoltError.make('badAnswer', 'commit', error.message, error)),
					Effect.map((answer) => answer.outcome ?? refused('refused', 'The outcome was lost.'))
				)
			),
			Effect.catch((error) =>
				error instanceof BoltError
					? Effect.fail(error)
					: Effect.try({
							try: () => decided(error, meta).outcome,
							catch: (cause) =>
								cause instanceof BoltError
									? cause
									: BoltError.make('bug', 'commit', String(cause), cause)
						})
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
	const reader = readEngine({
		db: recorded.db,
		manifest,
		delegate: {
			history: (read, who, bindings) =>
				read.kind === 'history'
					? readHistory(recorded.db, manifest, read, who, bindings)
					: Effect.fail(BoltError.make('invalid', 'decode', 'Expected a history read.'))
		}
	});
	const bindings: Bindings = {
		now: invocation.ctx.now,
		today: invocation.ctx.today,
		tz: invocation.ctx.tz,
		params: {}
	};
	return {
		tables: () => [...tables],
		fingerprints: recorded.fingerprints,
		cross: (calls) =>
			Effect.gen(function* () {
				type ReadCall = Extract<Parameters<Bridge['cross']>[0][number], { _tag: 'read' }>;
				const groups = new Map<
					string,
					{ params: Bindings['params']; reads: { index: number; read: ReadCall['read'] }[] }
				>();
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
					const key = canonical([call.params, scope ?? index]);
					let group = groups.get(key);
					if (group === undefined) {
						group = { params: call.params, reads: [] };
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
								{ ...bindings, params: group.params }
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
			approval: approvalHook(manifest, db),
			committed: (answer, outcome) =>
				committed(answer, outcome).pipe(
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
										action: `${request.collection}.${request.verb}`,
										actor: auditActor(request.authority.actor),
										invocation: request.invocationId,
										outcomeKey: operation.key,
										digest: operation.digest,
										payload: encodeWire({
											input: request.input,
											observed: request.observed,
											onConflict: request.onConflict
										})
									},
									work
								);
						const v =
							request.verb === 'erase' && result.outcome.kind === 'committed'
								? live.syncChanged('approval_request')
								: yield* live.v;
						return { ...result, v };
					})
				).pipe(Effect.provideService(Audit, audit))
		};
	})
);
