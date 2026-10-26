// Policies → Authority (rules 33–37, 35a): held grants union into arms, `'read'` and `via` resolve, masks derive from
// the read arms, and an administrator (or a platform run) bypasses authored policy. Plus what a write and a read
// consult of it: `moves` (rule 34) and the read scope (rule 13); the write judge itself is `write/act.ts`'s.
import { Schema } from 'effect';
import type { Admits, WritableColumns, VisitorMayRead, OperandValue } from '../services.ts';
import type {
	Arm,
	Authority,
	CollectionAuthority,
	EngineActor,
	LimitRule,
	WriteArm
} from '../contracts.ts';
import { ScopeData, type EngineManifest, type GrantArm } from '../manifest.ts';
import type { Pred } from '@norbital-ai/store';
import { or, toPred, TRUE } from './pred.ts';
import type { Rate } from '../../decl/values.ts';
import { SYSTEM_COLUMNS } from '@norbital-ai/store';
import { SYSTEM } from '../../system/index.ts';

/** Whom an Authority is compiled for: resolved by `identity/actor`. */
export type Holder = {
	actor: EngineActor;
	policies: readonly string[];
	/** Rule 35: bypasses grants, `moves` and approval flows; preserves checks, edges, `edit` and write callbacks. */
	admin: boolean;
	/** A platform run: the workspace's own work, unscoped like an admin but never an administrator (rule 38c). */
	platform?: boolean;
	teamTree?: readonly string[];
	scopes?: { readonly [policy: string]: readonly string[] };
};

const OPS = ['create', 'update', 'delete'] as const;
/** Identity collections: read by grant or the kernel directory, written only by their admin verbs (rule 38c). */
const IDENTITY = ['sys_user', 'sys_invitation', 'sys_api_key'] as const;
const KERNEL = '$directory';

const emptyCollection = (): Mutable => ({
	read: [],
	history: [],
	create: [],
	update: [],
	delete: [],
	queries: [],
	moves: {},
	masks: {}
});
type Mutable = {
	-readonly [
		K in Exclude<keyof CollectionAuthority, 'moves'>
	]: CollectionAuthority[K] extends readonly (infer T)[] ? T[] : CollectionAuthority[K];
} & {
	moves: { [field: string]: 'all' | readonly string[] };
};

const isScope = Schema.is(ScopeData);
/** A grant object is `{ where?, fields?, previous?, approval? }` unless the model has a field of that name. */
export function scopeObject(
	m: EngineManifest,
	model: string,
	g: GrantArm | undefined
): ScopeData | undefined {
	if (typeof g !== 'object' || !isScope(g)) return undefined;
	const keys = Object.keys(g);
	const own = m.models[model]?.fields ?? {};
	return keys.length > 0 &&
		keys.every(
			(k) => ['where', 'fields', 'previous', 'approval'].includes(k) && own[k] === undefined
		)
		? g
		: undefined;
}

function readArm(
	m: EngineManifest,
	c: string,
	policy: string,
	g: GrantArm | undefined
): Arm | undefined {
	if (g === undefined) return undefined;
	if (g === true) return { policy, where: TRUE, fields: 'all' };
	const s = scopeObject(m, c, g);
	if (s === undefined) return { policy, where: toPred(m, c, g), fields: 'all' };
	return {
		policy,
		where: s.where === undefined ? TRUE : toPred(m, c, s.where),
		fields: s.fields ?? 'all'
	};
}
function writeArm(
	m: EngineManifest,
	c: string,
	policy: string,
	g: GrantArm | undefined,
	read: Arm | undefined
): WriteArm | undefined {
	if (g === undefined) return undefined;
	const scope = (w: GrantArm | undefined): Pred =>
		w === undefined || w === true ? TRUE : w === 'read' ? (read?.where ?? TRUE) : toPred(m, c, w);
	const s = scopeObject(m, c, g);
	if (s === undefined) return { policy, where: scope(g), fields: 'all' };
	return {
		policy,
		where: scope(s.where),
		fields: s.fields ?? 'all',
		...(s.previous === undefined ? {} : { previous: scope(s.previous) }),
		// the manifest marks the policy's approval callback (the guest runs it, kind `approval`)
		...(s.approval === true ? { approval: s.approval } : {})
	};
}

