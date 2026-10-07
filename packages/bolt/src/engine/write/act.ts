// The act pipeline (rule 19), in rule order: rate admission → decode → marked-retry lookup → the caller judged once on
// the submitted shape → hold and observed-revision checks → one transform invocation → defaults, upsert resolution and
// model rules → post-image scope and the approval route → one write statement (rule 20), or the outcome record.
import type { Json } from '../../decl/values.ts';
import type {
ApprovalRoute, Arm, Authority, Bindings, Bridge, Captured, CrossAnswer, EngineManifest, GuestPort, Invocation, InputPath, Lock, NoticeRow, Outcome, Pred, RowData, Sql, TenantDb, WriteArm
} from '../contracts.ts';
import { BoltError, LIMITS } from '../contracts.ts';
import { admitMove, readScope } from '../access/authority.ts';
import { catalogOf } from '../access/pred.ts';
import { q, type Catalog } from '../../protocol/catalog.ts';
import { evaluate, type EvalEnv } from '../query/eval.ts';
import { compileGets } from '../query/sql.ts';
import { readEngine } from '../query/engine.ts';
import { constraintIndex, type ConstraintMeta } from '../schema/ddl.ts';
import { schemaSlice } from '../schema/plan.ts';
import { compileCommit, compileOutcomeRecord, type Commit, type OwnedLock, type RateCharge, type Write } from './commit.ts';
import { changed, Flattener, modelKey, withDefaults, type Item, type Sel } from './flatten.ts';
import { canonical, Chain, decided, hex, KEY_REUSE, minter, sha256, untag, type Fingerprint } from './sql.ts';
import type { EventLog } from '../guest/telemetry.ts';
import { erase } from './erase.ts';
import { importPlan, importRefs, type ImportPlan } from './import.ts';
import { embedQueued, embedWrites } from '../integrations/embed.ts'; // hook:integrations

/** The generated verbs (X-24): `import` (rule 30) and `erase` (rule 38e) included. */
type Obj = { readonly [k: string]: Json };
const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);
/** Configured planning may add fields; every already reserved leaf remains immutable. */
const retainsPrepared=(actual:unknown,reserved:unknown):boolean=>isObj(reserved)&&isObj(actual)
	?Object.entries(reserved).every(([field,value])=>Object.hasOwn(actual,field)&&retainsPrepared(actual[field],value))
	:canonical(actual)===canonical(reserved);
export type Verb = 'create' | 'update' | 'delete' | 'upsert' | 'import' | 'erase';
export type ActRequest = {
	collection: string; verb: Verb; input: Json;
	/** Rule 31: the client-minted key, its `issuedAt`, and whether the client marked the request a retry. */
	key: string; issuedAt: string; retry?: boolean;
	authority: Authority; bindings: Bindings; invocationId: string;
	/** Rule 25: the revision the caller last read of each row its input names (attached by `$bolt`, never authored). */
	observed?: { readonly [id: string]: number };
	/** Rule 28: required on `upsert`. */
	onConflict?: 'update' | 'keep';
	/** Rule 38: the persisted buckets this act charges (the cell has already counted them in memory). */
	rate?: readonly RateCharge[];
	/** §5.12: the invocation's event log; the act's statement takes its buffer as a piece. */
	log?: EventLog;
	// hook:integrations — rule 23: an integration's write to its own collection, admitted by its declaration (its `fields`
	// map is the allowlist, `identity` the upsert key) and judged by no grant; `pieces` add its sync shadow to the statement
	integration?: { fields: readonly string[]; identity: string; pieces?: (c: Chain) => void };
	// hook:callables — rule 31: a collection action records its `ctx.act` writes; the planned commit goes to `sink`
	// instead of the database (nothing is recorded), and the outcome is the one the action's one statement commits
	sink?: (planned: { commit: Omit<Commit, 'key' | 'digest' | 'issuedAt' | 'rate'>; lock?: { tables: string[]; mode: 'SHARE ROW EXCLUSIVE' } }) => void;
	/** hook:callables — rows an action recorded earlier in the same act (keyed `collection␀id`), readable as refs (rule 36). */
	pending?: ReadonlyMap<string, RowData>;
	/** hook:envoys — rule 41: a channel's delivery-event and reply mapping (rule 61), which per-state `edit` never refuses. */
	delivery?: true;
};
/** Rules 44–46 (P3): the approval flow's hook points. The write area only calls them. */
export interface ApprovalHook {
	/** Rule 46: may `authority` write rows held by `requestId` (requestor, current-step approver, superseder, admin)? */
	participant(requestId: string, authority: Authority): boolean | Promise<boolean>;
	/**
	 * Rule 44: the admitting grants' routes for the act's root rows as the engine will write them (never called for an
	 * administrator). `null` commits directly; otherwise the act commits provisionally under `requestId` (rule 45) and
	 * `pieces` adds the hold revisions, `bolt_approvals`, `approval_request`/`requestor` and notice rows to the statement.
	 */
	route(act: { collection: string; authority: Authority; bindings: Bindings; rows: readonly { write: Write; pre: RowData | null; routes: readonly ApprovalRoute[] }[] }):
		{ requestId: string; pieces?: (c: Chain) => void } | Outcome | null | Promise<{ requestId: string; pieces?: (c: Chain) => void } | Outcome | null>;
}
export type WriteEngine = {
	manifest: EngineManifest; db: TenantDb;
	/** Collections that attach a transform body (the manifest strips bodies). */
	transforms?: ReadonlySet<string>;
	guest?: GuestPort;
	/**
	 * The transform's reads as the workspace (rule 15); `tables()` names what it read, for rule 26's lock, and
	 * `fingerprints()` digests them, for rule 26's assert.
	 */
	bridge?: (invocation: Invocation) => Bridge & { tables?(): readonly string[]; fingerprints?(): readonly Fingerprint[] };
	/** Rule 38: the serving cell's in-memory windows, charged before decode. */
	admit?: (request: ActRequest) => { retryAfter: number } | null;
	approval?: ApprovalHook;
};
export type ActResult = { outcome: Outcome; captured: readonly Captured[] };

const constraints = new WeakMap<EngineManifest, ReadonlyMap<string, ConstraintMeta>>();
export const constraintsOf = (m: EngineManifest): ReadonlyMap<string, ConstraintMeta> => {
	let c = constraints.get(m);
	if (c === undefined) constraints.set(m, c = constraintIndex(schemaSlice(m)));
	return c;
};
export type RefusalCode = Extract<Outcome, { kind: 'refused' }>['code'];
export const refused = (code: RefusalCode, message: string, path?: InputPath): Outcome => {
	const field = path?.findLast((p) => typeof p === 'string' && !['set', 'target', 'create', 'update', 'upsert', 'delete', 'link', 'unlink'].includes(p));
	const row = path?.find((p) => typeof p === 'number');
	return { kind: 'refused', code, message, ...(typeof field === 'string' ? { field } : {}), ...(typeof row === 'number' ? { row } : {}) };
};
const HOUR = 3_600_000;
export const k = (collection: string, id: string) => `${collection}\u0000${id}`;
export type Taker = (severity: 'info' | 'warn', event: string, attributes: { readonly [key: string]: Json }) => ReturnType<EventLog['take']>;

/**
 * Runs one act (a generated verb) to its outcome. §5.12: the statement that writes (the commit or the outcome record)
 * takes the event buffer as a piece; a refusal decided before guest code writes no row, so its event is stdout only.
 */
export async function act(e: WriteEngine, r: ActRequest): Promise<ActResult> {
	let took = false;
	const take: Taker = (severity, event, attributes) => {
		took = true;
		r.log?.emit(severity, event, { callable: `${r.collection}.${r.verb}`, ...attributes });
		return r.log?.take() ?? [];
	};
	const res = await (r.verb === 'erase' ? erase(e, r, take) : pipeline(e, r, take));
	const o = res.outcome;
	if (!took && r.log !== undefined && (o.kind === 'refused' || o.kind === 'conflict')) {
		r.log.emit('warn', 'act.refused', { callable: `${r.collection}.${r.verb}`, code: o.kind === 'refused' ? o.code : 'conflict' });
		r.log.take();
	}
	return res;
}

