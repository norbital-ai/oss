// Policies → Authority (rules 33–37, 35a): held grants union into arms per read output and path, write arms carry the
// columns they admit per write path and whether a `check` judges them, and an administrator (or a platform run) bypasses
// authored policy. A grant names outputs and filters their rows; it never changes an output's fields. Plus what a write
// and a read consult of it: `moves` (rule 34) and the read scope (rule 13); the write judge itself is `write/act.ts`'s.
import { Effect } from 'effect';
import type { Json } from '../../decl/values.ts';
import type { Arm, Authority, DeleteArm, EngineActor, LimitRule, WriteArm } from '../contracts.ts';
import {
	layered,
	layers,
	type EngineManifest,
	type GrantData,
	type LimitData,
	type ReadGrantData
} from '../manifest.ts';
import { DEFAULT_OUTPUT, SYSTEM_COLUMN_SET, type Pred, type Var } from '@norbital-ai/store';
import { SYSTEM } from '../../system/index.ts';
import { compile_var, evaluate_var, type Requestor } from '@norbital-ai/std/vars';
import { or, toPred, TRUE } from './pred.ts';
import { BoltError } from '../../protocol/errors.ts';

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
const isIdentity = (c: string) => IDENTITY.some((i) => i === c);
const KERNEL = '$directory';
/** The `sys_user` output the kernel directory grants (rule 35a): id and name. */
export const DIRECTORY_OUTPUT = 'directory';

type Mutable = {
	read: { [output: string]: { [path: string]: Arm[] } };
	create: WriteArm[];
	update: WriteArm[];
	delete: DeleteArm[];
	moves: { [field: string]: 'all' | readonly string[] };
};
const emptyModel = (): Mutable => ({
	read: {},
	create: [],
	update: [],
	delete: [],
	moves: {}
});

/** The outputs `c` declares: `default` and each named one, in declaration order. */
export const outputsOf = (m: EngineManifest, c: string): readonly string[] =>
	Object.keys(layered(m).exposures[c]?.outputs ?? {});
/** The read paths output `output` of `c` declares (its root first), each with the model behind it. */
const pathsOf = (
	m: EngineManifest,
	c: string,
	output: string
): readonly (readonly [string, string])[] => {
	const spec = layered(m).exposures[c];
	const read = spec?.outputs[output] ?? {};
	const declared = Object.entries(layers(m)[c] ?? {}).filter(([path]) => Object.hasOwn(read, path));
	return declared.length === 0 ? [[c, c]] : declared;
};
/**
 * One policy's read arms of an output. The root scope also applies to history when this policy grants it.
 */
const readArms = Effect.fnUntraced(function* (
	m: EngineManifest,
	c: string,
	output: string,
	policy: string,
	read: ReadGrantData
): Effect.fn.Return<{ readonly [path: string]: Arm }, BoltError> {
	const out: { [path: string]: Arm } = {};
	for (const [path, model] of pathsOf(m, c, output)) {
		const scope = read.scopes?.[path];
		out[path] = {
			policy,
			where: scope === undefined ? TRUE : yield* toPred(m, model, scope),
			...(path === c && read.history === true ? { history: true } : {})
		};
	}
	return out;
});
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
		columns: g.columns ?? declared,
		check: g.verdict === true
	};
}

/** The fields output `output` of `root` exposes at `path` (rule 10), its FKs included. */
export function exposed(
	m: EngineManifest,
	root: string,
	path: string,
	model: string,
	output: string = DEFAULT_OUTPUT
): readonly string[] {
	const all = layered(m);
	const spec = all.exposures[root];
	const f = spec?.outputs[output]?.[path]?.fields;
	const fks = Object.keys(all.relationships)
		.filter((k) => k.slice(0, k.indexOf('.')) === model)
		.map((k) => k.slice(k.indexOf('.') + 1));
	// a system row's `revision`, `created_at` and the like are its own fields, read as every row's system columns are
	const sys = Object.hasOwn(SYSTEM.models, model);
	const own = [
		...Object.keys(all.models[model]?.fields ?? {}),
		...Object.keys(all.models[model]?.computed ?? {}),
		...fks
	].filter((x) => !sys || !SYSTEM_COLUMN_SET.has(x));
	return f === undefined || f === 'all' ? own : f;
}

/**
 * The kernel directory grant (rule 35a): staff read staff, externals read themselves and their party, each as
 * `sys_user`'s `directory` output (id, name). Teams are source.
 */