/** Columns a caller may name: the collection's read exposure plus `id` (rule 10); a system collection's are the built-in layer's. */
function exposed(m: EngineManifest, c: string): readonly string[] {
	const sys = Object.hasOwn(SYSTEM.collections, c);
	const f = (sys ? SYSTEM.collections : m.collections)[c]?.read.fields;
	const model = (sys ? SYSTEM.models : m.models)[c];
	// a relationship's foreign key is a field of its model too (rule 14: a read grant's `fields` masks an unlisted one)
	const fks = Object.keys(sys ? SYSTEM.relationships : m.relationships)
		.filter((k) => k.slice(0, k.indexOf('.')) === c)
		.map((k) => k.slice(k.indexOf('.') + 1));
	// a system row's `revision`, `created_at` and the like are its own fields, unmasked as every row's system columns are
	const all = [
		...Object.keys(model?.fields ?? {}),
		...Object.keys(model?.computed ?? {}),
		...fks
	].filter((x) => !sys || !(SYSTEM_COLUMNS as readonly string[]).includes(x));
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

/** The kernel directory grant (rule 35a): staff read staff, externals read themselves and their party. Teams are source. */
function directory(actor: EngineActor): { [c: string]: Arm } {
	if (actor.kind !== 'member') return {};
	const fields = ['id', 'name'];
	const self: Pred = { t: 'cmp', field: 'id', op: 'eq', arg: { _tag: 'Actor', of: 'id' } };
	const user: Pred = actor.external
		? or([self, { t: 'cmp', field: 'party_id', op: 'eq', arg: { _tag: 'Actor', of: 'party' } }])
		: { t: 'cmp', field: 'kind', op: 'eq', arg: { _tag: 'Lit', value: 'staff' } };
	return { sys_user: { policy: KERNEL, where: user, fields } };
}

// ── limits (rule 38, rule 72 defaults) ──
const DEFAULTS: readonly LimitRule[] = [
	{ key: 'act', rate: '600/min', per: 'actor' },
	{ key: 'read', rate: '3000/min', per: 'actor' },
	{ key: 'upload', rate: '120/min', per: 'actor' },
	{ key: 'convert', rate: '30/min', per: 'actor' },
	{ key: 'agent', rate: '100/h', per: 'actor' },
	// a private envoy's one fixed "not recognised" reply to an unknown sender: once per window, so a flood is never answered by one
	{ key: 'envoys.unrecognised', rate: '1/15min', per: 'sender' }
];
const VISITOR_DEFAULTS: readonly LimitRule[] = [
	{ key: 'register', rate: '20/h', per: 'ip' },
	{ key: 'upload', rate: '20/h', per: 'ip' },
	{ key: 'read', rate: '600/min', per: 'ip' }
];
function limitRules(key: string, v: unknown): LimitRule[] {
	const envoy = key.startsWith('envoys.');
	const one = (x: unknown): LimitRule =>
		typeof x === 'string'
			? { key, rate: x as Rate, per: envoy ? 'sender' : 'actor' }
			: { key, rate: (x as { rate: Rate }).rate, per: (x as { per: LimitRule['per'] }).per };
	return Array.isArray(v) ? v.map(one) : [one(v)];
}

/** Compiles once per `key` (rule 37); the caller caches by that key. */
export function compileAuthority(m: EngineManifest, holder: Holder, key: string): Authority {
	const bypass = holder.admin || holder.platform === true;
	const policies = holder.policies.filter((p) => Object.hasOwn(m.policies, p)); // an unknown policy confers nothing
	const cols: { [c: string]: Mutable } = {};
	const col = (c: string) => (cols[c] ??= emptyCollection());
	const via: { c: string; rel: string }[] = [];
	if (bypass) {
		// an admin manages the integration instances too (FINAL §3); identity is the admin verbs'
		for (const c of [
			...Object.keys(m.collections),
			...(holder.admin ? [...IDENTITY, 'sys_integration'] : [])
		]) {
			const a = col(c),
				all: WriteArm = { policy: '$admin', where: TRUE, fields: 'all' };
			a.read.push(all);
			a.history.push(all);
			if (!(IDENTITY as readonly string[]).includes(c))
				(a.create.push(all), a.update.push(all), a.delete.push(all));
			a.queries.push(...Object.keys(m.collections[c]?.queries ?? {}));
			for (const [f, k] of Object.entries(m.models[c]?.fields ?? {}))
				if (k.kind === 'state') a.moves[f] = 'all';
		}
	} else {
		for (const p of policies)
			for (const [c, g] of Object.entries(m.policies[p]!.grants)) {
				if (g.via !== undefined) {
					via.push({ c, rel: g.via });
					continue;
				}
				const a = col(c);
				const read = readArm(m, c, p, g.read);
				if (read) a.read.push(read);
				const history = readArm(m, c, p, g.history);
				if (history) a.history.push(history);
				for (const op of OPS) {
					const w = writeArm(m, c, p, g[op], read);
					if (w) a[op].push(w);
				}
				a.queries.push(...(g.queries ?? []));
				if (g.moves === 'all')
					for (const [f, k] of Object.entries(m.models[c]?.fields ?? {})) {
						if (k.kind === 'state') a.moves[f] = 'all';
					}
				else
					for (const [f, edges] of Object.entries(g.moves ?? {})) {
						const had = a.moves[f];
						a.moves[f] = had === 'all' ? 'all' : [...new Set([...(had ?? []), ...edges])];
					}
			}
		// `via`: the child's rows are the parent's; reads follow the parent's read, writes the parent's update (a child
		// is edited as part of its parent). A parent that is itself `via` is lifted first, so a chain nests to any depth.
		const lifted = new Set<(typeof via)[number]>();
		const liftVia = (v: (typeof via)[number]): void => {
			if (lifted.has(v)) return;
			lifted.add(v);
			const { c, rel } = v,
				parent = m.relationships[`${c}.${rel}`]?.to;
			if (typeof parent !== 'string') return;
			for (const u of via) if (u.c === parent) liftVia(u);
			const p = cols[parent],
				a = col(c);
			// the parent's approval callback judges the parent's writes; a child it lifts to writes directly
			const lift = ({ approval: _approval, ...arm }: WriteArm): WriteArm => ({
				...arm,
				where: { t: 'one', rel, target: parent, pred: arm.where },
				fields: 'all'
			});
			if (p === undefined) return;
			a.read.push(...p.read.map(lift));
			a.history.push(...p.history.map(lift));
			for (const op of OPS) a[op].push(...p.update.map(lift));
		};
		for (const v of via) liftVia(v);
		for (const [c, arm] of Object.entries(directory(holder.actor))) col(c).read.push(arm);
	}
	for (const [c, a] of Object.entries(cols)) {
		a.queries = [...new Set(a.queries)];
		if (!bypass) a.masks = masks(m, c, a.read);
	}
	const caps = {
		apps: new Set<string>(),
		kiosks: new Set<string>(),
		tools: new Set<string>(),
		mcp: new Set<string>(),
		skills: new Set<string>()
	};
	const automations = new Set<string>();
	const declared: LimitRule[] = [];
	for (const p of policies) {
		const spec = m.policies[p]!;
		for (const k of ['apps', 'kiosks', 'tools', 'mcp', 'skills'] as const)
			for (const x of spec.capabilities?.[k] ?? []) caps[k].add(x);
		for (const x of spec.automations ?? []) automations.add(x);
		for (const [k, v] of Object.entries(spec.limits ?? {})) declared.push(...limitRules(k, v));
	}
	const defaults = holder.actor.kind === 'visitor' ? VISITOR_DEFAULTS : DEFAULTS;
	const limits = [...declared, ...defaults.filter((d) => !declared.some((x) => x.key === d.key))];
	const list = <T>(s: Set<T>) => [...s];
	return {
		key,
		actor: holder.actor,
		admin: holder.admin,
		policies,
		collections: cols,
		automations: bypass ? Object.keys(m.automations) : list(automations),
		capabilities: {
			apps: list(caps.apps),
			kiosks: list(caps.kiosks),
			tools: list(caps.tools),
			mcp: list(caps.mcp),
			skills: list(caps.skills)
		},
		limits,
		teamTree: holder.teamTree ?? [],
		scopes: holder.scopes ?? {}
	};
}

/** Rule 34: a generated write moves a state only along an edge its grant lists (`'all'`: every declared edge). */
export function admitMove(
	auth: Authority,
	collection: string,
	field: string,
	from: string,
	to: string
): boolean {
	if (auth.admin || from === to) return true;
	const moves = auth.collections[collection]?.moves[field];
	return moves === 'all' || (moves ?? []).includes(`${from}->${to}`);
}

/** The read scope of a caller (rule 13): the union of its read arms; `undefined` = no read grant at all. */
export function readScope(
	auth: Authority,
	collection: string,
	kind: 'read' | 'history' = 'read'
): Pred | undefined {
	const arms = auth.collections[collection]?.[kind] ?? [];
	return arms.length === 0 ? undefined : or(arms.map((a) => a.where));
}

/** The common field admission used by reads, writes and UI advice. */
export const admits: Admits = (arms, field) =>
	arms.some((arm) => arm.fields === 'all' || arm.fields.includes(field));
export const writableColumns: WritableColumns = (authority, collection, verb) => {
	if (authority.admin) return 'all';
	const arms = authority.collections[collection]?.[verb] ?? [];
	return arms.some((arm) => arm.fields === 'all')
		? 'all'
		: new Set(arms.flatMap((arm) => arm.fields));
};
export const visitorMayRead: VisitorMayRead = (authority, collection) =>
	authority.actor.kind === 'visitor' && (authority.collections[collection]?.read.length ?? 0) > 0;
/** Actor operands have one interpretation across SQL, live evaluation and write admission. */
export const operandValue: OperandValue = (operand, authority) => {
	const actor = authority.actor;
	const member =
		actor.kind === 'member' ? actor : actor.kind === 'envoy' ? (actor.linked ?? null) : null;
	const of = operand.of;
	if (typeof of === 'object') return [...(authority.scopes[of.scopes] ?? [])];
	switch (of) {
		case 'teamTree':
			return [...authority.teamTree];
		case 'instance':
			return actor.kind === 'envoy'
				? actor.instance
				: actor.kind === 'system' && 'instance' in actor.by
					? actor.by.instance
					: null;
		case 'teams':
			return member === null ? [] : [...member.teams];
		case 'id':
			return member?.id ?? null;
		case 'email':
			return member?.email ?? null;
		case 'phone':
			return member?.phone ?? null;
		case 'visitor':
			return actor.kind === 'visitor' ? actor.visitor : null;
		case 'party':
			return member?.party?.id ?? null;
	}
};

/**
 * A model a read-only remote sync owns (spec §3: a sync with `read` and no `write`): its rows come from that sync, so
 * every other writer, administrators included, changes only its local fields (its `update.columns`) and never creates
 * or deletes one. A read+write sync leaves the fields editable (each edit reaches the outbox).
 */
export function syncOwned(
	m: EngineManifest,
	model: string
): { readonly sync: string; readonly local: readonly string[] } | undefined {
	const spec = m.collections[model];
	for (const [name, s] of Object.entries(spec?.syncs ?? {}))
		if (s.with !== 'file' && s.read === true && s.write !== true)
			return { sync: `${model}.sync.${name}`, local: spec?.update?.input.columns ?? [] };
	return undefined;
}
