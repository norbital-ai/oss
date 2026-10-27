// Policies → Authority (rules 33–37, 35a): held grants union into arms per read path, write arms carry the columns they
// admit per write path and whether a `check` judges them, masks derive per path from the read arms, and an administrator
// (or a platform run) bypasses authored policy. Plus what a write and a read consult of it: `moves` (rule 34) and the read
// scope (rule 13); the write judge itself is `write/act.ts`'s.
import { Schema } from 'effect';
import type { Admits, WritableColumns, VisitorMayRead, OperandValue } from '../services.ts';
import type { Arm, Authority, DeleteArm, EngineActor, LimitRule, WriteArm } from '../contracts.ts';
import {
	layered,
	layers,
	LayerGrant,
	ScopeData,
	type EngineManifest,
	type GrantArm,
	type GrantData
} from '../manifest.ts';
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

const WRITES = ['create', 'update'] as const;
/** Identity models: read by grant or the kernel directory, written only by their admin verbs (rule 38c). */
const IDENTITY = ['sys_user', 'sys_invitation', 'sys_api_key'] as const;
const isIdentity = (c: string) => (IDENTITY as readonly string[]).includes(c);
const KERNEL = '$directory';

type Mutable = {
	read: { [path: string]: Arm[] };
	history: Arm[];
	create: WriteArm[];
	update: WriteArm[];
	delete: DeleteArm[];
	moves: { [field: string]: 'all' | readonly string[] };
	masks: { [path: string]: { [field: string]: Pred } };
};
const emptyModel = (): Mutable => ({
	read: {},
	history: [],
	create: [],
	update: [],
	delete: [],
	moves: {},
	masks: {}
});

const isScope = Schema.is(ScopeData),
	isLayer = Schema.is(LayerGrant);
/** A `history` grant object is `{ where?, fields? }` unless the model has a field of that name. */
export function scopeObject(
	m: EngineManifest,
	model: string,
	g: GrantArm | undefined
): ScopeData | undefined {
	if (typeof g !== 'object' || !isScope(g)) return undefined;
	const keys = Object.keys(g);
	const own = m.models[model]?.fields ?? {};
	return keys.length > 0 &&
		keys.every((k) => ['where', 'fields'].includes(k) && own[k] === undefined)
		? g
		: undefined;
}
/** A `history` (or identity `read`) grant as one arm: `true`, a scope object or a bare `Where`. */
function scopeArm(
	m: EngineManifest,
	c: string,
	policy: string,
	g: GrantArm | undefined,
	fields: readonly string[] | undefined
): Arm | undefined {
	if (g === undefined) return undefined;
	if (g === true) return { policy, where: TRUE, fields: fields ?? 'all' };
	const s = scopeObject(m, c, g);
	if (s === undefined) return { policy, where: toPred(m, c, g), fields: fields ?? 'all' };
	return {
		policy,
		where: s.where === undefined || s.where === true ? TRUE : toPred(m, c, s.where),
		fields: s.fields ?? fields ?? 'all'
	};
}
/** The read paths `c` declares (its root first), each with the model behind it. */
const pathsOf = (m: EngineManifest, c: string): readonly (readonly [string, string])[] => {
	const read = layered(m).exposures[c]?.read ?? {};
	const declared = Object.entries(layers(m)[c] ?? {}).filter(([path]) => Object.hasOwn(read, path));
	return declared.length === 0 ? [[c, c]] : declared;
};
/**
 * One policy's read arms of `c`, one per declared path (decision 3): the grant's layer `where` and `fields` at a path it
 * names, `{ where: true, fields: 'all' }` at one it does not. An identity model's grant is a bare `Where` with
 * `fields` beside it, at the root.
 */
function readArms(
	m: EngineManifest,
	c: string,
	policy: string,
	g: GrantData
): { readonly [path: string]: Arm } | undefined {
	const read = g.read;
	if (read === undefined) return undefined;
	const open: Arm = { policy, where: TRUE, fields: 'all' };
	const out: { [path: string]: Arm } = {};
	for (const [path, model] of pathsOf(m, c)) {
		if (read === true) out[path] = open;
		else if (isIdentity(c))
			out[path] = path === c ? (scopeArm(m, c, policy, read, g.fields) ?? open) : open;
		else {
			const layer = read[path];
			out[path] = !isLayer(layer)
				? open
				: {
						policy,
						where: layer.where === undefined ? TRUE : toPred(m, model, layer.where),
						fields: layer.fields ?? 'all'
					};
		}
	}
	return out;
}
/** A create or update arm: the columns it admits per write path (default: every column `c` declares) and its `check`. */
function writeArm(
	m: EngineManifest,
	c: string,
	op: (typeof WRITES)[number],
	policy: string,
	g: GrantData[(typeof WRITES)[number]]
): WriteArm | undefined {
	if (g === undefined) return undefined;
	const declared = layered(m).exposures[c]?.[op]?.columns ?? {};
	return {
		policy,
		columns: g === true ? declared : (g.columns ?? declared),
		check: g !== true && g.check === true
	};
}

