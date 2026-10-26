// `policy()` (§3.3.7): grants per model, approval flows as code on the write grants (spec §8), capabilities and
// limits. Each spec below takes the literal it checks as a defaulted parameter: with the default it is the general
// type (`Grant<C>`), with the literal it adds the checks a general type cannot carry (`'read'` only beside `read`, `via`
// alone).
import type { InputSel, QueryName } from '../ctx.ts';
import type { Checked, Exact } from '../fields.ts';
import type {
	AppName,
	AutomationName,
	CollectionName,
	Columns,
	FieldName,
	HostToolName,
	KioskName,
	ManyRels,
	McpName,
	OneRels,
	ReadField,
	ReadableName,
	Row,
	SkillName,
	SyncCallable,
	TeamName
} from '../names.ts';
import type { Id, Rate } from '../values.ts';
import type { GroupName } from '../runtime/names.ts'; // hook:access
import type { Where } from '../where.ts';

type Op = 'create' | 'update' | 'delete';

// ── names a grant uses ──
/** The names of `C`'s `state` fields: what a policy's `moves` grant is keyed by. */
export type StateField<C> = StateFieldOf<C>;
type StateFieldOf<C, Cols = Columns<C>, Keys extends keyof Cols & string = keyof Cols & string> = {
	[P in Keys]: Cols[P] extends { kind: 'state' } ? P : never;
}[Keys];
/** The states of state field `F` of `C`. */
export type State<C, F = StateField<C>> = Columns<C>[F & keyof Columns<C>] extends {
	states: infer S;
}
	? keyof S & string
	: never;
/** A declared edge of state field `F`, written `'<from>-><to>'`. */
export type Edge<C, F> = Columns<C>[F & keyof Columns<C>] extends { states: infer S }
	? EdgeStates<S>
	: never;
type EdgeStates<S, Keys extends keyof S & string = keyof S & string> = {
	[X in Keys]: S[X] extends { to: readonly (infer T extends string)[] } ? `${X}->${T}` : never;
}[Keys];
/** A one-relation of `C` (an FK), as a `via` grant names the parent whose grant it inherits. */
export type OneRel<C> = keyof OneRels<C> & string;
/** What an op's grant may admit field by field: the model's allowlist for that op, relation actions included. */
export type WriteField<C, O = 'create' | 'update'> =
	InputSel<C, O> extends infer S
		? S extends { columns: readonly (infer P)[] }
			? (P | (S extends { with: infer W } ? keyof W : never)) & string
			: never
		: never;

// ── approval flows (spec §8) ──
/**
 * The write an approval callback judges. `record` is the row as the write would leave it (a delete: the row it removes);
 * `previous` the stored row an update changes (`null` for a create or delete); `changed` the fields the write sets (a
 * delete: none), including relationship actions retained through held review; `requester` the member asking, with their
 * team (`null` when no member writes: an automation, an API key).
 */
export type ApprovalWrite<C, O extends Op = Op> = {
	readonly op: O;
	readonly record: Row<C>;
	readonly previous: O extends 'update' ? Row<C> : null;
	readonly changed: readonly (FieldName<C> | (keyof ManyRels<C> & string))[];
	readonly requester: { readonly id: Id<'sys_user'>; readonly team: TeamName | null } | null;
};
/**
 * The approval flow a write grant's `approval` callback returns, built fluently from the `flow` it is given. Steps run
 * in order and anyone listed on a step may decide it; `if` adds steps only when its condition holds (`else` otherwise);
 * `supersededBy` names teams that may decide in any step's place; `allow()` writes directly and `deny(message)` refuses
 * the write. After `allow()` or `deny()` nothing more may be added.
 * @example
 * approval: (write, flow) =>
 * 	flow
 * 		.step('Controller review', { teams: ['field_ops_controllers'] })
 * 		.if(write.record.amount !== null && write.record.amount.gte(5000), (f) => f.step('Commercial sign-off', { teams: ['commercial'] }))
 * 		.supersededBy(['field_ops_controllers'])
 */
export interface Flow {
	/** Adds a step: decided by any member of `teams` or any of `users` (at least one approver). */
	step(
		name: string,
		approvers: { teams?: readonly TeamName[]; users?: readonly Id<'sys_user'>[] }
	): Flow;
	/** `then(flow)` when `cond` holds; follow with `.else(…)` for the other case. */
	if(cond: boolean, then: (flow: Flow) => Flow): Flow & { else(then: (flow: Flow) => Flow): Flow };
	/** Teams that may approve or reject in place of any step's approvers (an approval by them supersedes, with a reason). */
	supersededBy(teams: readonly TeamName[]): Flow;
	/** No approval: the write executes directly. */
	allow(): Flow;
	/** The write is refused with `message`. */
	deny(message: string): Flow;
}
/** One step of a stored flow: its name and approvers (team handles, `sys_user` ids). */
export type ApprovalStep = {
	readonly name: string;
	readonly teams: readonly string[];
	readonly users: readonly string[];
};
/**
 * A flow as stored on its request (`bolt_approvals.route`) when the request opens or is resubmitted: a release that
 * changes the code does not move an open request. `allow` and `deny` never open one.
 */
