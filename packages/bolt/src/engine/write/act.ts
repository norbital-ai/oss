// The act pipeline (rule 19), in rule order: rate admission → decode → marked-retry lookup → the caller judged once on
// the submitted shape → observed-revision checks → one transform invocation → defaults, upsert resolution and
// model rules → post-image scope and the approval route → one write statement (rule 20), or the outcome record.
import type { Json } from '../../decl/values.ts';
import { Outcome as OutcomeSchema } from '../../protocol/schema.ts';
import type {
	RecordCapabilities,
	RecordRestriction,
	RecordParentContext
} from '../../protocol/record-contracts.ts';
import type {
	ApprovalRoute,
	Arm,
	Authority,
	Bindings,
	CrossAnswer,
	Invocation,
	InputPath,
	Lock,
	NoticeRow,
	Outcome,
	RowData,
	Sql,
	WriteArm
} from '../contracts.ts';
import type { Pred } from '../../protocol/ir-types.ts';
import type { Bridge } from '../services.ts';
import { layered, type EngineManifest } from '../manifest.ts';
import type { GuestShape as GuestPort } from '../services.ts';
import type { TenantDbShape as TenantDb } from '../db/tenant-db.ts';
import { LIMITS } from '../contracts.ts';
import { SerializationReplay, type EngineError } from '../errors.ts';
import { BoltError } from '../../protocol/errors.ts';
import { admitMove, readScope } from '../access/authority.ts';
import { catalogOf, toPred } from '../access/pred.ts';
import { approvalHook } from '../approvals/approvals.ts';
import { readHistory } from '../query/history.ts';
import type { ApprovalMatchData } from '../approvals/configuration.ts';
import { holders } from '../approvals/lock.ts';
import { matches } from '../approvals/route.ts';
import { Effect, Layer, Predicate, Schema } from 'effect';
import {
	Activation,
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
import { TenantDb as TenantDbService, TenantTx } from '../db/tenant-db.ts';
export type { ActRequest, ActResult } from '../services.ts';
import { q, type Catalog } from '../../protocol/catalog.ts';
import { evaluate, type EvalEnv } from '../query/eval.ts';
import { compileGets } from '../query/sql.ts';
import { coalescing, memoReads, readComposed, readEngine } from '../query/engine.ts';
import { composable } from '../query/sql.ts';
import { constraintIndex, type ConstraintMeta } from '../schema/ddl.ts';
import { schemaSlice } from '../schema/plan.ts';
import {
	compileCommit,
	compileOutcomeRecord,
	committed,
	CommitAnswer,
	type Commit,
	type OwnedLock,
	type Write
} from './commit.ts';
import { changed, Flattener, modelKey, withDefaults, type Item, type Sel } from './flatten.ts';
import {
	canonical,
	Chain,
	decided,
	KEY_REUSE,
	minter,
	sha256Hex,
	databaseValue,
	fingerprinting,
	type Fingerprint
} from './sql.ts';
import { prospectiveBridge, retainsPrepared } from './prospective.ts';
import { replayOnce } from './replay.ts';
import { erase } from './erase.ts';
import { collectionNotices } from '../notifications/rules.ts';
import { importPlan, importRefs, type ImportPlan } from './import.ts';
import { embedQueued, embedWrites } from '../integrations/embed.ts'; // hook:integrations
import { fedOf } from '../integrations/feeds.ts';
import { instanceTransform } from '../integrations/instances.ts';
import { SYSTEM } from '../../system/index.ts';
/** The generated verbs (X-24): `import` (rule 30) and `erase` (rule 38e) included. */
type Obj = {
	readonly [k: string]: Json;
};
export type Verb = 'create' | 'update' | 'delete' | 'upsert' | 'import' | 'erase';
/** Rules 44–46 (P3): the approval flow's hook point. The write area only calls it. */
export interface ApprovalHook {
	/**
	 * A denied write whose source routes match commits at once and opens a request: its route snapshot and the pieces
	 * that persist it (and its notices) in the same statement. Direct grants bypass this hook.
	 */
	route(act: {
		collection: string;
		record: string;
		action: 'create' | 'update' | 'delete';
		authority: Authority;
		bindings: Bindings;
		/** Retry-stable request id seed: the invocation and its key. */
		seed: string;
		routes: readonly ApprovalRoute[];
		/** The root collection's rows as written, for the notices' recipients. */
		records: readonly { id: string; action: string; values: RowData }[];
	}): Effect.Effect<NonNullable<Commit['approval']> | Outcome, EngineError>;
}
export type WriteEngine = {
	log?: InvocationEvents;
	committed?: (
		answer: Pick<CommitAnswer, 'captured' | 'next_due' | 'changed_instances'>,
		outcome?: Outcome
	) => Effect.Effect<number>;
	manifest: EngineManifest;
	db: TenantDb;
	/** Collections that attach a transform body (the manifest strips bodies). */
	transforms?: ReadonlySet<string>;
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
	feed?:
		| Extract<
				ActMode,
				{
					_tag: 'Feed';
				}
		  >
		| undefined;
	sink?:
		| Extract<
				ActMode,
				{
					_tag: 'Record';
				}
		  >['sink']
		| undefined;
	pending?: ReadonlyMap<string, RowData> | undefined;
	delivery: boolean;
};
export const modeContext = (mode: ActMode): ModeContext => {
	switch (mode._tag) {
		case 'Direct':
			return { delivery: mode.delivery === true };
		case 'Feed':
			return { feed: mode, delivery: true };
		case 'Record':
			return { sink: mode.sink, pending: mode.pending, delivery: false };
	}
};
const constraints = new WeakMap<EngineManifest, ReadonlyMap<string, ConstraintMeta>>();
export const constraintsOf = (m: EngineManifest): ReadonlyMap<string, ConstraintMeta> => {
	let c = constraints.get(m);
	if (c === undefined) constraints.set(m, (c = constraintIndex(schemaSlice(m))));
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
	const { feed, sink, pending } = modeContext(r.mode);
	const auth = feed ? { ...r.authority, admin: true } : r.authority; // hook:integrations — no grant admits a feed's page
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
		feed
			? { columns: feed.fields } // hook:integrations
			: r.verb === 'update'
				? spec.update?.input
				: r.verb === 'delete'
					? spec.delete && { columns: [] }
					: spec.create?.input
	) as Sel | undefined;
	const key0 = modelKey(m, r.collection);
	// rule 28: an upsert names its record by `id` (a feed's by the model key), so it needs both arms
	const byId = r.verb === 'upsert' && !feed;
	if (
		sel === undefined ||
		(r.verb === 'upsert' &&
			(r.onConflict === undefined || (byId ? spec.update === undefined : key0.length === 0)))
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
	if (missing >= 0)
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
				f.create(r.collection, sel, row, path);
				upserted.push(f.items[at]?.change.id ?? null);
			} else {
				upserted.push(id);
				if (r.onConflict === 'update')
					f.update(
						r.collection,
						spec.update!.input as Sel,
						id,
						row,
						r.observed?.[id] ?? null,
						path
					);
			}
		} else if (r.verb === 'upsert')
			f.create(r.collection, sel, x, path, undefined, { on: key0, onConflict: r.onConflict! });
		else if (r.verb === 'update')
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
	feed?.removals.forEach((x, i) =>
		'set' in x
			? f.update(r.collection, sel, x.target, x.set, null, ['removed', i])
			: f.delete(r.collection, x.target, null, ['removed', i])
	);
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
	const owned = feedOwnership(m, r, f.items); // hook:integrations
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
	const transforms = e.transforms?.has(r.collection) === true;
	const matching =
		imp !== undefined && transforms
			? resolveUpserts(
					own,
					m,
					f.items.filter((i) => i.parent === undefined && i.change.op === 'upsert')
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
	// the host reads (rule 20's `a`): every existing row the input names and every ref it supplies, and — when the
	// collection's transform will see them — the root rows in wire form (an import's matched ones too): one round
	// trip, one statement
	const wireIds = !transforms
		? []
		: [
				...new Set([
					...f.items
						.filter(
							(i) =>
								i.parent === undefined &&
								i.change.collection === r.collection &&
								(i.change.op === 'update' || i.change.op === 'delete')
						)
						.map((i) => i.change.id),
					...[...matched.values()].map((row) => String(row['id']))
				])
			];
	const wired = wireRows(own, cat, r.collection, wireIds, b).pipe(
		Effect.map(
			(rows) =>
				new Map(rows.flatMap((row, i) => (row === null ? [] : [[wireIds[i]!, row] as const])))
		)
	);
	const visibility = new Map<string, boolean>();
	const scope = { authority: auth, bindings: b, visibility };
	const [wiredRows, pre] = yield* Effect.all(
		[
			wired,
			readRows(
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
					...f.items.flatMap((i) => i.refs.map((x) => [x.to, x.id] as const))
				],
				scope
			)
		],
		{ concurrency: 'unbounded' }
	);
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
					(auth.collections[change.collection]?.[operation] ?? []).length > 0 ||
					(auth.collections[change.collection]?.approval?.[operation] ?? []).length > 0
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
			(it.parent !== undefined &&
				(auth.collections[c.collection]?.[action] ?? []).length === 0 &&
				(auth.collections[c.collection]?.approval?.[action] ?? []).length === 0)
		)
			continue; // `via` the parent
		const supplied = suppliedChanges(it, row ?? null);
		const verdict = judgePre(auth, env, c.collection, action, row ?? null, supplied);
		if (action === 'update' && supplied.length === 0 && verdict !== true)
			return none(refused('forbidden', 'You may not make this change.', c.path));
		const candidates = candidateRoutes(m, env, c.collection, action, row ?? null, supplied);
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
				wiredRows,
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
				return none(
					planned.commit.approval
						? { kind: 'pendingApproval', requestId: planned.commit.approval.requestId, records }
						: { kind: 'committed', output: planned.commit.output, records }
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
				const rows = yield* e.db.returning(
					CommitAnswer,
					compileCommit(m, cat, { ...planned.commit, ...common }),
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
	const matching = (match: ApprovalMatchData | undefined): Pred[] =>
		match === undefined
			? []
			: [
					...(match.record === undefined ? [] : [toPred(m, c, match.record)]),
					...(match.previous === undefined ? [] : [toPred(m, c, match.previous)]),
					...(match.and ?? []).flatMap(matching),
					...(match.or ?? []).flatMap(matching),
					...matching(match.not)
				];
	const proposals = operations
		.flatMap((operation) => (operation === 'read' ? [] : (a?.approval?.[operation] ?? [])))
		.flatMap((route) => [
			...(route.where === undefined ? [] : [toPred(m, c, route.where)]),
			...(route.previous === undefined ? [] : [toPred(m, c, route.previous)]),
			...matching(route.match)
		]);
	const arms = operations.flatMap((operation) => a?.[operation] ?? []);
	return [
		...arms.flatMap(
			(
				x: Arm & {
					previous?: Pred;
				}
			) => [...walk(x.where), ...(x.previous === undefined ? [] : walk(x.previous))]
		),
		...proposals.flatMap(walk)
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
				text: `SELECT ${exactRowSql(cat, path[d]![1], `t${d}`)} AS j FROM ${q(path[0]![1])} t0 JOIN jsonb_populate_recordset(null::${q(path[0]![1])}, $1::jsonb) r ON t0.id = r.id ${joins}`,
				params: [JSON.stringify([...ids].map((id) => ({ id })))]
			};
		})
	);
	if (statements.length === 0) return new Map();
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
	return Array.isArray(t) ? t.map((target) => ({ ...(input as object), target })) : [input];
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
			routes: readonly ApprovalRoute[];
	  }
	| {
			ok: false;
			field?: string;
	  } {
	const is = (p: Parameters<typeof evaluate>[2], row: RowData | null) =>
		row !== null && evaluate(env, c, p, row);
	const scoped = (env.authority!.collections[c]?.[o] ?? []).filter((a) =>
		o === 'create'
			? is(a.where, post)
			: o === 'delete'
				? is(a.where, pre)
				: is(a.previous ?? a.where, pre) && is(a.where, post)
	);
	if (scoped.length === 0) return { ok: false };
	const admits = (a: WriteArm, f: string) => a.fields === 'all' || a.fields.includes(f);
	const field = supplied.find((f) => !scoped.some((a) => admits(a, f)));
	return field !== undefined ? { ok: false, field } : { ok: true, routes: [] };
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
/** Candidate admission is advisory until the final post-image and match are known. */
export function candidateRoutes(
	m: EngineManifest,
	env: EvalEnv,
	collection: string,
	operation: 'create' | 'update' | 'delete',
	row: RowData | null,
	supplied: readonly string[]
): readonly ApprovalRoute[] {
	const auth = env.authority;
	if (auth == null) return [];
	if (
		row !== null &&
		supplied.some((field) => {
			const mask = auth.collections[collection]?.masks[field];
			return mask !== undefined && !evaluate(env, collection, mask, row);
		})
	)
		return [];
	return (auth.collections[collection]?.approval?.[operation] ?? []).filter(
		(route) =>
			(route.fields === undefined || supplied.every((field) => route.fields?.includes(field))) &&
			(operation === 'create' ||
				(row !== null &&
					((route.previous ?? route.where) === undefined ||
						evaluate(env, collection, toPred(m, collection, route.previous ?? route.where), row))))
	);
}
function proposalRoute(
	m: EngineManifest,
	env: EvalEnv,
	w: Write,
	pre: RowData | null,
	supplied: readonly string[]
): ApprovalRoute | undefined {
	const auth = env.authority;
	if (auth == null) return undefined;
	const post =
		w.op === 'create' ? { ...w.values, id: w.id } : w.op === 'update' ? { ...pre, ...w.set } : null;
	const row = {
		op: w.op,
		pre,
		post,
		changed: w.op === 'create' ? Object.keys(w.values) : w.op === 'update' ? Object.keys(w.set) : []
	};
	const image = post ?? pre;
	return candidateRoutes(m, env, w.collection, w.op, w.op === 'create' ? post : pre, supplied).find(
		(route) =>
			(route.where === undefined ||
				(image !== null &&
					evaluate(env, w.collection, toPred(m, w.collection, route.where), image))) &&
			matches(m, w.collection, env.bindings, auth, route.match, row, env)
	);
}
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
			o === 'create' || (row !== null && evaluate(env, collection, a.previous ?? a.where, row))
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
				text: `SELECT ${exactRowSql(cat, t, 't')} AS j FROM ${q(t)} t JOIN jsonb_populate_recordset(null::${q(t)}, $1::jsonb) r ON t.id = r.id`,
				params: [
					JSON.stringify([...new Set(byTable.get(t)!.map(([, id]) => id))].map((id) => ({ id })))
				]
			})
		),
		...checks.map((table) => {
			if (scope === undefined)
				throw BoltError.make('internal', 'admission', 'read visibility requires its caller scope');
			const ids = [
				...new Set(want.filter(([collection]) => collection === table).map(([, id]) => id))
			];
			for (const id of ids) scope.visibility.set(k(table, id), false);
			return composable(
				compileGets(
					cat,
					table,
					ids,
					{ fields: ['id'], relations: {} },
					{ as: 'caller', authority: scope.authority },
					scope.bindings
				)
			);
		})
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
	wired: ReadonlyMap<string, RowData> = new Map(),
	own: TenantDb = e.db,
	visibility = new Map<string, boolean>()
): Effect.fn.Return<Planned, EngineError> {
	const { feed, delivery } = modeContext(r.mode);
	const m = e.manifest,
		auth = env.authority!,
		b = r.bindings,
		cat = env.cat; // hook:integrations — the act's judged authority
	let items = submitted,
		readTables: readonly string[] = [],
		fingerprints: readonly Fingerprint[] = [];
	const identities = new Map(
		submitted.map((item) => [
			JSON.stringify([item.change.collection, item.change.path]),
			item.change.id
		])
	);
	const preparedCreates = new Map<string, Item>();
	const guardsDeletes =
		m.collections[r.collection]?.delete !== undefined &&
		'transform' in m.collections[r.collection]!.delete!;
	const deleteGuard = r.verb === 'delete' && guardsDeletes;
	// an import's pruned rows face the delete guard too: they are `{ $delete: true }` inputs after the batch's rows
	const pruneGuard = imp?.prune !== undefined && guardsDeletes;
	// a feed page's one transform sees its upserts and its `removed` patches; a page of deletes alone has no row for it (hook:integrations)
	const runs =
		e.transforms?.has(r.collection) === true &&
		(r.verb !== 'delete' || deleteGuard) &&
		(feed === undefined ||
			submitted.some((i) => i.parent === undefined && i.change.op !== 'delete'));
	// 6. one transform invocation over the whole batch (rule 27); its payload is the workspace's own work (rule 19)
	if (runs) {
		if (e.guest === undefined)
			return yield* Effect.fail(BoltError.make('noGuest', 'guest', 'this host runs no guest code'));
		// an import's pruned rows are deletes beside the batch, inputs of it only when the collection guards its deletes
		const roots = submitted.filter(
			(i) =>
				i.parent === undefined && (r.verb === 'delete' || pruneGuard || i.change.op !== 'delete')
		);
		const inputs = imp?.rows ?? list(r.input, r.verb);
		// an import's rows matched by key reach the transform with the stored rows they would update (its guards see them)
		const matched =
			imp === undefined
				? new Map<Item, RowData>()
				: yield* resolveUpserts(
						own,
						m,
						roots.filter((i) => i.change.op === 'upsert')
					);
		const invocation: Invocation = {
			id: r.invocationId,
			kind: 'transform',
			target: r.collection,
			input: roots.map((it, i) => {
				// a feed's `removed` patch (path `['removed', n]`, after the page's upserts) is the update it is, its stored row in `existing`
				const input =
					it.change.op === 'delete'
						? { $delete: true }
						: feed !== undefined && it.change.op === 'update'
							? (
									feed.removals[Number(it.change.path[1])] as {
										set: RowData;
									}
								).set
							: r.verb === 'update'
								? (
										inputs[i] as {
											set: Json;
										}
									).set
								: inputs[i]!;
				return r.verb === 'upsert' && feed === undefined && Predicate.isObject(input)
					? Object.fromEntries(Object.entries(input).filter(([field]) => field !== 'id'))
					: input;
			}),
			ctx: {
				actor: auth.actor,
				policies: auth.policies,
				admin: auth.admin,
				now: b.now,
				today: b.today,
				tz: b.tz,
				seed: r.invocationId,
				staged: submitted.map((item) => ({
					collection: item.change.collection,
					id: item.change.id,
					path: item.change.path,
					operation: item.change.op,
					...(item.parent === undefined
						? {}
						: {
								parent: {
									collection: item.parent.collection,
									id: item.parent.id,
									relation: item.parent.rel,
									field: item.parent.fk
								}
							})
				})),
				existing: yield* Effect.fnUntraced(function* () {
					const ids = roots.map((it) =>
						pre.has(k(it.change.collection, it.change.id))
							? it.change.id
							: matched.has(it)
								? String(matched.get(it)!['id'])
								: null
					);
					// the root rows read with `pre`; only an import's key-matched rows are read here
					return ids.some((id) => id !== null && !wired.has(id))
						? yield* wireRows(e.db, cat, r.collection, ids, b)
						: ids.map((id) => (id === null ? null : (wired.get(id) ?? null)));
				})()
			},
			budget: {
				cpuMs: LIMITS.guestCpuMs,
				crossings: LIMITS.crossings.sync,
				readBytes: LIMITS.readBytes
			}
		};
		const originalBridge = e.bridge?.(invocation, own) ?? {
			cross: (calls: Parameters<Bridge['cross']>[0]) =>
				Effect.succeed(
					calls.map((): CrossAnswer => ({
						ok: false,
						error: {
							kind: 'bolt',
							code: 'noBridge',
							message: 'this host gives the transform no reads'
						}
					}))
				)
		};
		const bridge = prospectiveBridge(
			e,
			r,
			env,
			submitted,
			pre,
			own,
			identities,
			preparedCreates,
			originalBridge
		);
		const g = yield* e.guest.invoke(invocation, bridge);
		readTables = bridge.tables?.() ?? [];
		fingerprints = bridge.fingerprints?.() ?? [];
		if (g.kind === 'refused')
			return {
				guest: true,
				outcome: {
					kind: 'refused',
					code: 'refused',
					message: g.message,
					rule: `${r.collection}.transform`,
					...(g.field === undefined ? {} : { field: g.field })
				}
			};
		if (g.kind === 'failed') return { guest: true, outcome: yield* guestFailure(g.error) };
		if (r.verb !== 'delete') {
			const out = g.output;
			if (!Array.isArray(out) || out.length !== roots.length)
				return yield* Effect.fail(
					BoltError.make('transformShape', 'guest', 'a transform returns one payload per input')
				);
			// a row the transform adds mints from its own seed: the invocation's seed would replay the sequence the
			// submitted paths took, so a child added before a later root would take that root's id
			const again = new Flattener(m, cat, minter(`${r.invocationId}:transform`, b.now), identities);
			roots.forEach((it, i) => {
				const c = it.change;
				if (c.op === 'delete') return;
				if (c.op === 'update') again.update(c.collection, 'any', c.id, out[i], c.revision, c.path);
				else
					again.create(
						c.collection,
						'any',
						out[i],
						c.path,
						undefined,
						c.op === 'upsert' ? { on: c.on, onConflict: c.onConflict } : undefined
					);
			});
			if (again.problems.length > 0)
				return yield* Effect.fail(
					BoltError.make(
						'transformPayload',
						'guest',
						again.problems.map((p) => `${p.path.join('.')}: ${p.message}`).join('; ')
					)
				);
			for (const item of again.items) {
				const assigned = identities.get(JSON.stringify([item.change.collection, item.change.path]));
				if (assigned !== undefined && assigned !== item.change.id)
					return yield* Effect.fail(
						BoltError.make(
							'transformIdentity',
							'guest',
							'a transform must preserve the engine-assigned identity of each submitted native path'
						)
					);
			}
			// the same id twice in one act would commit unnoticed; the disjoint seed above makes this unreachable, and this keeps it so
			const reservedIds = new Set(identities.values());
			if (
				again.items.some(
					(item) =>
						!identities.has(JSON.stringify([item.change.collection, item.change.path])) &&
						reservedIds.has(item.change.id)
				)
			)
				return yield* Effect.fail(
					BoltError.make(
						'transformIdentity',
						'guest',
						"a transform must preserve the engine-assigned identity of each submitted native path: a row it adds would take another path's identity"
					)
				);
			for (const [token, reservation] of preparedCreates) {
				const final = again.items.find(
					(item) => JSON.stringify([item.change.collection, item.change.path]) === token
				);
				const values =
					final?.change.op === 'create'
						? final.change.values
						: final?.change.op === 'update'
							? final.change.set
							: null;
				const reserved =
					reservation.change.op === 'create'
						? reservation.change.values
						: reservation.change.op === 'update'
							? reservation.change.set
							: null;
				if (
					final === undefined ||
					final.change.op !== reservation.change.op ||
					final.change.id !== reservation.change.id ||
					!retainsPrepared(values, reserved)
				)
					return {
						guest: true,
						outcome: refused(
							'internal',
							'every prepared native action must retain its reserved operation, identity and values at its reserved path'
						)
					};
			}
			// the caller's supplied fields are what grants admit; the transform's own additions need no `fields` entry (rule 35)
			const supplied = new Map(submitted.map((s) => [s.change.path.join('.'), s.supplied]));
			items = [
				...again.items.map((it) => ({
					...it,
					supplied: supplied.get(it.change.path.join('.')) ?? []
				})),
				...submitted.filter(
					(i) => i.parent === undefined && (!roots.includes(i) || i.change.op === 'delete')
				)
			];
			const more = yield* readRows(
				e.db,
				cat,
				items.flatMap((i) =>
					i.change.op === 'update' || i.change.op === 'delete'
						? pre.has(k(i.change.collection, i.change.id))
							? []
							: [[i.change.collection, i.change.id] as const]
						: []
				)
			);
			for (const [key, row] of more) pre.set(key, row);
		}
	}
	// sys_integration's transform is the engine's: it reads the manifest's definitions and envoys
	if (r.collection === 'sys_integration') {
		const t = instanceTransform(m, items, (id) => pre.get(k(r.collection, id)));
		if ('kind' in t) return { guest: false, outcome: t };
		items = [...t];
	}
	// a fed collection's rows change as its feed writes them, whatever the transform added (hook:integrations)
	const owned = feedOwnership(m, r, items);
	if (owned !== null) return { guest: runs, outcome: owned };
	let guest = runs;
	const stop = (outcome: Outcome): Planned => ({ guest, outcome });
	// 7. upsert resolution read, defaults (rule 23a), model rules (rules 34, 40, 41), no-op updates (rule 29)
	const upserts = items.filter((i) => i.change.op === 'upsert');
	const existing = yield* resolveUpserts(own, m, upserts);
	yield* readRows(
		own,
		cat,
		[...existing].flatMap(([item, row]) =>
			typeof row['id'] === 'string' &&
			databaseReadScope(auth, item.change.collection) &&
			!visibility.has(k(item.change.collection, row['id']))
				? [[item.change.collection, row['id']] as const]
				: []
		),
		{ authority: auth, bindings: b, visibility }
	);
	const writes: {
		write: Write;
		item: Item;
	}[] = [];
	const output: Json[] = [];
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
		if (c.op === 'upsert') {
			const found = existing.get(it);
			if (found !== undefined) {
				if (
					!readableBy(env, c.collection, found, visibility) ||
					(root && imp!.onConflict === 'refuse')
				)
					return stop(refused('unique', 'A record with these values already exists.', c.path));
				output.push(String(found['id']));
				pre.set(k(c.collection, String(found['id'])), found);
				const set =
					c.onConflict === 'keep'
						? {}
						: changed(
								found,
								Object.fromEntries(Object.entries(c.values).filter(([f]) => !c.on.includes(f)))
							);
				// a locked row is locked whatever names it: an upsert by id, by key, or an import's row (rules 30, 40)
				if (feed === undefined) {
					const locked = modelRules(m, c.collection, found, set);
					if (locked !== null && !(delivery && locked.code === 'locked'))
						return stop(refused(locked.code, locked.message, [...c.path, locked.field]));
				}
				if (root)
					report.push({
						index: Number(c.path[0]),
						id: String(found['id']),
						action: Object.keys(set).length > 0 ? 'updated' : 'kept'
					});
				if (Object.keys(set).length > 0)
					writes.push({
						write: {
							collection: c.collection,
							id: String(found['id']),
							op: 'update',
							set,
							revision: Number(found['revision'])
						},
						item: it
					});
				continue;
			}
			// rule 28: a nested upsert by id names a child on file; it never creates one under an id it made up
			if (c.on.length === 1 && c.on[0] === 'id' && feed === undefined)
				return stop(refused('notFound', `No ${c.collection} has this id.`, [...c.path, 'id']));
			// rule 30: `onMissing: 'skip'` only updates rows already on file
			if (root && imp!.onMissing === 'skip') {
				report.push({ index: Number(c.path[0]), id: null, action: 'skipped' });
				continue;
			}
			output.push(c.id);
		}
		if (root)
			report.push({
				index: c.op === 'delete' ? null : Number(c.path[0]),
				id: c.id,
				action: c.op === 'delete' ? 'deleted' : 'created'
			});
		if (c.op === 'create' || c.op === 'upsert') {
			const values = { ...c.values } as Record<string, Json>;
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
			const locked = modelRules(m, c.collection, row, set);
			if (locked !== null && !((delivery || feed !== undefined) && locked.code === 'locked'))
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
				(auth.collections[write.collection]?.[write.op] ?? []).length === 0 &&
				(auth.collections[write.collection]?.approval?.[write.op] ?? []).length === 0
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
	// 8. the admitting grant's post-image scope on the root rows as the engine will write them, then its approval route
	const routed: {
		write: Write;
		pre: RowData | null;
		routes: readonly ApprovalRoute[];
	}[] = [];
	const routes: ApprovalRoute[] = [];
	// A nested-only mutation still needs its parent's declared relationship permission, even when no scalar row changes.
	for (const item of submitted) {
		const change = item.change;
		if (
			auth.admin ||
			item.parent !== undefined ||
			change.op !== 'update' ||
			writes.some(
				(entry) => entry.write.collection === change.collection && entry.write.id === change.id
			)
		)
			continue;
		const row = pre.get(k(change.collection, change.id));
		if (row === undefined) continue;
		const supplied = suppliedChanges(item, row);
		if (judgePost(env, change.collection, 'update', row, row, supplied).ok) continue;
		const write: Write = {
			collection: change.collection,
			id: change.id,
			op: 'update',
			set: {},
			revision: Number(row['revision'])
		};
		const route = proposalRoute(m, env, write, row, supplied);
		if (route === undefined)
			return stop(refused('forbidden', 'You may not make this change.', change.path));
		routes.push(route);
		routed.push({ write, pre: row, routes: [route] });
	}
	for (const { write: w, item } of writes) {
		if (
			auth.admin ||
			(item.parent !== undefined &&
				(auth.collections[w.collection]?.[w.op] ?? []).length === 0 &&
				(auth.collections[w.collection]?.approval?.[w.op] ?? []).length === 0)
		)
			continue;
		const row = pre.get(k(w.collection, w.id)) ?? null;
		const post = w.op === 'create' ? w.values : w.op === 'update' ? { ...row, ...w.set } : null;
		const supplied = suppliedChanges(item, row);
		const verdict = judgePost(env, w.collection, w.op, row, post, supplied);
		const state = stateField(m, w.collection),
			next = w.op === 'update' && state !== undefined ? w.set[state] : undefined;
		const moveDenied =
			state !== undefined &&
			typeof next === 'string' &&
			row !== null &&
			!admitMove(auth, w.collection, state, String(row[state]), next);
		if (verdict.ok && !moveDenied) continue;
		const route = proposalRoute(m, env, w, row, supplied);
		if (route === undefined)
			return stop(
				refused(
					'forbidden',
					'You may not make this change.',
					!verdict.ok && verdict.field !== undefined
						? [...item.change.path, verdict.field]
						: item.change.path
				)
			);
		routes.push(route);
		routed.push({ write: w, pre: row, routes: [route] });
	}
	let approval: Commit['approval'];
	// a routed write opens a request (provisional commit, rules 44–46); one on a record an open request holds joins that
	// request instead — the statement decides both (commit.ts, lock.ts), so the check costs no round trip of its own
	if (!auth.admin && routed.length > 0) {
		if (e.approval === undefined)
			return yield* Effect.fail(
				BoltError.make(
					'noApproval',
					'admission',
					'a grant routes this write to approval, and no approval flow is wired'
				)
			);
		const root =
			writes.find(
				({ item }) => item.parent === undefined && item.change.collection === r.collection
			)?.write ?? routed.find(({ write }) => write.collection === r.collection)?.write;
		if (root === undefined) {
			// no root to open a request on: only a request that already holds a written row admits it
			const held = writes.flatMap(({ write: w }): (readonly [string, string])[] => [
				[w.collection, w.id],
				...[...(cat.models.get(w.collection)?.one ?? [])].flatMap(([fk, one]) => {
					const parent =
						w.op === 'create' ? w.values[fk] : (pre.get(k(w.collection, w.id))?.[fk] ?? null);
					return m.relationships[`${w.collection}.${fk}`]?.owned && typeof parent === 'string'
						? [[one.targets[0]!, parent] as const]
						: [];
				})
			]);
			if ((yield* holders(own, held, auth.actor)).length === 0)
				return stop(refused('forbidden', 'No approval route admits this change.'));
		} else {
			const route = yield* e.approval.route({
				collection: r.collection,
				record: root.id,
				action: r.verb === 'update' ? 'update' : r.verb === 'delete' ? 'delete' : root.op,
				authority: auth,
				bindings: b,
				seed: `${r.invocationId}:${r.key}`,
				routes,
				records: writes
					.filter(({ write }) => write.collection === r.collection)
					.map(({ write: w }) => ({
						id: w.id,
						action: w.op,
						values:
							w.op === 'create'
								? { ...w.values, id: w.id }
								: {
										...pre.get(k(w.collection, w.id)),
										...(w.op === 'update' ? w.set : {}),
										id: w.id
									}
					}))
			});
			if ('kind' in route) return stop(route);
			approval = route;
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
	const tables = [...new Set([...plain.map((w) => w.collection), ...readTables])].sort();
	guest ||= (m.collections[r.collection]?.notifications?.committed ?? []).some(
		(rule) => 'to' in rule && rule.to === true
	);
	const noticed = yield* Effect.result(committedNotices(e, r, auth, routedRows(writes, pre)));
	if (noticed._tag === 'Failure') return stop(yield* guestFailure(noticed.failure));
	const notices = noticed.success;
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
			notices,
			output:
				upserted ?? (r.verb === 'upsert' ? output : imp !== undefined ? { rows: report } : null),
			...(approval === undefined ? {} : { approval }),
			...(guest && fingerprints.length > 0 ? { fingerprints } : {}),
			...(feed === undefined ? {} : { pieces: feed.pieces })
		},
		...(guest && readTables.length > 0
			? { lock: { tables, mode: 'SHARE ROW EXCLUSIVE' as const } }
			: {})
	};
});
/** The act's root rows as written, with the image a `{ user }` recipient reads (the post-image; a delete's stored row). */
const routedRows = (
	writes: readonly {
		write: Write;
		item: Item;
	}[],
	pre: Map<string, RowData>
) =>
	writes
		.filter((x) => x.item.parent === undefined)
		.map(({ write: w }) => ({
			write: w,
			row:
				w.op === 'create'
					? w.values
					: { ...pre.get(k(w.collection, w.id)), ...(w.op === 'update' ? w.set : {}) }
		}));