function directory(actor: EngineActor): Arm | undefined {
	if (actor.kind !== 'member') return undefined;
	const self: Pred = {
		t: 'cmp',
		field: 'id',
		op: 'eq',
		arg: { _tag: 'Var', text: 'requestor.id' }
	};
	return {
		policy: KERNEL,
		where: actor.external
			? or([
					self,
					{
						t: 'cmp',
						field: 'party_id',
						op: 'eq',
						arg: { _tag: 'Var', text: 'requestor.party' }
					}
				])
			: { t: 'cmp', field: 'kind', op: 'eq', arg: { _tag: 'Lit', value: 'staff' } }
	};
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
// a visitor's limits all count per IP, anonymous user or not; `register` is the per-IP ceiling on minting anonymous users
const VISITOR_DEFAULTS: readonly LimitRule[] = [
	{ key: 'act', rate: '120/h', per: 'ip' },
	{ key: 'register', rate: '20/h', per: 'ip' },
	{ key: 'upload', rate: '20/h', per: 'ip' },
	{ key: 'read', rate: '600/min', per: 'ip' }
];
function limitRules(key: string, v: LimitData | readonly LimitData[]): LimitRule[] {
	const one = (x: LimitData): LimitRule =>
		typeof x === 'string'
			? { key, rate: x, per: key.startsWith('envoys.') ? 'sender' : 'actor' }
			: { key, ...x };
	return typeof v === 'string' || 'rate' in v ? [one(v)] : v.map(one);
}

/** Compiles once per `key` (rule 37); the caller caches by that key. */
export const compile_authority = Effect.fn('Bolt.compile_authority')(function* (
	m: EngineManifest,
	holder: Holder,
	key: string
): Effect.fn.Return<Authority, BoltError> {
	const bypass = holder.admin || holder.platform === true;
	const policySpecs = holder.policies.flatMap((name) => {
		const spec = Object.hasOwn(m.policies, name) ? m.policies[name] : undefined;
		return spec === undefined ? [] : [{ name, spec }];
	}); // an unknown policy confers nothing
	const policies = policySpecs.map(({ name }) => name);
	const cols: { [c: string]: Mutable } = {};
	const col = (c: string) => (cols[c] ??= emptyModel());
	const addRead = (c: string, output: string, arms: { readonly [path: string]: Arm }) => {
		const at = (col(c).read[output] ??= {});
		for (const [path, arm] of Object.entries(arms)) (at[path] ??= []).push(arm);
	};
	if (bypass) {
		// an admin manages the integration instances too (FINAL §3); identity is the admin verbs'
		const all = layered(m).exposures;
		for (const c of [
			...Object.keys(m.exposures),
			...(holder.admin ? [...IDENTITY, 'sys_integration'] : [])
		]) {
			const a = col(c),
				open: Arm = { policy: '$admin', where: TRUE };
			for (const output of outputsOf(m, c))
				addRead(c, output, yield* readArms(m, c, output, open.policy, { history: true }));
			if (!isIdentity(c)) {
				for (const op of WRITES)
					a[op].push({ policy: '$admin', columns: all[c]?.[op]?.columns ?? {}, check: false });
				a.delete.push({ policy: '$admin', check: false });
			}
			for (const [f, k] of Object.entries(m.models[c]?.fields ?? {}))
				if (k.kind === 'state') a.moves[f] = 'all';
		}
	} else {
		for (const { name: p, spec } of policySpecs)
			for (const [c, g] of Object.entries(spec.grants)) {
				const a = col(c);
				for (const [output, read] of Object.entries(g.outputs ?? {}))
					addRead(c, output, yield* readArms(m, c, output, p, read));
				for (const op of WRITES) {
					const w = writeArm(m, c, op, p, g[op]);
					if (w) a[op].push(w);
				}
				if (g.delete !== undefined)
					a.delete.push({ policy: p, check: g.delete.verdict === true });
				const moves = g.update?.moves;
				if (moves === 'all')
					for (const [f, k] of Object.entries(m.models[c]?.fields ?? {})) {
						if (k.kind === 'state') a.moves[f] = 'all';
					}
				else
					for (const [f, edges] of Object.entries(moves ?? {})) {
						const had = a.moves[f];
						a.moves[f] = had === 'all' ? 'all' : [...new Set([...(had ?? []), ...edges])];
					}
			}
		const kernel = directory(holder.actor);
		if (kernel !== undefined)
			addRead(
				'sys_user',
				DIRECTORY_OUTPUT,
				Object.fromEntries(
					pathsOf(m, 'sys_user', DIRECTORY_OUTPUT).map(([path]) => [
						path,
						path === 'sys_user' ? kernel : { policy: KERNEL, where: TRUE }
					])
				)
			);
	}
	const caps = {
		apps: new Set<string>(),
		syncs: new Set<string>(),
		tools: new Set<string>(),
		mcp: new Set<string>()
	};
	const automations = new Set<string>();
	const declared: LimitRule[] = [];
	for (const { spec } of policySpecs) {
		for (const k of ['apps', 'syncs', 'tools', 'mcp'] as const)
			for (const x of spec.capabilities?.[k] ?? []) caps[k].add(x);
		for (const x of spec.capabilities?.automations ?? []) automations.add(x);
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
			syncs: list(caps.syncs),
			tools: list(caps.tools),
			mcp: list(caps.mcp)
		},
		limits,
		teamTree: holder.teamTree ?? [],
		scopes: holder.scopes ?? {}
	};
});

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