export type ApprovalSnapshot =
	| {
			readonly kind: 'steps';
			readonly steps: readonly ApprovalStep[];
			readonly superseded_by: readonly string[];
	  }
	| { readonly kind: 'allow' }
	| { readonly kind: 'deny'; readonly message: string };
/** Pure and synchronous: no reads, no I/O. Runs when a request opens and again on resubmit. */
type Approves<C, O extends Op> = (write: ApprovalWrite<C, O>, flow: Flow) => Flow;

type FlowState =
	| {
			readonly kind: 'open';
			readonly steps: readonly ApprovalStep[];
			readonly superseded: readonly string[];
	  }
	| { readonly kind: 'allow' }
	| { readonly kind: 'deny'; readonly message: string };
const flows = new WeakMap<Flow, FlowState>();
const flowOf = (state: FlowState): Flow => {
	const open = (what: string) => {
		if (state.kind !== 'open') throw new Error(`approval flow: ${what} after ${state.kind}()`);
		return state;
	};
	const flow: Flow = {
		step(name, { teams = [], users = [] }) {
			const s = open('step');
			if (name.trim() === '') throw new Error('approval flow: a step needs a name');
			if (teams.length + users.length === 0)
				throw new Error(`approval flow: step '${name}' names no approver`);
			return flowOf({ ...s, steps: [...s.steps, { name, teams: [...teams], users: [...users] }] });
		},
		if(cond, then) {
			const taken = cond ? then(flow) : flow;
			return Object.assign(flowOf(stateOf(taken)), {
				else: (other: (f: Flow) => Flow) => (cond ? taken : other(flow))
			});
		},
		supersededBy(teams) {
			const s = open('supersededBy');
			return flowOf({ ...s, superseded: [...new Set([...s.superseded, ...teams])] });
		},
		allow() {
			open('allow');
			return flowOf({ kind: 'allow' });
		},
		deny(message) {
			open('deny');
			return flowOf({ kind: 'deny', message });
		}
	};
	flows.set(flow, state);
	return flow;
};
const stateOf = (flow: Flow): FlowState => {
	const state = flows.get(flow);
	if (state === undefined) throw new Error('approval: return the flow the callback was given');
	return state;
};
/** The empty flow an approval callback receives (the guest edge calls the callback with it). */
export const approvalFlow = (): Flow => flowOf({ kind: 'open', steps: [], superseded: [] });
/** The snapshot a returned flow stores; a flow with no step that neither allows nor denies is an authoring error. */
export const snapshotOf = (flow: Flow): ApprovalSnapshot => {
	const state = stateOf(flow);
	if (state.kind !== 'open') return state;
	if (state.steps.length === 0)
		throw new Error('approval flow: add a step, or end with allow() or deny()');
	return { kind: 'steps', steps: state.steps, superseded_by: state.superseded };
};

// ── grants ──
// `& object` on every all-optional arm: the parameter is `P & Exact<P, …>`, and a string intersected with such an arm
// is not refused, so `update: 'read'` without a `read` grant would pass.
type Scope<C extends CollectionName> = Where<C> & object;
type ReadGrant<C extends CollectionName> =
	true | Scope<C> | ({ where?: Scope<C>; fields?: readonly ReadField<C>[] } & object);
type Part<G, K extends string> = G extends { [P in K]: unknown } ? G[K & keyof G] : unknown;
/**
 * A create or update grant; `G` is the whole grant literal, so `'read'` exists only beside a `read` grant (rule 35).
 * With `approval`, the arm admits the write subject to the flow the callback returns. Among the arms the holder's
 * policies give, one without `approval` that admits the write executes it directly; otherwise the first admitting arm
 * with `approval` (in the team's policy order) runs its callback; with no admitting arm the write is refused.
 */
export type WriteGrant<
	C extends CollectionName,
	O extends 'create' | 'update' = 'create' | 'update',
	G = { read: true }
> = (G extends { read: unknown } ? 'read' : never) extends infer Rd
	? | true
		| Rd
		| Scope<C>
		| ({
				where?: Scope<C> | Rd;
				fields?: readonly WriteField<C, O>[];
				approval?: Approves<C, O>;
		  } & (O extends 'update' ? { previous?: Scope<C> | true } : {}) &
				object)
	: never;
/** A delete grant: `true`, a scope, or `{ where?, approval? }` (approval as on a create or update grant). */
type DeleteGrant<C extends CollectionName> =
	true | Scope<C> | ({ where?: Scope<C>; approval?: Approves<C, 'delete'> } & object);