/** Rule 31: the record's key (principal, callable, client key) and the request digest, and the stored-outcome lookup. */
export async function idempotency(e: WriteEngine, r: ActRequest, auth: Authority) {
	const principal = canonical({ actor: auth.actor.kind === 'member' ? auth.actor.id : auth.actor, callable: `${r.collection}.${r.verb}` });
	const key = hex(await sha256(`${principal}\u0000${r.key}`));
	const digest = hex(await sha256(canonical({ callable: `${r.collection}.${r.verb}`, input: r.input, onConflict: r.onConflict ?? null })));
	const stored = async (): Promise<Outcome | null> => {
		const [rows] = await e.db.read([{ text: `SELECT i.digest, o.outcome FROM bolt_idem i JOIN bolt_idem_outcome o USING (key)
			WHERE i.key = $1 AND i.issued_at > $2::timestamptz - interval '24 hours'`, params: [key, r.issuedAt] }]);
		const row = rows!.rows[0];
		return row === undefined ? null : row['digest'] === digest ? row['outcome'] as Outcome : KEY_REUSE;
	};
	return { key, digest, stored };
}
/** Rule 31: an `issuedAt` older than 23 h or more than 5 min ahead is `expired`, before anything is read. */
export const expired = (r: ActRequest): Outcome | null => {
	const age = Date.parse(r.bindings.now) - Date.parse(r.issuedAt);
	return age <= 23 * HOUR && age >= -5 * 60_000 ? null : refused('expired', 'The request expired; send it again.');
};