/** The fields a layer exposes (rule 10), its FKs included; a system model's are its own fields minus the system columns. */
function exposed(m: EngineManifest, root: string, path: string, model: string): readonly string[] {
	const all = layered(m);
	const sys = Object.hasOwn(SYSTEM.models, model);
	const f = all.exposures[root]?.read[path]?.fields;
	// a relationship's foreign key is a field of its model too (rule 14: a read grant's `fields` masks an unlisted one)
	const fks = Object.keys(all.relationships)
		.filter((k) => k.slice(0, k.indexOf('.')) === model)
		.map((k) => k.slice(k.indexOf('.') + 1));
	// a system row's `revision`, `created_at` and the like are its own fields, unmasked as every row's system columns are
	const own = [
		...Object.keys(all.models[model]?.fields ?? {}),
		...Object.keys(all.models[model]?.computed ?? {}),
		...fks
	].filter((x) => !sys || !(SYSTEM_COLUMNS as readonly string[]).includes(x));
	return f === undefined || f === 'all' ? own : f;
}
/** Rule 14 per path: a field no arm narrows is unmasked; otherwise it shows where an arm that lists it holds. */
function masks(
	m: EngineManifest,
	root: string,
	path: string,
	model: string,
	read: readonly Arm[]
): { [field: string]: Pred } {
	const out: { [field: string]: Pred } = {};
	if (read.length === 0) return out;
	for (const f of exposed(m, root, path, model)) {
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
	const col = (c: string) => (cols[c] ??= emptyModel());
	const addRead = (c: string, arms: { readonly [path: string]: Arm }) => {
		const a = col(c);
		for (const [path, arm] of Object.entries(arms)) (a.read[path] ??= []).push(arm);
	};
	if (bypass) {
		// an admin manages the integration instances too (FINAL §3); identity is the admin verbs'
		const all = layered(m).exposures;
		for (const c of [
			...Object.keys(m.exposures),
			...(holder.admin ? [...IDENTITY, 'sys_integration'] : [])
		]) {
			const a = col(c),
				open: Arm = { policy: '$admin', where: TRUE, fields: 'all' };
			addRead(c, Object.fromEntries(pathsOf(m, c).map(([path]) => [path, open])));
			a.history.push(open);
			if (!isIdentity(c)) {
				for (const op of WRITES)
					a[op].push({ policy: '$admin', columns: all[c]?.[op]?.columns ?? {}, check: false });
				a.delete.push({ policy: '$admin', check: false });
			}
			for (const [f, k] of Object.entries(m.models[c]?.fields ?? {}))
				if (k.kind === 'state') a.moves[f] = 'all';
		}
	} else {
		for (const p of policies)
			for (const [c, g] of Object.entries(m.policies[p]!.grants)) {
				const a = col(c);
				const read = readArms(m, c, p, g);
				if (read) addRead(c, read);
				const history = scopeArm(m, c, p, g.history, undefined);
				if (history) a.history.push(history);
				for (const op of WRITES) {
					const w = writeArm(m, c, op, p, g[op]);
					if (w) a[op].push(w);
				}
				if (g.delete !== undefined)
					a.delete.push({ policy: p, check: g.delete !== true && g.delete.check === true });
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
		for (const [c, arm] of Object.entries(directory(holder.actor)))
			addRead(
				c,
				Object.fromEntries(
					pathsOf(m, c).map(([path]) => [
						path,
						path === c ? arm : { policy: KERNEL, where: TRUE, fields: 'all' }
					])
				)
			);
		for (const [c, a] of Object.entries(cols))
			for (const [path, model] of pathsOf(m, c))
				a.masks[path] = masks(m, c, path, model, a.read[path] ?? []);
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
		models: cols,
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
	model: string,
	field: string,
	from: string,
	to: string
): boolean {
	if (auth.admin || from === to) return true;
	const moves = auth.models[model]?.moves[field];
	return moves === 'all' || (moves ?? []).includes(`${from}->${to}`);
}

/** The read scope of a caller (rule 13): the union of its read arms; `undefined` = no read grant at all. */
export function readScope(
	auth: Authority,
	model: string,
	kind: 'read' | 'history' = 'read'
): Pred | undefined {
	const a = auth.models[model];
	const arms = (kind === 'read' ? a?.read[model] : a?.history) ?? [];
	return arms.length === 0 ? undefined : or(arms.map((x) => x.where));
}

/** The common field admission used by reads, writes and UI advice. */
export const admits: Admits = (arms, field) =>
	arms.some((arm) => arm.fields === 'all' || arm.fields.includes(field));
export const writableColumns: WritableColumns = (authority, model, verb) => {
	if (authority.admin) return 'all';
	return new Set(
		(authority.models[model]?.[verb] ?? []).flatMap(
			(arm) => arm.columns[model] ?? []
		)
	);
};
export const visitorMayRead: VisitorMayRead = (authority, model) =>
	authority.actor.kind === 'visitor' &&
	(authority.models[model]?.read[model]?.length ?? 0) > 0;
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
	const spec = m.exposures[model];
	for (const [name, s] of Object.entries(spec?.syncs ?? {}))
		if (s.with !== 'file' && s.read === true && s.write !== true)
			return { sync: `${model}.sync.${name}`, local: spec?.update?.columns[model] ?? [] };
	return undefined;
}