/** A caller's arms of output `output` of `model` at `path` (default: the root); `undefined` = that output is not granted. */
export function grantedArms(
	auth: Authority,
	model: string,
	output: string = DEFAULT_OUTPUT,
	path: string = model
): readonly Arm[] | undefined {
	const arms = auth.models[model]?.read[output]?.[path];
	return arms === undefined || arms.length === 0 ? undefined : arms;
}
/** Read predicates at a root's layer: one named output, or every granted output when omitted. Admins are unscoped. */
export function readPredicates(
	authority: Authority,
	path: string,
	output?: string
): readonly Pred[] | undefined {
	if (authority.admin) return undefined;
	const dot = path.indexOf('.');
	const grants = authority.models[dot < 0 ? path : path.slice(0, dot)]?.read ?? {};
	const arms = output === undefined
		? Object.values(grants).flatMap((paths) => paths[path] ?? [])
		: grants[output]?.[path] ?? [];
	return arms.map((arm) => arm.where);
}
/** Whether the caller reads any output of `model`. */
export const readsAny = (auth: Authority, model: string): boolean => {
	const predicates = readPredicates(auth, model);
	return predicates === undefined || predicates.length > 0;
};
/**
 * The output a caller's generic views read `model` as: `default` when granted, else the first named output it holds in
 * declaration order; `undefined` when it reads none.
 */
export function viewOutput(m: EngineManifest, auth: Authority, model: string): string | undefined {
	if (auth.admin) return DEFAULT_OUTPUT;
	return outputsOf(m, model).find((o) => grantedArms(auth, model, o) !== undefined);
}

/** The root arms whose output grant includes history. */
export const historyArms = (authority: Authority, model: string, output: string) =>
	grantedArms(authority, model, output)?.filter((arm) => arm.history === true) ?? [];

export const writable_columns = (
	authority: Authority,
	model: string,
	verb: 'create' | 'update'
): ReadonlySet<string> | 'all' => {
	if (authority.admin) return 'all';
	return new Set(
		(authority.models[model]?.[verb] ?? []).flatMap((arm) => arm.columns[model] ?? [])
	);
};
/** What the requestor variables read off an authority. */
export function requestorOf(authority: Authority): Requestor {
	// the system identity (an automation run) names no person: its `requestor.*` operands match nothing
	const actor = authority.actor;
	const member =
		actor.kind === 'member' ? actor : actor.kind === 'envoy' ? (actor.linked ?? null) : null;
	return {
		id: member?.id ?? (actor.kind === 'visitor' && actor.anonymous === true ? actor.visitor : null),
		email: member?.email ?? null,
		phone: member?.phone ?? null,
		party: member?.party?.id ?? null,
		visitor: actor.kind === 'visitor' ? actor.visitor : null,
		instance:
			actor.kind === 'envoy'
				? actor.instance
				: actor.kind === 'system' && 'instance' in actor.by
					? actor.by.instance
					: null,
		teams: member === null ? [] : member.teams,
		team_tree: authority.teamTree,
		scopes: authority.scopes
	};
}
/** Requestor variables have one interpretation across SQL, live evaluation and write admission. */
export const operand_value = (operand: Var, authority: Authority): Json => {
	const c = compile_var(operand.text);
	if ('error' in c) throw BoltError.make('invalid', 'decode', c.error);
	return evaluate_var(c, { requestor: requestorOf(authority) });
};

/**
 * A model a read-only remote sync owns (spec §3: a sync with `read` and no `write`): its rows come from that sync, so
 * every other writer, administrators included, changes only its local fields (its `update.columns`) and never creates
 * or deletes one. A read+write sync leaves the fields editable (each edit reaches the outbox).
 */
export function sync_owned(
	m: EngineManifest,
	model: string
): { readonly sync: string; readonly local: readonly string[] } | undefined {
	const spec = m.exposures[model];
	for (const [name, s] of Object.entries(spec?.syncs ?? {}))
		if (s.with !== 'file' && s.read === true && s.write !== true)
			return { sync: `${model}.sync.${name}`, local: spec?.update?.columns[model] ?? [] };
	return undefined;
}
