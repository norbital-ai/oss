// Policies → Authority (rules 33–37, 35a): held grants union into arms, `'read'` and `via` resolve, masks derive from
// the read arms, and an administrator (or a platform run) bypasses authored policy. Plus the admission judge a write
// consults: the scope of each arm over the pre- and post-image, fields admitted one by one, and `moves`.
import type {
	ApprovalRoute, Arm, Authority, Bindings, CollectionAuthority, EngineActor, EngineManifest, LimitRule, Pred, RowData, WriteArm
} from '../contracts.ts';
import type { Json } from '../../decl/values.ts';
import { holds, or, toPred, TRUE, type Env } from './pred.ts';
import type { Rate } from '../../decl/values.ts';
import { SYSTEM_COLUMNS } from '../../protocol/catalog.ts';
import { SYSTEM } from '../../system/index.ts';

/** Whom an Authority is compiled for: resolved by `identity/actor`. */
export type Holder = {
	actor: EngineActor; policies: readonly string[];
	/** Rule 35: bypasses grants, `moves` and approval flows; never checks, edges, `edit`, transforms or holds. */
	admin: boolean;
	/** A platform run: the workspace's own work, unscoped like an admin but never an administrator (rule 38c). */
	platform?: boolean;
	teamTree?: readonly string[]; scopes?: { readonly [policy: string]: readonly string[] };
};

type Obj = { readonly [k: string]: unknown };
const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);
const OPS = ['create', 'update', 'delete'] as const;
type Op = (typeof OPS)[number];
/** Identity collections: read by grant or the kernel directory, written only by their admin verbs (rule 38c). */
export const IDENTITY = ['sys_user', 'sys_team', 'sys_assignment', 'sys_invitation', 'sys_api_key'] as const;
const KERNEL = '$directory';

const emptyCollection = (): Mutable => ({ read: [], history: [], create: [], update: [], delete: [], queries: [], actions: [], moves: {}, masks: {} });
type Mutable = { -readonly [K in Exclude<keyof CollectionAuthority, 'moves'>]: CollectionAuthority[K] extends readonly (infer T)[] ? T[] : CollectionAuthority[K] }
	& { moves: { [field: string]: 'all' | readonly string[] } };

/** A grant object is `{ where?, fields?, previous?, approval? }` unless the model has a field of that name. */
function scopeObject(m: EngineManifest, model: string, v: unknown): Obj | undefined {
	if (!isObj(v)) return undefined;
	const keys = Object.keys(v);
	const own = m.models[model]?.fields ?? {};
	return keys.length > 0 && keys.every((k) => ['where', 'fields', 'previous', 'approval'].includes(k) && own[k] === undefined) ? v : undefined;
}
const routes = (a: unknown): readonly ApprovalRoute[] => a === undefined ? [] : (Array.isArray(a) ? a : [a]) as readonly ApprovalRoute[];

function readArm(m: EngineManifest, c: string, policy: string, g: unknown): Arm | undefined {
	if (g === undefined) return undefined;
	if (g === true) return { policy, where: TRUE, fields: 'all' };
	const s = scopeObject(m, c, g);
	if (s === undefined) return { policy, where: toPred(m, c, g), fields: 'all' };
	return { policy, where: s.where === undefined ? TRUE : toPred(m, c, s.where), fields: (s.fields as readonly string[] | undefined) ?? 'all' };
}
function writeArm(m: EngineManifest, c: string, policy: string, g: unknown, read: Arm | undefined): WriteArm | undefined {
	if (g === undefined) return undefined;
	const scope = (w: unknown): Pred => w === undefined || w === true ? TRUE : w === 'read' ? read?.where ?? TRUE : toPred(m, c, w);
	const s = scopeObject(m, c, g);
	if (s === undefined) return { policy, where: scope(g), fields: 'all', approval: [] };
	return { policy, where: scope(s.where), fields: (s.fields as readonly string[] | undefined) ?? 'all', approval: routes(s.approval),
		...(s.previous === undefined ? {} : { previous: scope(s.previous) }) };
}