async function pipeline(e: WriteEngine, r: ActRequest, take: Taker): Promise<ActResult> {
	const m = e.manifest, cat = catalogOf(m), b = r.bindings;
	const auth = r.integration ? { ...r.authority, admin: true } : r.authority; // hook:integrations — no grant admits it (rule 23)
	const none = (outcome: Outcome): ActResult => ({ outcome, captured: [] });

	// 1. rate admission (host memory, rule 38): never recorded
	const limited = e.admit?.(r);
	if (limited) return none(refused('rateLimited', `Too many requests; retry in ${limited.retryAfter} s.`));
	const late = expired(r);
	if (late !== null) return none(late);

	// 2. decode against the collection's input allowlist, every offender at once (rule 23)
	const spec = m.collections[r.collection];
	if (spec === undefined) throw new BoltError('unknownCollection', 'decode', `unknown collection '${r.collection}'`);
	const sel = (r.integration ? { columns: r.integration.fields } // hook:integrations
		: r.verb === 'update' ? spec.update?.input : r.verb === 'delete' ? spec.delete && { columns: [] } : spec.create?.input) as Sel | undefined;
	const key0 = r.integration ? [r.integration.identity] : modelKey(m, r.collection); // hook:integrations
	// rule 28: an upsert names its record by `id` (an integration's by its declared identity), so it needs both arms
	const byId = r.verb === 'upsert' && !r.integration;
	if (sel === undefined || (r.verb === 'upsert' && (r.onConflict === undefined || (byId ? spec.update === undefined : key0.length === 0))))
		return none(refused('forbidden', `${r.collection} does not accept ${r.verb}.`));
	// rule 30: an import's options and its refs by key values, resolved before decode (one read per target)
	let imp: ImportPlan | undefined;
	if (r.verb === 'import') {
		const planned = importPlan(m, r.collection, r.input, key0);
		if ('kind' in planned) return none(planned);
		const refs = await importRefs(e.db, m, cat, r.collection, planned.rows);
		if ('kind' in refs) return none(refs);
		imp = { ...planned, rows: refs };
	}
	const mint = await minter(r.invocationId, b.now);
	const f = new Flattener(m, cat, mint);
	const inputs = imp?.rows ?? list(r.input, r.verb);
	if (byId) {
		const invalid = inputs.findIndex((x) => !isObj(x));
		if (invalid >= 0) return none(refused('invalidInput', 'Expected an object.', inputs.length > 1 || Array.isArray(r.input) ? [invalid] : []));
		const badId = inputs.findIndex((x) => isObj(x) && x['id'] !== undefined && typeof x['id'] !== 'string');
		if (badId >= 0) return none(refused('invalidInput', 'Expected an id.', [...(inputs.length > 1 || Array.isArray(r.input) ? [badId] : []), 'id']));
	}
	// rule 28: an upsert row whose `id` is on file is an update of it (`keep`: left as it is), resolved here, before the
	// transform, so the transform sees the stored row; a row without an id is a create; an id on no row is refused
	const upserted: (string | null)[] = [];
	const onFile = byId ? await readRows(e.db, inputs.flatMap((x) => isObj(x) && typeof x['id'] === 'string' ? [[r.collection, x['id']] as const] : [])) : new Map<string, RowData>();
	const missing = byId ? inputs.findIndex((x) => isObj(x) && x['id'] !== undefined && !onFile.has(k(r.collection, String(x['id'])))) : -1;
	if (missing >= 0) return none(refused('notFound', `No ${r.collection} has this id.`, [...(inputs.length > 1 || Array.isArray(r.input) ? [missing] : []), 'id']));
	inputs.forEach((x, i) => {
		const path = inputs.length > 1 || Array.isArray(r.input) || imp !== undefined ? [i] : [];
		if (r.verb === 'create' || (imp !== undefined && imp.onConflict === undefined)) f.create(r.collection, sel, x, path);
		else if (imp !== undefined) f.create(r.collection, sel, x, path, undefined, { on: key0, onConflict: imp.onConflict === 'update' ? 'update' : 'keep' });
		else if (byId) {
			const { id, ...row } = x as Obj;
			if (typeof id !== 'string') { const at = f.items.length; f.create(r.collection, sel, row, path); upserted.push(f.items[at]?.change.id ?? null); }
			else { upserted.push(id); if (r.onConflict === 'update') f.update(r.collection, spec.update!.input as Sel, id, row, r.observed?.[id] ?? null, path); }
		}
		else if (r.verb === 'upsert') f.create(r.collection, sel, x, path, undefined, { on: key0, onConflict: r.onConflict! });
		else if (r.verb === 'update') f.update(r.collection, sel, (x as { target?: Json }).target, (x as { set?: Json }).set, r.observed?.[String((x as { target?: Json }).target)] ?? null, path);
		else f.delete(r.collection, (x as { target?: Json }).target, r.observed?.[String((x as { target?: Json }).target)] ?? null, path);
	});
	if (f.problems.length > 0) {
		const [first] = f.problems;
		return none(refused('invalidInput', f.problems.map((p) => `${p.path.join('.') || 'input'}: ${p.message}`).join('; '), first!.path));
	}
	// hook:integrations — §3.3.5: a field the remote owns is never changed locally
	const owned = r.integration ? [] : (m.integrations[r.collection] as { owns?: { remote?: readonly string[] } } | undefined)?.owns?.remote ?? [];
	const clash = f.items.find((i) => i.change.collection === r.collection && i.supplied.some((s) => owned.includes(s)));
	if (clash !== undefined) return none(refused('forbidden', 'This field is owned by the integration\'s source.', [...clash.change.path, clash.supplied.find((s) => owned.includes(s))!]));
	if (f.items.length > LIMITS.changesPerAct) return none(refused('overflow', `An act writes at most ${LIMITS.changesPerAct} rows.`));

	// 3. the idempotency record (rule 31): looked up before guest code only on a marked retry
	const { key, digest, stored } = await idempotency(e, r, auth);
	if (r.retry) { const o = await stored(); if (o !== null) return none(o); }
	// rule 30: `prune` deletes the caller-readable rows inside its `Where` whose key the import does not name
	if (imp?.prune !== undefined) {
		const ids = await imp.prune(e.db, auth, b, f.items);
		if (!Array.isArray(ids)) return none(ids);
		for (const id of ids) f.delete(r.collection, id, null, ['prune']);
	}

	// the host reads (rule 20's `a`): every existing row the input names and every ref it supplies, one round trip
	const pre = await readRows(e.db, [
		...f.items.filter((i) => i.change.op === 'update' || i.change.op === 'delete').map((i) => [i.change.collection, i.change.id] as const),
		...f.items.flatMap((i) => i.change.op === 'upsert' && i.change.on.length === 1 && i.change.on[0] === 'id' && typeof i.change.values['id'] === 'string'
			? [[i.change.collection, i.change.values['id']] as const] : []),
		...f.items.flatMap((i) => i.refs.map((x) => [x.to, x.id] as const)),
	]);
	for (const [key, row] of r.pending ?? []) if (!pre.has(key)) pre.set(key, row); // hook:callables

	// a relation predicate (a `via` arm, rule 35, or an `{ is }` scope) walks one-relations to any depth: every stored
	// row it reaches is preloaded in one more round trip, only when the caller holds such an arm
	const created = new Map<string, RowData>();
	for (const i of f.items) if (i.change.op === 'create' || i.change.op === 'upsert') created.set(k(i.change.collection, i.change.id), { ...i.change.values, id: i.change.id });
	if (!auth.admin) for (const [key, row] of await readHops(e.db, auth, cat, [
		...[...pre].map(([key, row]) => [key.slice(0, key.indexOf('\u0000')), row] as const),
		...f.items.flatMap((i) => i.change.op === 'update' && pre.has(k(i.change.collection, i.change.id)) ? [[i.change.collection, { ...pre.get(k(i.change.collection, i.change.id))!, ...i.change.set }] as const] : []),
		...[...created].map(([key, row]) => [key.slice(0, key.indexOf('\u0000')), row] as const),
	], (c, id) => pre.get(k(c, id)) ?? created.get(k(c, id)))) pre.set(key, row);
	const env: EvalEnv = { cat, bindings: b, authority: auth, related: (c, rel, target, row) => {
		if (!cat.models.get(c)!.one.has(rel)) throw new BoltError('unsupported', 'admission', `a write grant cannot scope through many-relation '${rel}'`);
		const id = row[rel], hit = typeof id === 'string' ? pre.get(k(target, id)) ?? created.get(k(target, id)) : undefined;
		return hit === undefined ? [] : [hit];
	} };
	if (byId && r.onConflict === 'keep') for (const id of upserted) {
		if (id === null) continue;
		const row = onFile.get(k(r.collection, id));
		if (row === undefined) continue;
		if (!readableBy(env, r.collection, row)) return none(refused('notFound', 'The record does not exist.'));
		if (!auth.admin && judgePre(auth, env, r.collection, 'update', row, []) !== true) return none(refused('forbidden', 'You may not make this change.'));
	}

	// 4. the caller, judged once on the shape it submitted (rules 19, 34, 35, 36)
	const readable = (c: string, row: RowData) => readableBy(env, c, row);
	for (const it of f.items) {
		const c = it.change, named = c.op === 'upsert' && c.on.length === 1 && c.on[0] === 'id' && typeof c.values['id'] === 'string' ? c.values['id'] : c.id;
		const row = pre.get(k(c.collection, named)), action = c.op === 'upsert' && row !== undefined ? 'update' : op(c.op);
		// a relation action on a collection the caller holds no grant on is judged `via` its parent (the parent row was)
		const via = it.parent !== undefined && auth.collections[c.collection] === undefined;
		if (action === 'update' || c.op === 'delete') {
			if (row === undefined || (!via && !readable(c.collection, row))) return none(refused('notFound', 'The record does not exist.', c.path));
			if (it.belongs === 'parent' && row[it.parent!.fk] !== it.parent!.id) return none(refused('notFound', 'The record does not belong here.', c.path));
		}
		for (const ref of it.refs) {
			const target = pre.get(k(ref.to, ref.id));
			if (target === undefined || !readable(ref.to, target)) return none(refused('notFound', `No readable ${ref.to} has this id.`, [...c.path, ref.field]));
		}
		if (auth.admin || (it.parent !== undefined && (auth.collections[c.collection]?.[action] ?? []).length === 0)) continue; // `via` the parent
		const verdict = judgePre(auth, env, c.collection, action, row ?? null, it.supplied);
		if (verdict !== true) return none(refused('forbidden', 'You may not make this change.', verdict.field === undefined ? c.path : [...c.path, verdict.field]));
		const state = stateField(m, c.collection);
		const next = c.op === 'update' ? c.set[state ?? ''] : undefined;
		if (state !== undefined && typeof next === 'string' && row !== undefined && !admitMove(auth, c.collection, state, String(row[state]), next))
			return none(refused('forbidden', `You may not move ${state} to '${next}'.`, [...c.path, state]));
	}

	// 5. holds (rule 46) and the observed revision (rule 25), before anything runs
	for (const it of f.items) {
		const c = it.change, named = c.op === 'upsert' && c.on.length === 1 && c.on[0] === 'id' && typeof c.values['id'] === 'string' ? c.values['id'] : c.id;
		const row = pre.get(k(c.collection, named));
		if (row === undefined) continue;
		const held = row['approval_id'];
		if (typeof held === 'string' && !auth.admin && !(await e.approval?.participant(held, auth)))
			return none({ kind: 'refused', code: 'approvalHeld', message: `The record is held by approval request ${held}.`, data: { requestId: held } }); // hook:approvals
		const seen = (c.op === 'update' || c.op === 'delete') ? c.revision : null;
		if (seen !== null && seen !== row['revision']) return none({ kind: 'conflict', records: [{ collection: c.collection, id: c.id, fields: [] }] });
	}

	// 6–9, replayed once on a serialization failure with the same clock and minted ids (rule 26)
	const common = { key, digest, issuedAt: r.issuedAt, rate: r.rate ?? [] };
	const record = async (outcome: Outcome): Promise<ActResult> => {
		const events = take('warn', 'act.refused', outcome.kind === 'refused' ? { code: outcome.code, message: outcome.message } : { code: outcome.kind });
		const res = await e.db.write(compileOutcomeRecord({ ...common, events }, outcome as Json));
		return none((res.rows[0]?.['outcome'] as Outcome | null) ?? await stored() ?? outcome);
	};
	for (let attempt = 0; ; attempt++) {
		const planned = await plan(e, r, env, f.items, pre, imp, byId ? upserted : undefined);
		if ('outcome' in planned) return planned.guest && r.sink === undefined ? record(planned.outcome) : none(planned.outcome);
		if (r.sink !== undefined) { // hook:callables
			r.sink(planned);
			const records = planned.commit.writes.map((w) => ({ collection: w.collection, id: w.id, revision: w.op === 'create' ? 1 : w.revision + 1 }));
			return none(planned.commit.approval ? { kind: 'pendingApproval', requestId: planned.commit.approval.requestId, records }
				: { kind: 'committed', output: planned.commit.output, records });
		}
		if (imp?.dryRun) return none(await dryRun(e.db, compileCommit(m, cat, { ...planned.commit, ...common }), planned.lock, constraintsOf(m)));
		try {
			const events = take('info', 'act.settled', { writes: planned.commit.writes.length });
			const res = await e.db.write(compileCommit(m, cat, { ...planned.commit, ...common, events }), planned.lock);
			const row = res.rows[0]!;
			return { outcome: (row['outcome'] as Outcome | null) ?? await stored() ?? refused('refused', 'The outcome was lost.'), captured: row['captured'] as unknown as Captured[] };
		} catch (err) {
			const d = decided(err, constraintsOf(m));
			if (d.replay && planned.guest && attempt === 0) continue;
			return d.record ? record(d.outcome) : none(d.outcome);
		}
	}
}

const op = (o: 'create' | 'upsert' | 'update' | 'delete') => o === 'upsert' ? 'create' : o;
/** The one-relation paths (`[fk, target]` hops) the caller's arms on `c` walk. */
function hopPaths(auth: Authority, c: string): (readonly (readonly [string, string])[])[] {
	const a = auth.collections[c];
	if (a === undefined) return [];
	const walk = (p: Pred): (readonly (readonly [string, string])[])[] =>
		p.t === 'one' ? [[[p.rel, p.target]], ...walk(p.pred).map((rest) => [[p.rel, p.target] as const, ...rest])]
		: p.t === 'and' || p.t === 'or' ? p.of.flatMap(walk) : p.t === 'not' ? walk(p.of) : [];
	return [...a.read, ...a.create, ...a.update, ...a.delete].flatMap((x: Arm & { previous?: Pred }) => [...walk(x.where), ...(x.previous === undefined ? [] : walk(x.previous))]);
}
/**
 * Rule 36 and relation scopes at any depth: from each known row, follows the caller's hop paths through rows already in
 * hand (`local`) and reads the rest, every hop of every path, in one pipelined round trip keyed `collection␀id`.
 */