type Scoped<C extends CollectionName, G> = {
	read?: ReadGrant<C>;
	history?: ReadGrant<C>;
	queries?: readonly QueryName<C>[];
	moves?: 'all' | { [F in StateField<C>]?: readonly Edge<C, F>[] };
	create?: WriteGrant<C, 'create', G>;
	update?: WriteGrant<C, 'update', G>;
	delete?: DeleteGrant<C>;
};
/** A model grant: scoped operations, or `via` alone, which inherits the parent's grant. */
export type Grant<C extends CollectionName, G = unknown> = G extends { via: unknown }
	? { via: OneRel<C> }
	: unknown extends G
		? Scoped<C, { read: true }> | { via: OneRel<C> }
		: Scoped<C, G>;
/** Rule 38c: identity collections are read-only to every policy. */
export type IdentityGrant<C extends CollectionName> = {
	read: true | Scope<C>;
	fields?: readonly ReadField<C>[];
};
type Identity = 'sys_user' | 'sys_invitation';
// Ledgers and API keys take no grant. Invitations are readable for provisioning automations.
type Grantable = Exclude<ReadableName, 'sys_api_key'>;
/** What types each write grant's `approval` callback while the literal is inferred (the constraint, not the check). */
type ApprovalSlots = {
	readonly [C in Grantable]?: {
		readonly [O in Op]?: true | string | (object & { readonly approval?: Approves<C, O> });
	} & { readonly [key: string]: unknown };
};

// ── limits (rule 38) ──
/** A rate limit (rule 38): `'<n>/<unit>'`, optionally `per` actor or IP; a list applies every rule. */
export type Limit =
	Rate | { rate: Rate; per: 'actor' | 'ip' } | readonly { rate: Rate; per: 'actor' | 'ip' }[];
/** A rate limit on an envoy's inbound traffic, counted `per` sender or per subject. */
export type EnvoyLimit =
	| Rate
	| { rate: Rate; per: 'sender' | 'subject' }
	| readonly { rate: Rate; per: 'sender' | 'subject' }[];
type EnvoyKey = 'envoys.receive' | 'envoys.unrecognised';
/**
 * What a `limits` entry throttles: acts, reads, agent turns, registration, uploads, page document conversions
 * (`convert`, `bolt.convert`; default `30/min`), envoy traffic, or one `'<model>.<query>'`.
 */
export type LimitKey =
	| 'act'
	| 'read'
	| 'agent'
	| 'register'
	| 'upload'
	| 'convert'
	| EnvoyKey
	| { [C in CollectionName]: `${C}.${QueryName<C>}` }[CollectionName];

// ── the policy ──
/** What `policy.automations` may start: automations, and remote syncs with a `read` (`'<model>.sync.<sync>'`). */
export type StartableName = AutomationName | SyncCallable;
type Grants<P> = P extends { grants: infer G } ? G : {};
interface PolicyFor<P, C extends Grantable> {
	description: string;
	grants: {
		[K in C]?: K extends Identity
			? IdentityGrant<K>
			: Grant<K, unknown extends P ? unknown : Part<Grants<P>, K>>;
	};
	automations?: readonly StartableName[];
	capabilities?: {
		apps?: readonly (AppName | GroupName)[];
		/* hook:access — a group covers its apps */ kiosks?: readonly KioskName[];
		tools?: readonly HostToolName[];
		mcp?: readonly McpName[];
		skills?: readonly SkillName[];
	};
	limits?: { [K in LimitKey]?: K extends EnvoyKey ? EnvoyLimit : Limit };
}
type PolicyBase = {
	/** What holding the policy is for, for people and the agent. */
	description: string;
	/** Per model: `read`, `history`, `create`, `update`, `delete` (each `true`, a scope or fields, a write with an optional `approval` flow), `queries`, state `moves`, or `via` a parent. */
	grants: { readonly [model: string]: object } & ApprovalSlots;
	/** The automations (and `'<model>.sync.<sync>'` reads) holders may start. */
	automations?: readonly string[];
	/** The apps (or groups), host tools, MCP servers and agent skills holders may use. */
	capabilities?: { readonly [k: string]: readonly string[] };
	/** Rate limits per limit key. */
	limits?: { readonly [key: string]: unknown };
};

/**
 * `src/access_control/policy/+<name>.policy.ts`: what holders may do: per-model `grants` (read, create, update, delete,
 * queries, state moves; a write grant's `approval` callback returns its approval flow), the automations and
 * syncs they may start, capabilities (apps, host tools, MCP servers, skills) and rate `limits`. Teams hold policies in
 * `src/access_control/team/+team.ts`. Returns the literal.
 * @example
 * export default policy({
 * 	description: 'Contractors raise variations on their own jobs.',
 * 	grants: {
 * 		variation_requests: {
 * 			read: { where: OWN_JOB },
 * 			create: {
 * 				where: OWN_JOB,
 * 				fields: ['job_assignment_id', 'title', 'amount'],
 * 				approval: (write, flow) => flow.step('Controller review', { teams: ['field_ops_controllers'] })
 * 			}
 * 		}
 * 	},
 * 	capabilities: { apps: ['field_ops'] }
 * });
 */
export function policy<const P extends PolicyBase>(
	spec: P & NoInfer<Checked<PolicyBase, P, Exact<P, PolicyFor<P, keyof Grants<P> & Grantable>>>>
): P {
	return spec;
}