/** Columns a caller may name: the collection's read exposure plus `id` (rule 10); a system collection's are the built-in layer's. */
function exposed(m: EngineManifest, c: string): readonly string[] {
	const sys = Object.hasOwn(SYSTEM.collections, c);
	const f = (sys ? SYSTEM.collections : m.collections)[c]?.read.fields;
	const model = (sys ? SYSTEM.models : m.models)[c];
	// a relationship's foreign key is a field of its model too (rule 14: a read grant's `fields` masks an unlisted one)
	const fks = Object.keys(sys ? SYSTEM.relationships : m.relationships).filter((k) => k.slice(0, k.indexOf('.')) === c).map((k) => k.slice(k.indexOf('.') + 1));
	// a system row's `revision`, `created_at` and the like are its own fields, unmasked as every row's system columns are
	const all = [...Object.keys(model?.fields ?? {}), ...Object.keys(model?.computed ?? {}), ...fks]
		.filter((x) => !sys || !(SYSTEM_COLUMNS as readonly string[]).includes(x));
	return f === undefined || f === 'all' ? all : f;
}
/** Rule 14: a field no read arm narrows is unmasked; otherwise it shows where an arm that lists it holds. */
function masks(m: EngineManifest, c: string, read: readonly Arm[]): { [field: string]: Pred } {
	const out: { [field: string]: Pred } = {};
	if (read.length === 0) return out;
	for (const f of exposed(m, c)) {
		const admitting = read.filter((a) => a.fields === 'all' || a.fields.includes(f));
		const mask = or(admitting.map((a) => a.where));
		if (admitting.length !== read.length && !(mask.t === 'const' && mask.value)) out[f] = mask;
	}
	delete out.id;
	return out;
}

/** The kernel directory grants (rule 35a): staff read staff, externals read themselves and their party, members their own assignments. */
function directory(actor: EngineActor): { [c: string]: Arm } {
	if (actor.kind !== 'member') return {};
	const fields = ['id', 'name'];
	const self: Pred = { t: 'cmp', field: 'id', op: 'eq', arg: { actor: 'id' } };
	const user: Pred = actor.external ? or([self, { t: 'cmp', field: 'party_id', op: 'eq', arg: { actor: 'party' } }])
		: { t: 'cmp', field: 'kind', op: 'eq', arg: { lit: 'staff' } };
	return {
		sys_user: { policy: KERNEL, where: user, fields },
		...(actor.external ? {} : { sys_team: { policy: KERNEL, where: TRUE, fields } }),
		sys_assignment: { policy: KERNEL, where: { t: 'cmp', field: 'principal', op: 'eq', arg: { actor: 'id' } }, fields: 'all' },
	};
}

// ── limits (rule 38, rule 72 defaults) ──
const DEFAULTS: readonly LimitRule[] = [
	{ key: 'act', rate: '600/min', per: 'actor' }, { key: 'read', rate: '3000/min', per: 'actor' },
	{ key: 'upload', rate: '120/min', per: 'actor' }, { key: 'agent', rate: '100/h', per: 'actor' },
	{ key: 'envoys.registration', rate: '1/15min', per: 'sender' },
];
const VISITOR_DEFAULTS: readonly LimitRule[] = [
	{ key: 'register', rate: '20/h', per: 'ip' }, { key: 'upload', rate: '20/h', per: 'ip' }, { key: 'read', rate: '600/min', per: 'ip' },
];
function limitRules(key: string, v: unknown): LimitRule[] {
	const envoy = key.startsWith('envoys.');
	const one = (x: unknown): LimitRule => typeof x === 'string' ? { key, rate: x as Rate, per: envoy ? 'sender' : 'actor' }
		: { key, rate: (x as { rate: Rate }).rate, per: (x as { per: LimitRule['per'] }).per };
	return Array.isArray(v) ? v.map(one) : [one(v)];
}