async function readHops(db: TenantDb, auth: Authority, cat: Catalog, from: readonly (readonly [string, RowData])[],
	local: (c: string, id: string) => RowData | undefined): Promise<Map<string, RowData>> {
	const seeds = new Map<string, { path: readonly (readonly [string, string])[]; ids: Set<string> }>();
	const paths = new Map<string, ReturnType<typeof hopPaths>>();
	for (const [c, row] of from) for (const path of paths.get(c) ?? paths.set(c, hopPaths(auth, c)).get(c)!) {
		let cur: RowData | undefined = row;
		for (let i = 0; i < path.length && cur !== undefined; i++) {
			const [fk, target] = path[i]!, id = cur[fk];
			if (typeof id !== 'string' || cat.models.get(target) === undefined) break;
			cur = local(target, id);
			if (cur !== undefined) continue;
			const rest = path.slice(i), sk = JSON.stringify(rest);
			(seeds.get(sk) ?? seeds.set(sk, { path: rest, ids: new Set() }).get(sk)!).ids.add(id);
		}
	}
	const statements = [...seeds.values()].flatMap(({ path, ids }) => path.map((_, d) => {
		const joins = path.slice(1, d + 1).map(([fk, t], j) => `JOIN ${q(t)} t${j + 1} ON t${j + 1}.id = t${j}.${q(fk)}`).join(' ');
		return { target: path[d]![1], text: `SELECT t${d}.*, t${d}.id::text AS id FROM ${q(path[0]![1])} t0 JOIN jsonb_populate_recordset(null::${q(path[0]![1])}, $1::jsonb) r ON t0.id = r.id ${joins}`,
			params: [JSON.stringify([...ids].map((id) => ({ id })))] };
	}));
	if (statements.length === 0) return new Map();
	const res = await db.read(statements.map(({ text, params }) => ({ text, params })));
	return new Map(statements.flatMap((s, i) => res[i]!.rows.map((row) => [k(s.target, String(row['id'])), row] as const)));
}
export const list = (input: Json, verb: Verb): readonly Json[] => {
	if (Array.isArray(input)) return input;
	const t = verb === 'update' || verb === 'delete' ? (input as { target?: Json } | null)?.target : undefined;
	return Array.isArray(t) ? t.map((target) => ({ ...(input as object), target })) : [input];
};
export const stateField = (m: EngineManifest, model: string): string | undefined =>
	Object.entries(m.models[model]?.fields ?? {}).find(([, x]) => x.kind === 'state')?.[0];

/**
 * Rule 35 on the rows as the engine will write them: `create` on the post-image, `update` on both (or `previous` on the
 * pre-image), `delete` on the stored row; every supplied field admitted by one scoped arm. The first arm admitting every
 * field supplies the approval routes (§3.8). ponytail: mirrors `access/authority` `admitWrite`, whose signature is still
 * moving; fold into it once it settles.
 */
function judgePost(env: EvalEnv, c: string, o: 'create' | 'update' | 'delete', pre: RowData | null, post: RowData | null, supplied: readonly string[]):
	{ ok: true; routes: readonly ApprovalRoute[] } | { ok: false; field?: string } {
	const is = (p: Parameters<typeof evaluate>[2], row: RowData | null) => row !== null && evaluate(env, c, p, row);
	const scoped = (env.authority!.collections[c]?.[o] ?? []).filter((a) => o === 'create' ? is(a.where, post) : o === 'delete' ? is(a.where, pre)
		: is(a.previous ?? a.where, pre) && is(a.where, post));
	if (scoped.length === 0) return { ok: false };
	const admits = (a: WriteArm, f: string) => a.fields === 'all' || a.fields.includes(f);
	const field = supplied.find((f) => !scoped.some((a) => admits(a, f)));
	return field !== undefined ? { ok: false, field } : { ok: true, routes: (scoped.find((a) => supplied.every((f) => admits(a, f))) ?? scoped[0]!).approval };
}
/** Rule 13: the caller's read scope admits `row` (an administrator reads everything). */
function readableBy(env: EvalEnv, c: string, row: RowData): boolean {
	const s = env.authority!.admin ? undefined : readScope(env.authority!, c);
	return env.authority!.admin || (s !== undefined && evaluate(env, c, s, row));
}
/** Pre-guest judgement: the pre-image scope of an update or delete, and `fields` of every supplied field. */
function judgePre(auth: Authority, env: EvalEnv, collection: string, o: 'create' | 'update' | 'delete', row: RowData | null, supplied: readonly string[]): true | { field?: string } {
	const arms = (auth.collections[collection]?.[o] ?? []).filter((a: WriteArm) =>
		o === 'create' || (row !== null && evaluate(env, collection, a.previous ?? a.where, row)));
	if (arms.length === 0) return {};
	const field = supplied.find((s) => !arms.some((a) => a.fields === 'all' || a.fields.includes(s)));
	return field === undefined ? true : { field };
}

/** Reads rows by id, one pipelined round trip, keyed `collection␀id`. */
export async function readRows(db: TenantDb, want: readonly (readonly [string, string])[]): Promise<Map<string, RowData>> {
	const byTable = Map.groupBy(want, ([c]) => c);
	if (byTable.size === 0) return new Map();
	const tables = [...byTable.keys()];
	const res = await db.read(tables.map((t) => ({
		text: `SELECT t.*, t.id::text AS id FROM ${q(t)} t JOIN jsonb_populate_recordset(null::${q(t)}, $1::jsonb) r ON t.id = r.id`,
		params: [JSON.stringify([...new Set(byTable.get(t)!.map(([, id]) => id))].map((id) => ({ id })))],
	})));
	return new Map(tables.flatMap((t, i) => res[i]!.rows.map((row) => [k(t, String(row['id'])), row] as const)));
}

type Planned = { guest: boolean } & ({ outcome: Outcome } | { commit: Omit<Commit, 'key' | 'digest' | 'issuedAt' | 'rate'>; lock?: { tables: string[]; mode: 'SHARE ROW EXCLUSIVE' } });