const committedNotices = (
	e: WriteEngine,
	r: ActRequest,
	auth: Authority,
	rows: readonly {
		write: Write;
		row: RowData;
	}[]
) => {
	const mint = minter(`${r.invocationId}:notices`, r.bindings.now);
	return collectionNotices(e.guest, e.manifest, {
		collection: r.collection,
		event: 'committed',
		records: rows
			.filter((x) => x.write.collection === r.collection)
			.map((x) => ({ id: x.write.id, values: x.row, action: x.write.op })),
		requestor: auth.actor.kind === 'member' ? auth.actor.id : null,
		approvers: [],
		actor: auth.actor,
		bindings: r.bindings,
		id: () => mint()
	});
};
/**
 * hook:integrations (§2.1, §4.1) — a fed collection's rows: its feed's page writes only that collection and only the
 * feed's fields; every other writer, administrators included, only updates its local fields (its `update` columns).
 */
function feedOwnership(m: EngineManifest, r: ActRequest, items: readonly Item[]): Outcome | null {
	const { feed } = modeContext(r.mode);
	const fed = fedOf(m);
	if (fed.size === 0) return null;
	for (const { change: c } of items) {
		const written =
			c.op === 'update'
				? Object.keys(c.set)
				: c.op === 'delete'
					? []
					: Object.keys(c.values).filter((k) => k !== 'id');
		if (feed !== undefined) {
			if (c.collection !== r.collection)
				return refused('forbidden', `A feed writes only ${r.collection}.`, c.path);
			const local = written.find((k) => !feed.fields.includes(k));
			if (local !== undefined)
				return refused(
					'forbidden',
					`'${local}' of ${c.collection} is local: its feed never writes it.`,
					[...c.path, local]
				);
			continue;
		}
		const f = fed.get(c.collection);
		if (f === undefined) continue;
		if (c.op !== 'update')
			return refused(
				'forbidden',
				`${c.collection} is written by its feed ${f.run}; only ${f.local.length === 0 ? 'it' : f.local.join(', ')} changes here.`,
				c.path
			);
		const remote = written.find((k) => !f.local.includes(k));
		if (remote !== undefined)
			return refused(
				'forbidden',
				`'${remote}' of ${c.collection} is written by its feed ${f.run}.`,
				[...c.path, remote]
			);
	}
	return null;
}
/** Rules 34, 40, 41 on an update's changed fields: `to` edges, per-state `edit`, and an owned child's fixed parent key. */
function modelRules(
	m: EngineManifest,
	model: string,
	row: RowData,
	set: RowData
): {
	code: RefusalCode;
	message: string;
	field: string;
} | null {
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
		composable(compileGets(cat, c, want, { fields: null, relations: {} }, { as: 'workspace' }, b))
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
		parent !== undefined &&
		(authority.collections[collection]?.[verb].length ?? 0) === 0 &&
		(authority.collections[collection]?.approval?.[verb].length ?? 0) === 0;
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
	if (holding.some((h) => !h.eligible)) restrictions.push('underApproval');
	const remote = fedOf(m).get(collection)?.fields ?? []; // hook:integrations — the feed's fields
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
		if (remote.includes(field)) reasons.push('integrationOwned');
		if (m.relationships[`${collection}.${field}`]?.owned) reasons.push('ownedParent');
		if (field === state) {
			if (moves.length === 0) reasons.push(transitions.length === 0 ? 'stateLocked' : 'noGrant');
		} else if (modelRules(m, collection, row, { [field]: row[field] ?? null })?.code === 'locked')
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
				candidateRoutes(m, env, collection, 'update', row, [field]).length > 0);
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
		if (modelRules(m, collection, row, { [relation]: null })?.code === 'locked')
			reasons.push('stateLocked');
		fields[relation] = {
			writable: reasons.length === 0,
			proposal:
				reasons.every((reason) => reason === 'noGrant') &&
				candidateRoutes(m, env, collection, 'update', row, [relation]).length > 0,
			reasons: [...new Set(reasons)]
		};
	}
	const updateReasons = [...restrictions, ...parentReasons];
	const nested = parent === undefined ? Object.keys(spec.update?.input.with ?? {}) : [];
	const nestedWrite =
		spec.update !== undefined &&
		nested.some(
			(relation) =>
				modelRules(m, collection, row, { [relation]: null }) === null &&
				judgePre(authority, env, collection, 'update', row, [relation]) === true
		);
	const nestedProposal =
		spec.update !== undefined &&
		nested.some(
			(relation) =>
				modelRules(m, collection, row, { [relation]: null }) === null &&
				candidateRoutes(m, env, collection, 'update', row, [relation]).length > 0
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
					candidateRoutes(m, env, collection, 'delete', row, []).length > 0),
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
				text: `SELECT DISTINCT ${exactRowSql(cat, t, 't')} AS j FROM ${q(t)} t JOIN jsonb_populate_recordset(null::${q(t)}, $1::jsonb) r
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
		for (const it of byTable.get(t)!) {
			const v = (
				it.change as {
					values: RowData;
				}
			).values;
			const row = res[i]!.rows.find((row) =>
				on.every((f) => String(row[f] ?? null) === String(databaseValue(v[f] ?? null)))
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
			for (const x of spec.many && Array.isArray(v) ? v : [v])
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
					cpuMs: LIMITS.guestCpuMs,
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
		const out = Array.isArray(g.output) ? g.output : [];
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
class DryRunRollback extends Schema.TaggedError<DryRunRollback>()('DryRunRollback', {
	outcome: OutcomeSchema
}) {}
const dryRun = Effect.fn('Bolt.dryRun')(function* (
	db: TenantDb,
	sql: Sql,
	lock: Lock | undefined,
	meta: ReadonlyMap<string, ConstraintMeta>
) {
	return yield* db
		.transaction(
			Effect.gen(function* () {
				const tx = yield* TenantTx;
				const rows = yield* tx.query(sql);
				const answer = yield* Schema.decodeUnknownEffect(CommitAnswer)(rows.rows[0]).pipe(
					Effect.mapError((error) => BoltError.make('badAnswer', 'commit', error.message, error))
				);
				return yield* Effect.fail(
					new DryRunRollback({
						outcome: answer.outcome ?? refused('refused', 'The outcome was lost.')
					})
				);
			}),
			lock
		)
		.pipe(
			Effect.catch((error) =>
				error instanceof DryRunRollback
					? Effect.succeed(error.outcome)
					: error instanceof BoltError
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

/** Workspace reads shared by direct writes and verbs recorded inside an action (rules 15, 26). */
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
						message: `a transform cannot ${call._tag}`
					}
				}));
				for (const [index, call] of calls.entries()) {
					if (call._tag !== 'read') continue;
					tables.add(call.read.collection);
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
		const activation = yield* Activation;
		const telemetry = yield* Telemetry;
		const live = yield* Live;
		const wake = yield* Wake;
		const links = yield* Links;
		const engine: WriteEngine = {
			manifest,
			db,
			guest,
			transforms: activation.transforms,
			approval: approvalHook(manifest, db, guest),
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
						const result = yield* act({ ...engine, log }, request);
						const v =
							request.verb === 'erase' && result.outcome.kind === 'committed'
								? live.syncChanged('approval_request')
								: yield* live.v;
						return { ...result, v };
					})
				)
		};
	})
);