/** Compiles once per `key` (rule 37); the caller caches by that key. */
export function compileAuthority(m: EngineManifest, holder: Holder, key: string): Authority {
	const bypass = holder.admin || holder.platform === true;
	const policies = holder.policies.filter((p) => m.policies[p] !== undefined);   // an unknown policy confers nothing
	const cols: { [c: string]: Mutable } = {};
	const col = (c: string) => (cols[c] ??= emptyCollection());
	const via: { c: string; rel: string }[] = [];
	if (bypass) {
		for (const c of [...Object.keys(m.collections), ...(holder.admin ? IDENTITY : [])]) {
			const a = col(c), all: WriteArm = { policy: '$admin', where: TRUE, fields: 'all', approval: [] };
			a.read.push(all); a.history.push(all);
			if (!(IDENTITY as readonly string[]).includes(c)) a.create.push(all), a.update.push(all), a.delete.push(all);
			a.queries.push(...Object.keys(m.collections[c]?.queries ?? {}));
			a.actions.push(...Object.keys(m.collections[c]?.actions ?? {}));
			for (const [f, k] of Object.entries(m.models[c]?.fields ?? {})) if (k.kind === 'state') a.moves[f] = 'all';
		}
	} else {
		for (const p of policies) for (const [c, g] of Object.entries(m.policies[p]!.grants)) {
			if ('via' in g) { via.push({ c, rel: g.via as string }); continue; }
			const a = col(c);
			const read = readArm(m, c, p, g.read);
			if (read) a.read.push(read);
			const history = readArm(m, c, p, g.history);
			if (history) a.history.push(history);
			for (const op of OPS) { const w = writeArm(m, c, p, g[op], read); if (w) a[op].push(w); }
			a.queries.push(...(g.queries as string[] | undefined ?? []));
			a.actions.push(...(g.actions as string[] | undefined ?? []));
			if (g.moves === 'all') for (const [f, k] of Object.entries(m.models[c]?.fields ?? {})) { if (k.kind === 'state') a.moves[f] = 'all'; }
			else for (const [f, edges] of Object.entries((g.moves ?? {}) as Obj)) {
				const had = a.moves[f];
				a.moves[f] = had === 'all' ? 'all' : [...new Set([...(had ?? []), ...(edges as string[])])];
			}
		}
		// `via`: the child's rows are the parent's; reads follow the parent's read, writes the parent's update (a child
		// is edited as part of its parent). A parent that is itself `via` is lifted first, so a chain nests to any depth.
		const lifted = new Set<(typeof via)[number]>();
		const liftVia = (v: (typeof via)[number]): void => {
			if (lifted.has(v)) return;
			lifted.add(v);
			const { c, rel } = v, parent = m.relationships[`${c}.${rel}`]?.to;
			if (typeof parent !== 'string') return;
			for (const u of via) if (u.c === parent) liftVia(u);
			const p = cols[parent], a = col(c);
			const lift = <A extends Arm>(arm: A): A => ({ ...arm, where: { t: 'one', rel, target: parent, pred: arm.where }, fields: 'all' });
			if (p === undefined) return;
			a.read.push(...p.read.map(lift)); a.history.push(...p.history.map(lift));
			for (const op of OPS) a[op].push(...p.update.map(lift));
		};
		for (const v of via) liftVia(v);
		for (const [c, arm] of Object.entries(directory(holder.actor))) col(c).read.push(arm);
	}
	for (const [c, a] of Object.entries(cols)) {
		a.queries = [...new Set(a.queries)]; a.actions = [...new Set(a.actions)];
		if (!bypass) a.masks = masks(m, c, a.read);
	}
	const caps = { apps: new Set<string>(), tools: new Set<string>(), mcp: new Set<string>(), skills: new Set<string>() };
	const automations = new Set<string>();
	const declared: LimitRule[] = [];
	for (const p of policies) {
		const spec = m.policies[p]!;
		for (const k of ['apps', 'tools', 'mcp', 'skills'] as const) for (const x of spec.capabilities?.[k] ?? []) caps[k].add(x);
		for (const x of spec.automations ?? []) automations.add(x);
		for (const [k, v] of Object.entries(spec.limits ?? {})) declared.push(...limitRules(k, v));
	}
	const defaults = holder.actor.kind === 'visitor' ? VISITOR_DEFAULTS : DEFAULTS;
	const limits = [...declared, ...defaults.filter((d) => !declared.some((x) => x.key === d.key))];
	const list = <T>(s: Set<T>) => [...s];
	return {
		key, actor: holder.actor, admin: holder.admin, policies, collections: cols,
		automations: bypass ? Object.keys(m.automations) : list(automations),
		capabilities: { apps: list(caps.apps), tools: list(caps.tools), mcp: list(caps.mcp), skills: list(caps.skills) },
		limits, teamTree: holder.teamTree ?? [], scopes: holder.scopes ?? {},
	};
}