/** Steps 6–8: the transform, defaults, upsert resolution, model rules, post-image scope and the approval route. */
async function plan(e: WriteEngine, r: ActRequest, env: EvalEnv, submitted: readonly Item[], pre: Map<string, RowData>, imp?: ImportPlan, upserted?: (string | null)[]): Promise<Planned> {
	const m = e.manifest, auth = env.authority!, b = r.bindings, cat = env.cat; // hook:integrations — the act's judged authority
	let items = submitted, readTables: readonly string[] = [], fingerprints: readonly Fingerprint[] = [];
	const identities=new Map(submitted.map(item=>[JSON.stringify([item.change.collection,item.change.path]),item.change.id]));
	const preparedCreates=new Map<string,Item>();
	const deleteGuard = r.verb === 'delete' && m.collections[r.collection]?.delete !== undefined && 'transform' in m.collections[r.collection]!.delete!;
	const runs = e.transforms?.has(r.collection) === true && (r.verb !== 'delete' || (deleteGuard && !auth.admin));

	// 6. one transform invocation over the whole batch (rule 27); its payload is the workspace's own work (rule 19)
	if (runs) {
		if (e.guest === undefined) throw new BoltError('noGuest', 'guest', 'this host runs no guest code');
		// an import's pruned rows are deletes beside the batch, not inputs of it
		const roots = submitted.filter((i) => i.parent === undefined && (r.verb === 'delete' || i.change.op !== 'delete'));
		const inputs = imp?.rows ?? list(r.input, r.verb);
		const invocation: Invocation = {
			id: r.invocationId, kind: 'transform', target: r.collection,
			input: roots.map((it, i) => {
				const input = it.change.op === 'delete' ? { $delete: true } : r.verb === 'update' ? (inputs[i] as { set: Json }).set : inputs[i]!;
				return r.verb === 'upsert' && !r.integration && isObj(input) ? Object.fromEntries(Object.entries(input).filter(([field]) => field !== 'id')) : input;
			}),
			ctx: { actor: auth.actor, policies: auth.policies, admin: auth.admin, now: b.now, today: b.today, tz: b.tz, seed: r.invocationId,
				staged:submitted.map(item=>({collection:item.change.collection,id:item.change.id,path:item.change.path,operation:item.change.op,...(item.parent===undefined?{}:{parent:{collection:item.parent.collection,id:item.parent.id,relation:item.parent.rel,field:item.parent.fk}})})),
				existing: await wireRows(e.db, cat, r.collection, roots.map((it) => pre.has(k(it.change.collection, it.change.id)) ? it.change.id : null), b) },
			budget: { cpuMs: LIMITS.guestCpuMs, crossings: LIMITS.crossings.sync, readBytes: LIMITS.readBytes },
		};
		const originalBridge = e.bridge?.(invocation) ?? { cross: () => Promise.reject(new BoltError('noBridge', 'guest', 'this host gives the transform no reads')) };
		const bridge={...originalBridge,cross:async(calls:Parameters<Bridge['cross']>[0],signal:AbortSignal):Promise<readonly CrossAnswer[]>=>{
			const answers:CrossAnswer[]=[];
			const forwarded=calls.filter(call=>call.op!=='prepareCreate'&&!(call.op==='read'&&call.read.kind==='after'));
			const readAnswers=forwarded.length?await originalBridge.cross(forwarded,signal):[];let forwardedIndex=0;
			for(const call of calls){
				if(call.op==='read'&&call.read.kind==='after'){
					const nativeRead=call.read.query??{kind:'read' as const,collection:call.read.collection,where:call.read.where,select:{fields:[...cat.collections.get(call.read.collection)!.model.fields.keys()],relations:{}},page:{all:true as const}};
					// The original bridge captures the stored source baseline for the act's native lock/fingerprint contract.
					const baseline=await originalBridge.cross([{op:'read',read:nativeRead,params:call.params}],signal);
					if(baseline.length!==1)throw new BoltError('preparedRead','guest','a prospective read requires its actual native source baseline');
					if(baseline[0]?.ok!==true){answers.push(baseline[0]!);continue;}
					const prospective=new Map(submitted.map(item=>[JSON.stringify([item.change.collection,item.change.path]),item]));
					for(const [token,item]of preparedCreates)prospective.set(token,item);
					const groups=Map.groupBy([...prospective.values()],item=>cat.collections.get(item.change.collection)!.model.name);
					const sources=new Map([...groups.keys()].map((model,index)=>[model,`__bolt_prepared_${index}`]));
					const nativeRows=new Map<string,RowData[]>();
					for(const [model,group]of groups){
						const spec=m.models[model]!;
						if(Object.keys(spec.computed??{}).length||Object.values(spec.fields).some(field=>['seq','sum','count'].includes(field.kind)))throw new BoltError('preparedComputed','guest','prospective reads require native generated fields to be materialized before they can be read');
						const rows:RowData[]=[];
						for(const item of group){
							if(item.change.op==='delete')continue;
							if(item.change.op!=='create'&&item.change.op!=='update')throw new BoltError('preparedUpsert','guest','prospective sources require resolved native row identities');
							const old=item.change.op==='update'?pre.get(k(item.change.collection,item.change.id)):undefined;
							if(item.change.op==='update'&&old===undefined)throw new BoltError('preparedPrevious','guest','a prospective update requires its actual stored pre-image');
							const values={...old,...(item.change.op==='create'?item.change.values:item.change.set)};
							// A private prepared routing phase can precede derived required fields.
							// Final emission still passes the ordinary complete model admission.
							if(item.change.op==='create')withDefaults(m,cat,model,values,auth.actor,b);
							rows.push({id:item.change.id,...Object.fromEntries(Object.entries(values).map(([field,value])=>[field,untag(value,cat.models.get(model)?.fields.get(field))]))});
						}
						nativeRows.set(model,rows);
					}
					const db:TenantDb={...e.db,read:statements=>e.db.read(statements.map(statement=>{
						const params=[...statement.params];
						const ctes=[...nativeRows].map(([model,rows])=>{params.push(JSON.stringify(rows));const argument=`$${params.length}::jsonb`;params.push(groups.get(model)!.map(item=>item.change.id));const identities=`$${params.length}::text[]`;return `${q(sources.get(model)!)} AS (SELECT original.* FROM ${q(model)} original WHERE NOT (original.id::text=ANY(${identities})) UNION ALL SELECT * FROM jsonb_populate_recordset(null::${q(model)},${argument}))`;});
						const text=ctes.length?`WITH ${ctes.join(', ')} ${statement.text}`:statement.text;
						if(params.length>LIMITS.statement.params)throw new BoltError('tooLarge','guest','the prospective native read exceeds its statement parameter budget');
						if(new TextEncoder().encode(text).length+new TextEncoder().encode(JSON.stringify(params)).length>LIMITS.readBytes)throw new BoltError('tooLarge','guest','the prospective native source statement exceeds the guest read byte budget');
						return {text,params};
					}))};
					const reader=readEngine({manifest:m,db,querySources:{sources},allBytes:LIMITS.readBytes});
					const result=await reader.run([nativeRead],{as:'workspace'},b);
					const answer=result[0];
					if(!isObj(answer)||!Array.isArray(answer.rows))throw new BoltError('preparedRead','guest','the native prospective reader returned an invalid row envelope');
					answers.push({ok:true,value:call.read.query===undefined?answer.rows:answer});continue;
				}
				if(call.op!=='prepareCreate'){answers.push(readAnswers[forwardedIndex++]!);continue;}
				const path=call.path,parentPath=path.slice(0,-3),relation=path.at(-3),index=path.at(-1);
				const staged=submitted.find(item=>item.change.collection===call.collection&&canonical(item.change.path)===canonical(path));
				const root=staged?.parent===undefined&&staged?.change.op==='create'?staged:undefined;
				if(!isObj(call.values)||(root===undefined&&(path.length<3||typeof relation!=='string'||path.at(-2)!=='create'||typeof index!=='number'||!Number.isSafeInteger(index)||index<0)))throw new BoltError('preparedPath','guest','prepareCreate requires an actual staged create or nested native create path');
				const parent=[...submitted,...preparedCreates.values()].find(item=>canonical(item.change.path)===canonical(parentPath));
				const rel=parent===undefined||typeof relation!=='string'?undefined:cat.models.get(parent.change.collection)?.many.get(relation);
				if(root===undefined&&(parent===undefined||!['create','update'].includes(parent.change.op)||rel===undefined||rel.child!==call.collection||m.relationships[`${rel.child}.${rel.column}`]?.inverse!==relation))throw new BoltError('preparedOwnership','guest','prepareCreate requires an actual declared native relationship under its staged parent');
				const token=JSON.stringify([call.collection,path]),previous=preparedCreates.get(token);
				if(identities.has(token)&&previous===undefined&&root===undefined)throw new BoltError('preparedConflict','guest','a prepared create cannot replace a submitted native path');
				const id=previous?.change.id??root?.change.id??(await minter(`${r.invocationId}:prepared:${token}`,b.now))();
				const reservedIdentities=new Map(identities);reservedIdentities.set(token,id);
				const flattened=new Flattener(m,cat,await minter(`${r.invocationId}:prepared:${token}:${hex(await sha256(canonical(call.values)))}`,b.now),reservedIdentities);
				flattened.create(call.collection,'any',call.values,path,root!==undefined?undefined:{collection:parent!.change.collection,id:parent!.change.id,rel:relation as string,fk:rel!.column});
				const candidate=flattened.items[0];
				const paths=new Set([...preparedCreates.keys(),...flattened.items.map(item=>JSON.stringify([item.change.collection,item.change.path]))]);
				if(flattened.problems.length||candidate?.change.op!=='create'||paths.size>LIMITS.changesPerAct)throw new BoltError('preparedValues','guest','prepareCreate accepts admitted native rows and declared relationship actions within the act row budget');
				if(root?.change.op==='create'&&Object.entries(root.change.values).some(([field,value])=>canonical(candidate.change.op==='create'?candidate.change.values[field]:undefined)!==canonical(value)))throw new BoltError('preparedValues','guest','a prepared root must preserve every submitted native value');
				if(previous?.change.op==='create'&&!retainsPrepared(candidate.change.values,previous.change.values))throw new BoltError('preparedConflict','guest','a prepared native path cannot change its original values');
				const wanted=flattened.items.flatMap(item=>item.change.op==='update'||item.change.op==='delete'?[[item.change.collection,item.change.id] as const]:[]);
				const stored=await readRows(e.db,wanted);for(const [key,row]of stored)if(!pre.has(key))pre.set(key,row);
				for(const item of flattened.items){
					if(item.change.op==='upsert')throw new BoltError('preparedUpsert','guest','prepared native actions require resolved row identities');
					const itemToken=JSON.stringify([item.change.collection,item.change.path]),prior=preparedCreates.get(itemToken);
					const before=item.change.op==='create'?null:pre.get(k(item.change.collection,item.change.id))??null;
					if(item.change.op!=='create'&&before===null)throw new BoltError('preparedPrevious','guest','prepared native relationship changes require their actual stored pre-image');
					const supplied=submitted.find(original=>original.change.collection===item.change.collection&&canonical(original.change.path)===canonical(item.change.path))?.supplied??[];
					if(!auth.admin&&judgePre(auth,env,item.change.collection,item.change.op,before,supplied)!==true)throw new BoltError('forbidden','guest','the actor has no native authority for the prepared relationship action');
					const values=item.change.op==='create'?item.change.values:item.change.op==='update'?item.change.set:null;
					if(prior!==undefined){const previousValues=prior.change.op==='create'?prior.change.values:prior.change.op==='update'?prior.change.set:null;if(prior.change.op!==item.change.op||prior.change.id!==item.change.id||!retainsPrepared(values,previousValues))throw new BoltError('preparedConflict','guest','a prepared relationship path cannot change its original operation, identity or values');}
					preparedCreates.set(itemToken,item);identities.set(itemToken,item.change.id);
				}
				const related_sources=flattened.items.slice(1).flatMap(item=>item.change.op==='create'?[{collection:item.change.collection,id:item.change.id,path:item.change.path,values:item.change.values,committed:false,phase:'PREPARED_NATIVE_CREATE',invocation_id:r.invocationId,related_sources:[],related_actions:[]}]:[]);
				const related_actions=await Promise.all(flattened.items.slice(1).map(async item=>{
					const previous=item.change.op==='update'?(await wireRows(e.db,cat,item.change.collection,[item.change.id],b))[0]:undefined;
					if(item.change.op==='update'&&previous==null)throw new BoltError('preparedPrevious','guest','a prospective mutation requires its actual native pre-image');
					return {collection:item.change.collection,id:item.change.id,path:item.change.path,operation:item.change.op,...(item.change.op==='update'?{set:item.change.set,previous_revision:previous?.revision??null,previous}:{}),committed:false,phase:'PREPARED_NATIVE_MUTATION',invocation_id:r.invocationId};
				}));
				answers.push({ok:true,value:{collection:call.collection,id,path,values:candidate.change.values,committed:false,phase:'PREPARED_NATIVE_CREATE',invocation_id:r.invocationId,related_sources,related_actions} as unknown as Json});
			}
			return answers;
		}};
		const g = await e.guest.invoke(invocation, bridge);
		readTables = bridge.tables?.() ?? [];
		fingerprints = bridge.fingerprints?.() ?? [];
		if (g.kind === 'refused') return { guest: true, outcome: { kind: 'refused', code: 'refused', message: g.message, rule: `${r.collection}.transform`, ...(g.field === undefined ? {} : { field: g.field }) } };
		if (g.kind === 'failed') return { guest: true, outcome: guestFailure(g.error) };
		if (r.verb !== 'delete') {
			const out = g.output;
			if (!Array.isArray(out) || out.length !== roots.length) throw new BoltError('transformShape', 'guest', 'a transform returns one payload per input');
			const again = new Flattener(m, cat, await minter(r.invocationId, b.now),identities);
			roots.forEach((it, i) => {
				const c = it.change;
				if (c.op === 'update') again.update(c.collection, 'any', c.id, out[i], c.revision, c.path);
				else again.create(c.collection, 'any', out[i], c.path, undefined, c.op === 'upsert' ? { on: c.on, onConflict: c.onConflict } : undefined);
			});
			if (again.problems.length > 0) throw new BoltError('transformPayload', 'guest', again.problems.map((p) => `${p.path.join('.')}: ${p.message}`).join('; '));
			for(const item of again.items){const assigned=identities.get(JSON.stringify([item.change.collection,item.change.path]));if(assigned!==undefined&&assigned!==item.change.id)throw new BoltError('transformIdentity','guest','a transform must preserve the engine-assigned identity of each submitted native path');}
			for(const [token,reservation]of preparedCreates){const final=again.items.find(item=>JSON.stringify([item.change.collection,item.change.path])===token);const values=final?.change.op==='create'?final.change.values:final?.change.op==='update'?final.change.set:null;const reserved=reservation.change.op==='create'?reservation.change.values:reservation.change.op==='update'?reservation.change.set:null;if(final===undefined||final.change.op!==reservation.change.op||final.change.id!==reservation.change.id||!retainsPrepared(values,reserved))throw new BoltError('preparedValues','guest','every prepared native action must retain its reserved operation, identity and values at its reserved path');}
			// the caller's supplied fields are what grants admit; the transform's own additions need no `fields` entry (rule 35)
			const supplied = new Map(submitted.map((s) => [s.change.path.join('.'), s.supplied]));
			items = [...again.items.map((it) => ({ ...it, supplied: supplied.get(it.change.path.join('.')) ?? [] })),
				...submitted.filter((i) => i.parent === undefined && !roots.includes(i))];
			const more = await readRows(e.db, items.flatMap((i) => i.change.op === 'update' || i.change.op === 'delete'
				? (pre.has(k(i.change.collection, i.change.id)) ? [] : [[i.change.collection, i.change.id] as const]) : []));
			for (const [key, row] of more) pre.set(key, row);
		}
	}
	const guest = runs;
	const stop = (outcome: Outcome): Planned => ({ guest, outcome });

	// 7. upsert resolution read, defaults (rule 23a), model rules (rules 34, 40, 41), no-op updates (rule 29)
	const upserts = items.filter((i) => i.change.op === 'upsert');
	const existing = await resolveUpserts(e.db, m, upserts);
	const writes: { write: Write; item: Item }[] = [];
	const output: Json[] = [];
	const report: { index: number | null; id: string | null; action: string }[] = [];
	const deletedIds = new Set(items.filter((i) => i.change.op === 'delete').map((i) => k(i.change.collection, i.change.id)));
	for (const it of items) {
		const c = it.change;
		if (c.op !== 'delete' && deletedIds.has(k(c.collection, c.id))) return stop(refused('invalidInput', 'A row deleted in this act cannot also be changed (deletedInAct).', c.path));
		const root = imp !== undefined && it.parent === undefined;
		if (c.op === 'upsert') {
			const found = existing.get(it);
			if (found !== undefined) {
				if (!readableBy(env, c.collection, found) || (root && imp!.onConflict === 'refuse'))
					return stop(refused('unique', 'A record with these values already exists.', c.path));
				output.push(String(found['id']));
				pre.set(k(c.collection, String(found['id'])), found);
				const set = c.onConflict === 'keep' ? {} : changed(found, Object.fromEntries(Object.entries(c.values).filter(([f]) => !c.on.includes(f))));
				if (c.on.length === 1 && c.on[0] === 'id' && !r.integration) {
					const locked = modelRules(m, c.collection, found, set);
					if (locked !== null && !(r.delivery && locked.code === 'locked')) return stop(refused(locked.code, locked.message, [...c.path, locked.field]));
				}
				if (root) report.push({ index: Number(c.path[0]), id: String(found['id']), action: Object.keys(set).length > 0 ? 'updated' : 'kept' });
				if (Object.keys(set).length > 0) writes.push({ write: { collection: c.collection, id: String(found['id']), op: 'update', set, revision: Number(found['revision']) }, item: it });
				continue;
			}
			// rule 28: a nested upsert by id names a child on file; it never creates one under an id it made up
			if (c.on.length === 1 && c.on[0] === 'id' && !r.integration) return stop(refused('notFound', `No ${c.collection} has this id.`, [...c.path, 'id']));
			// rule 30: `onMissing: 'skip'` only updates rows already on file
			if (root && imp!.onMissing === 'skip') { report.push({ index: Number(c.path[0]), id: null, action: 'skipped' }); continue; }
			output.push(c.id);
		}
		if (root) report.push({ index: c.op === 'delete' ? null : Number(c.path[0]), id: c.id, action: c.op === 'delete' ? 'deleted' : 'created' });
		if (c.op === 'create' || c.op === 'upsert') {
			const values = { ...c.values } as Record<string, Json>;
			const missing = withDefaults(m, cat, c.collection, values, auth.actor, b);
			if (missing !== null) return stop(refused('required', `${missing} is required.`, [...c.path, missing]));
			const state = stateField(m, c.collection);
			const initial = state === undefined ? undefined : (m.models[c.collection]!.fields[state] as { initial: string }).initial;
			if (state !== undefined && values[state] !== initial) return stop(refused('invalidInput', `A new record starts in '${initial}'.`, [...c.path, state]));
			writes.push({ write: { collection: c.collection, id: c.id, op: 'create', values }, item: it });
		} else {
			const row = pre.get(k(c.collection, c.id));
			if (row === undefined) return stop(refused('notFound', 'The record does not exist.', c.path));
			if (c.op === 'delete') { writes.push({ write: { collection: c.collection, id: c.id, op: 'delete', revision: Number(row['revision']) }, item: it }); continue; }
			const set = changed(row, c.set);
			const locked = modelRules(m, c.collection, row, set);
			if (locked !== null && !(r.delivery && locked.code === 'locked')) return stop(refused(locked.code, locked.message, [...c.path, locked.field])); // hook:envoys
			if (Object.keys(set).length > 0) writes.push({ write: { collection: c.collection, id: c.id, op: 'update', set, revision: Number(row['revision']) }, item: it });
		}
	}

	// §3.3.2: every custom field value the act writes passes its kind's `validate`
	const invalid = await validateCustom(e, r, writes);
	if (invalid !== null) return stop(invalid);

	// 8. the admitting grant's post-image scope on the root rows as the engine will write them, then its approval route
	const routed: { write: Write; pre: RowData | null; routes: readonly ApprovalRoute[] }[] = [];
	for (const { write: w, item } of writes) {
		if (auth.admin || (item.parent !== undefined && (auth.collections[w.collection]?.[w.op] ?? []).length === 0)) continue;
		const row = pre.get(k(w.collection, w.id)) ?? null;
		const post = w.op === 'create' ? w.values : w.op === 'update' ? { ...row, ...w.set } : null;
		const verdict = judgePost(env, w.collection, w.op, row, post, item.supplied);
		if (!verdict.ok) return stop(refused('forbidden', 'You may not make this change.', verdict.field === undefined ? item.change.path : [...item.change.path, verdict.field]));
		if (item.parent === undefined) routed.push({ write: w, pre: row, routes: verdict.routes });
	}
	let approval: Commit['approval'];
	// hook:approvals — a participant's write on a held row rides the open request (rule 46) even when nothing routes
	if (!auth.admin && (routed.some((x) => x.routes.length > 0) || (e.approval !== undefined && routed.some((x) => typeof x.pre?.['approval_id'] === 'string')))) {
		if (e.approval === undefined) throw new BoltError('noApproval', 'admission', 'a grant routes this write to approval, and no approval flow is wired');
		const route = await e.approval.route({ collection: r.collection, authority: auth, bindings: b, rows: routed });
		if (route !== null && 'kind' in route) return stop(route);
		if (route !== null) approval = route;
	}

	const embed = embedWrites(m, writes.map((w) => w.write)); // hook:integrations — rule 16: stale embeddings null, `bolt.embed` queued
	const plain = embed.writes;
	// hook:integrations — §3.3.5: a local write on a two_way collection queues its push in the same statement
	const push = !r.integration && m.integrations[r.collection]?.direction === 'two_way' && plain.some((w) => w.collection === r.collection)
		? [{ id: (await minter(`${r.invocationId}:push`, b.now))(), automation: `${r.collection}.integration`, input: { mode: 'push' }, dueAt: b.now, cause: 'updated', depth: 0 }] : [];
	const queued = embed.stale ? [...push, embedQueued((await minter(`${r.invocationId}:embed`, b.now))(), b.now)] : push; // hook:integrations
	if (JSON.stringify(plain).length > LIMITS.changeSetBytes) return stop(refused('overflow', 'The change is too large for one act.'));
	const tables = [...new Set([...plain.map((w) => w.collection), ...readTables])].sort();
	return {
		guest,
		commit: { now: b.now, today: b.today, actor: auth.actor, writes: plain, owned: ownedLocks(m, cat, writes.map((w) => w.write), pre),
			runs: queued, notices: approval === undefined ? await committedNotices(m, r, auth, routedRows(writes, pre)) : [], outbox: [], output: upserted ?? (r.verb === 'upsert' ? output : imp !== undefined ? { rows: report } : null), ...(approval === undefined ? {} : { approval }),
			...(guest && fingerprints.length > 0 ? { fingerprints } : {}),
			...(r.integration?.pieces === undefined ? {} : { pieces: r.integration.pieces }) },
		...(guest && readTables.length > 0 ? { lock: { tables, mode: 'SHARE ROW EXCLUSIVE' as const } } : {}),
	};
}

/** The act's root rows as written, with the image a `{ user }` recipient reads (the post-image; a delete's stored row). */
const routedRows = (writes: readonly { write: Write; item: Item }[], pre: Map<string, RowData>) =>
	writes.filter((x) => x.item.parent === undefined).map(({ write: w }) => ({ write: w,
		row: w.op === 'create' ? w.values : { ...pre.get(k(w.collection, w.id)), ...(w.op === 'update' ? w.set : {}) } }));
type NoticeRule = { channel: string; to: readonly Json[]; on?: { action?: readonly string[] }; title: string | { one: string; many?: string }; body?: string | { one: string; many?: string } };
/**
 * Rule 47 on a direct commit: each `notifications.committed` rule of the act's collection whose `on.action` admits a
 * root write is one notice of this statement, however many rows the act wrote (`many`, `{count}` replaced; linked only
 * to a single row). `requestor` is the acting member; `{ user: field }` each distinct member the written rows name;
 * `step_approvers` has nobody on a direct commit; `{ team }`/`{ policy }` stay descriptors `notifications.deliver`
 * expands. A held act writes none: the seal writes them (rule 47). Ids derive from the invocation (retry-stable).
 */
async function committedNotices(m: EngineManifest, r: ActRequest, auth: Authority, rows: readonly { write: Write; row: RowData }[]): Promise<(NoticeRow & { id: string })[]> {
	const rules = (m.collections[r.collection]?.notifications?.committed ?? []) as readonly NoticeRule[];
	if (rules.length === 0) return [];
	const mint = await minter(`${r.invocationId}:notices`, r.bindings.now);
	const text = (t: NoticeRule['title'], n: number) => typeof t === 'string' ? t : n > 1 && t.many !== undefined ? t.many.replaceAll('{count}', String(n)) : t.one;
	return rules.flatMap((rule) => {
		const hit = rows.filter((x) => x.write.collection === r.collection && (rule.on?.action?.includes(x.write.op) ?? true));
		if (hit.length === 0) return [];
		const to = [...new Map(rule.to.flatMap((t): Json[] => t === 'requestor' ? (auth.actor.kind === 'member' ? [{ user: auth.actor.id }] : [])
			: t === 'step_approvers' ? []
			: typeof t === 'object' && t !== null && 'user' in t ? hit.flatMap((x) => typeof x.row[String(t['user'])] === 'string' ? [{ user: x.row[String(t['user'])]! }] : [])
			: [t]).map((x) => [canonical(x), x])).values()];
		const id = mint();
		return [{ id, once: id, to: { channel: rule.channel, recipients: to }, title: text(rule.title, hit.length),
			...(rule.body === undefined ? {} : { body: text(rule.body, hit.length) }),
			...(hit.length === 1 ? { link: { collection: r.collection, id: hit[0]!.write.id } } : {}) }];
	});
}