// ── admission ──
/** Operand values of one invocation: the caller's authority plus the clock and params (rule 26). */
export function envFor(auth: Authority, b: Bindings, masks?: Env['masks']): Env {
	const a = auth.actor.kind === 'envoy' ? auth.actor.linked ?? auth.actor : auth.actor; // hook:envoys — a DM's operands are the linked member's (P32)
	return {
		now: b.now, today: b.today, params: b.params, ...(masks === undefined ? {} : { masks }),
		actor: (op) => {
			if (typeof op === 'object') return auth.scopes[op.scopes] ?? [];
			if (op === 'teamTree') return auth.teamTree;
			if (a.kind !== 'member') return op === 'teams' ? [] : a.kind === 'apiKey' && op === 'id' ? a.key : null;
			return op === 'id' ? a.id : op === 'email' ? a.email : op === 'teams' ? a.teams : a.party?.id ?? null;
		},
	};
}

export type Admission = { ok: true; routes: readonly ApprovalRoute[] } | { ok: false; field?: string };
/**
 * Rule 35 for one row: a `create` is scoped on the post-image, an `update` on both (or `previous` on the pre-image and
 * `where` on the post-image), a `delete` on the stored row. Each supplied field needs one arm whose scope and `fields`
 * both admit it. The first arm admitting every field decides the approval flow (§3.8).
 */
export function admitWrite(auth: Authority, collection: string, op: Op, rows: { pre: RowData | null; post: RowData | null },
	supplied: readonly string[], b: Bindings): Admission {
	if (auth.admin) return { ok: true, routes: [] };
	const env = envFor(auth, b);
	const is = (p: Pred, row: RowData | null) => row !== null && holds(p, row, env);
	const scoped = (auth.collections[collection]?.[op] ?? []).filter((a) =>
		op === 'create' ? is(a.where, rows.post)
		: op === 'delete' ? is(a.where, rows.pre)
		: a.previous !== undefined ? is(a.previous, rows.pre) && is(a.where, rows.post)
		: is(a.where, rows.pre) && is(a.where, rows.post));
	if (scoped.length === 0) return { ok: false };
	const admits = (a: WriteArm, f: string) => a.fields === 'all' || a.fields.includes(f);
	const refused = supplied.find((f) => !scoped.some((a) => admits(a, f)));
	if (refused !== undefined) return { ok: false, field: refused };
	return { ok: true, routes: (scoped.find((a) => supplied.every((f) => admits(a, f))) ?? scoped[0]!).approval };
}

/** Rule 34: a generated write moves a state only along an edge its grant lists (`'all'`: every declared edge). */
export function admitMove(auth: Authority, collection: string, field: string, from: string, to: string): boolean {
	if (auth.admin || from === to) return true;
	const moves = auth.collections[collection]?.moves[field];
	return moves === 'all' || (moves ?? []).includes(`${from}->${to}`);
}

/** Rule 35: the one transform refusal an administrator skips is the delete guard of `delete: { transform: true }`. */
export const skipsDeleteGuard = (auth: Authority): boolean => auth.admin;

/** The read scope of a caller (rule 13): the union of its read arms; `undefined` = no read grant at all. */
export function readScope(auth: Authority, collection: string, kind: 'read' | 'history' = 'read'): Pred | undefined {
	const arms = auth.collections[collection]?.[kind] ?? [];
	return arms.length === 0 ? undefined : or(arms.map((a) => a.where));
}