/** Rules 34, 40, 41 on an update's changed fields: `to` edges, per-state `edit`, and an owned child's fixed parent key. */
function modelRules(m: EngineManifest, model: string, row: RowData, set: RowData): { code: RefusalCode; message: string; field: string } | null {
	for (const fk of Object.keys(set)) if (m.relationships[`${model}.${fk}`]?.owned) return { code: 'invalidInput', message: 'An owned record never changes its parent.', field: fk };
	const state = stateField(m, model);
	if (state === undefined) return null;
	const spec = (m.models[model]!.fields[state] as { states: { readonly [s: string]: { to?: readonly string[]; edit?: 'all' | 'none' | readonly string[] } } }).states;
	const from = String(row[state]);
	const next = set[state];
	if (next !== undefined && !(spec[from]?.to ?? []).includes(String(next))) return { code: 'invalidInput', message: `'${from}' cannot move to '${String(next)}'.`, field: state };
	const edit = spec[from]?.edit ?? 'all';
	if (edit === 'all') return null;
	const other = Object.keys(set).find((f) => f !== state && (edit === 'none' || !edit.includes(f)));
	return other === undefined ? null : { code: 'locked', message: `The record is locked while ${state} is '${from}'.`, field: other };
}

/** Rule 41: every write on an owned relationship's child re-tests its parent's admitting states under `FOR SHARE`. */
export function ownedLocks(m: EngineManifest, cat: Catalog, writes: readonly Write[], pre: Map<string, RowData>): OwnedLock[] {
	const created = new Set(writes.filter((w) => w.op === 'create').map((w) => k(w.collection, w.id)));
	const locks = new Map<string, { child: string; parent: string; field: string; states: string[]; ids: Set<string> }>();
	for (const w of writes) for (const [fk, one] of cat.models.get(w.collection)!.one) {
		const rel = m.relationships[`${w.collection}.${fk}`];
		if (!rel?.owned || rel.inverse === undefined) continue;
		const parent = one.targets[0]!, state = stateField(m, parent);
		const id = w.op === 'create' ? w.values[fk] : pre.get(k(w.collection, w.id))?.[fk];
		if (state === undefined || typeof id !== 'string' || created.has(k(parent, id))) continue;
		const states = Object.entries((m.models[parent]!.fields[state] as { states: { readonly [s: string]: { edit?: 'all' | 'none' | readonly string[] } } }).states)
			.filter(([, s]) => (s.edit ?? 'all') === 'all' || (Array.isArray(s.edit) && s.edit.includes(rel.inverse!))).map(([s]) => s);
		const lock = locks.get(`${parent}.${rel.inverse}`) ?? { child: w.collection, parent, field: state, states, ids: new Set<string>() };
		lock.ids.add(id);
		locks.set(`${parent}.${rel.inverse}`, lock);
	}
	return [...locks.values()].map((l) => ({ ...l, ids: [...l.ids] }));
}

/** The stored rows as a workspace `db.get` answers them (§5.8: tagged wire values), one statement; `null` ids stay null. */
async function wireRows(db: TenantDb, cat: Catalog, c: string, ids: readonly (string | null)[], b: Bindings): Promise<(RowData | null)[]> {
	const want = ids.filter((id) => id !== null);
	if (want.length === 0) return ids.map(() => null);
	const [res] = await db.read([compileGets(cat, c, want, { fields: null, relations: {} }, { as: 'workspace' }, b)]);
	const byId = new Map(res!.rows.map((row) => [String((row['j'] as RowData | null)?.['id']), row['j'] as RowData]));
	return ids.map((id) => id === null ? null : byId.get(id) ?? null);
}

/** Rule 28's resolution read: the stored row each upsert's key names (null is a value in composite identity). */
async function resolveUpserts(db: TenantDb, m: EngineManifest, upserts: readonly Item[]): Promise<Map<Item, RowData>> {
	const found = new Map<Item, RowData>();
	const byTable = Map.groupBy(upserts, (i) => i.change.collection);
	if (byTable.size === 0) return found;
	const tables = [...byTable.keys()];
	const res = await db.read(tables.map((t) => {
		const on = (byTable.get(t)![0]!.change as { on: readonly string[] }).on; // hook:integrations — the act's own key
		return { text: `SELECT DISTINCT t.*, t.id::text AS id FROM ${q(t)} t JOIN jsonb_populate_recordset(null::${q(t)}, $1::jsonb) r
			ON ${on.map((f) => `t.${q(f)} IS NOT DISTINCT FROM r.${q(f)}`).join(' AND ')}`,
		params: [JSON.stringify(byTable.get(t)!.map((i) => Object.fromEntries(on.map((f) => [f, untag((i.change as { values: RowData }).values[f] ?? null, catalogOf(m).models.get(t)?.fields.get(f))]))))] };
	}));
	tables.forEach((t, i) => {
		const on = (byTable.get(t)![0]!.change as { on: readonly string[] }).on;
		for (const it of byTable.get(t)!) {
			const v = (it.change as { values: RowData }).values;
			const row = res[i]!.rows.find((row) => on.every((f) => String(row[f] ?? null) === String(untag(v[f] ?? null))));
			if (row !== undefined) found.set(it, row);
		}
	});
	return found;
}


/**
 * Rules 42, 72: what a failed guest invocation answers. A throw from tenant code is `internal` (its message reaches
 * members only, rule 32); a budget keeps its own code; anything else is a platform fault, thrown with its cause (72a).
 */
/**
 * A custom field's `validate` (§3.3.2), on the values as the engine will write them: one pure invocation per checked
 * kind over every value of it in the act; the first message refuses the write, naming the field.
 */
async function validateCustom(e: WriteEngine, r: ActRequest, writes: readonly { write: Write; item: Item }[]): Promise<Outcome | null> {
	const m = e.manifest, byKind = new Map<string, { value: Json; path: InputPath }[]>();
	for (const { write: w, item } of writes) {
		if (w.op === 'delete') continue;
		for (const [f, v] of Object.entries(w.op === 'create' ? w.values : w.set)) {
			const spec = m.models[w.collection]?.fields[f] as { kind: string; of?: string; many?: true } | undefined;
			if (spec?.kind !== 'custom' || v === null || (m.customFields[spec.of!] as { check?: true } | undefined)?.check !== true) continue;
			const values = byKind.get(spec.of!) ?? byKind.set(spec.of!, []).get(spec.of!)!;
			for (const x of spec.many && Array.isArray(v) ? v : [v]) values.push({ value: x, path: [...item.change.path, f] });
		}
	}
	for (const [of, values] of byKind) {
		if (e.guest === undefined) throw new BoltError('noGuest', 'guest', 'this host runs no guest code');
		const b = r.bindings;
		const g = await e.guest.invoke({ id: `${r.invocationId}:validate:${of}`, kind: 'validation', target: of, input: values.map((x) => x.value),
			ctx: { actor: r.authority.actor, now: b.now, today: b.today, tz: b.tz, seed: r.invocationId },
			budget: { cpuMs: LIMITS.guestCpuMs, crossings: LIMITS.crossings.sync, readBytes: LIMITS.readBytes } },
			{ cross: () => Promise.reject(new BoltError('noBridge', 'guest', 'a validation reads nothing')) });
		if (g.kind === 'failed') return guestFailure(g.error);
		if (g.kind === 'refused') return refused('invalidInput', g.message, values[0]!.path);
		const out = Array.isArray(g.output) ? g.output : [];
		const i = out.findIndex((x) => typeof x === 'string');
		if (i >= 0) return refused('invalidInput', String(out[i]), values[i]!.path);
	}
	return null;
}

function guestFailure(error: BoltError): Outcome {
	if (error.code === 'guestError' || error.code === 'internal') return refused('internal', error.message);
	if (['readBudgetExceeded', 'cpuBudget', 'crossingBudget', 'memory', 'tooLarge'].includes(error.code)) return refused(error.code as RefusalCode, error.message);
	throw error;
}

/** Rule 30 `dryRun`: the act's statement runs to its answer inside a transaction that is always rolled back. */
async function dryRun(db: TenantDb, sql: Sql, lock: Lock | undefined, meta: ReadonlyMap<string, ConstraintMeta>): Promise<Outcome> {
	const rollback = new Error('dry run');
	let outcome: Outcome | undefined;
	try {
		await db.transaction(async (tx) => {
			outcome = (await tx.query(sql)).rows[0]!['outcome'] as Outcome;
			throw rollback;
		}, lock);
	} catch (err) {
		if (err !== rollback) return decided(err, meta).outcome;
	}
	return outcome!;
}
