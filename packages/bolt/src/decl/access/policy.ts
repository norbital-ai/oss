// `policy()` (§3.3.7): grants per model as layer maps (decision 3: a model's policy alone guards its access points and
// every layer under them), one typed `check` per write verb returning a `Verdict` (an approval flow among them, spec §8),
// capabilities and limits. Everything a grant says is typed from the model's own declaration; nothing else type-checks.
import type { CreateCheck, DeleteCheck, UpdateCheck } from '../ctx.ts';
import type { Checked, Exact } from '../fields.ts';
import type {
	AppName,
	AutomationName,
	ModelName,
	ExposureSpecOf,
	Columns,
	HostToolName,
	KioskName,
	LayerColumn,
	LayerField,
	McpName,
	PathModel,
	ReadField,
	ReadPath,
	ReadableName,
	SkillName,
	SyncCallable,
	TeamName,
	WritePath
} from '../names.ts';
import type { Id, Rate } from '../values.ts';
import type { GroupName } from '../runtime/names.ts'; // hook:access
import type { ModelWhere } from '../where.ts';

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
/** The columns a write grant's layer `P` may admit: the columns the model's `create` or `update` declares there. */
export type WriteField<C, O extends 'create' | 'update', P = C> = LayerColumn<C, O, P>;

// ── approval flows (spec §8) ──
/**
 * The approval flow a check's `ctx.approve(build)` holds the write for, built fluently from the `flow` it is given.
 * Steps run in order and anyone listed on a step may decide it; `if` adds steps only when its condition holds (`else`
 * otherwise); `supersededBy` names teams that may decide in any step's place; `allow()` writes directly and
 * `deny(message)` refuses the write. After `allow()` or `deny()` nothing more may be added.
 * @example
 * return ctx.approve((flow) =>
 * 	flow
 * 		.step('Controller review', { teams: ['field_ops_controllers'] })
 * 		.if(total.gte(5000), (f) => f.step('Commercial sign-off', { teams: ['commercial'] }))
 * 		.supersededBy(['field_ops_controllers'])
 * );
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
/** The empty flow `ctx.approve`'s builder receives. */
export const approvalFlow = (): Flow => flowOf({ kind: 'open', steps: [], superseded: [] });
/** The snapshot a returned flow stores; a flow with no step that neither allows nor denies is an authoring error. */
export const snapshotOf = (flow: Flow): ApprovalSnapshot => {
	const state = stateOf(flow);
	if (state.kind !== 'open') return state;
	if (state.steps.length === 0)
		throw new Error('approval flow: add a step, or end with allow() or deny()');
	return { kind: 'steps', steps: state.steps, superseded_by: state.superseded };
};

// ── verdicts: what a write `check` returns ──
/**
 * A verdict as it crosses the guest edge (JSON): execute, refuse the batch (`at`: its row, write path and column), or
 * hold it for the approval flow snapshot (`approve(f => f.allow())` is `allow`, `… f.deny(m)` is `deny`).
 */
export type VerdictData =
	| { readonly kind: 'allow' }
	| {
			readonly kind: 'deny';
			readonly message: string;
			readonly at?: { readonly row?: number; readonly path?: string; readonly field?: string };
	  }
	| { readonly kind: 'approve'; readonly flow: Extract<ApprovalSnapshot, { kind: 'steps' }> };
/** A check's answer: only `ctx.allow()`, `ctx.deny(…)` and `ctx.approve(…)` make one; a plain object is never one. */
export class Verdict {
	readonly #verdict = true;
	readonly data: VerdictData;
	private constructor(data: VerdictData) {
		this.data = data;
	}
	/** The verdict members of a check's ctx (the guest edge installs them on `PolicyCtx`). */
	static readonly allow = (): Verdict => new Verdict({ kind: 'allow' });
	static readonly deny = (
		message: string,
		at?: { readonly row?: number; readonly path?: string; readonly field?: string }
	): Verdict => new Verdict({ kind: 'deny', message, ...(at === undefined ? {} : { at }) });
	static readonly approve = (build: (flow: Flow) => Flow): Verdict => {
		const snapshot = snapshotOf(build(approvalFlow()));
		return new Verdict(snapshot.kind === 'steps' ? { kind: 'approve', flow: snapshot } : snapshot);
	};
	/** The data of what a check returned; anything no verdict member made is an authoring error. */
	static dataOf(v: unknown): VerdictData {
		if (!(v instanceof Verdict) || !v.#verdict)
			throw new Error('policy check: return ctx.allow(), ctx.deny(…) or ctx.approve(…)');
		return v.data;
	}
}

// ── grants ──
// `& object` on every all-optional arm: the parameter is `P & Exact<P, …>`, and a string intersected with such an arm
// is not refused.
// A grant's `where` is the policy's authority over the model's rows, not a caller's read: it may name any field and cross
// any relation, and the related model's own policies never apply to it.
type Scope<C extends ModelName> = ModelWhere<C> & object;
/**
 * A read grant: `true` (every declared layer, every field), or a layer map over the model's `read` paths. A layer's
 * `where` filters it (the root's: which roots; a deeper one's: that layer's rows, or nulls a ref, never the root) and
 * `fields` masks within it. A declared layer the map does not name is read in full.
 */
export type ReadGrant<C extends ModelName> =
	| true
	| ({
			[P in ReadPath<C>]?: {
				where?: ModelWhere<PathModel<C, P>> & object;
				fields?: readonly LayerField<C, P>[];
			} & object;
	  } & object);
/** A `history` grant (rule 17), as a read grant was before layers: `true`, a scope, or `{ where?, fields? }`. */
type HistoryGrant<C extends ModelName> =
	true | Scope<C> | ({ where?: Scope<C>; fields?: readonly ReadField<C>[] } & object);
/**
 * A create or update grant: `true` (every declared column, allowed), or the `columns` per write layer it admits (every
 * declared one when omitted, checked before the `check` runs, without guest code) and the `check` that judges the whole
 * batch (allow when omitted). Among the holder's policies any `allow` executes; otherwise the first `approve` in the
 * team's policy order holds the write for its flow; otherwise it is refused with the first `deny`.
 */
export type WriteGrant<C extends ModelName, O extends 'create' | 'update'> =
	| true
	| ({
			columns?: { [P in WritePath<C, O>]?: readonly LayerColumn<C, O, P>[] } & object;
			check?: O extends 'create' ? CreateCheck<C> : UpdateCheck<C>;
	  } & object);
/** A delete grant: `true`, or `{ check }`. */
export type DeleteGrant<C extends ModelName> = true | ({ check?: DeleteCheck<C> } & object);
type Declares<C, V> = ExposureSpecOf<C> extends { [P in V & string]: unknown } ? true : false;
/** A model grant: its access points `read`, `create`, `update`, `delete` (each only when the model declares it), `history` and state `moves`. */
export type Grant<C extends ModelName> = {
	read?: ReadGrant<C>;
	history?: HistoryGrant<C>;
	moves?: 'all' | { [F in StateField<C>]?: readonly Edge<C, F>[] };
	create?: Declares<C, 'create'> extends true ? WriteGrant<C, 'create'> : never;
	update?: Declares<C, 'update'> extends true ? WriteGrant<C, 'update'> : never;
	delete?: Declares<C, 'delete'> extends true ? DeleteGrant<C> : never;
};
/** Rule 38c: identity models are read-only to every policy. */
export type IdentityGrant<C extends ModelName> = {
	read: true | Scope<C>;
	fields?: readonly ReadField<C>[];
};
type Identity = 'sys_user' | 'sys_invitation';
// Ledgers and API keys take no grant. Invitations are readable for provisioning automations.
type Grantable = Exclude<ReadableName, 'sys_api_key'>;
/** What types each write grant's `check` while the literal is inferred (the constraint, not the check). */
type CheckSlots = {
	readonly [C in Grantable]?: {
		readonly create?: true | (object & { readonly check?: CreateCheck<C> });
		readonly update?: true | (object & { readonly check?: UpdateCheck<C> });
		readonly delete?: true | (object & { readonly check?: DeleteCheck<C> });
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
 * (`convert`, `bolt.convert`; default `30/min`) or envoy traffic.
 */
export type LimitKey = 'act' | 'read' | 'agent' | 'register' | 'upload' | 'convert' | EnvoyKey;

// ── the policy ──
/** What `policy.automations` may start: automations, and remote syncs with a `read` (`'<model>.sync.<sync>'`). */
export type StartableName = AutomationName | SyncCallable;
type Grants<P> = P extends { grants: infer G } ? G : {};
interface PolicyFor<C extends Grantable> {
	description: string;
	grants: { [K in C]?: K extends Identity ? IdentityGrant<K> : Grant<K> };
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
	/** Per model: `read` (a layer map), `history`, `create`/`update` (`columns` per layer and a `check`), `delete` (`check`), state `moves`. */
	grants: { readonly [model: string]: object } & CheckSlots;
	/** The automations (and `'<model>.sync.<sync>'` reads) holders may start. */
	automations?: readonly string[];
	/** The apps (or groups), host tools, MCP servers and agent skills holders may use. */
	capabilities?: { readonly [k: string]: readonly string[] };
	/** Rate limits per limit key. */
	limits?: { readonly [key: string]: unknown };
};

/**
 * `src/access_control/policy/+<name>.policy.ts`: what holders may do: per-model `grants` (a `read` layer map; `create`,
 * `update` and `delete` with their `columns` per layer and a `check` returning `allow`, `deny` or `approve`; `history`;
 * state `moves`), the automations and syncs they may start, capabilities (apps, host tools, MCP servers, skills) and rate
 * `limits`. A model's policy alone guards its access points and every layer under them. Teams hold policies in
 * `src/access_control/team/+team.ts`. Returns the literal.
 * @example
 * export default policy({
 * 	description: 'Contractors raise variations on their own jobs.',
 * 	grants: {
 * 		variation_requests: {
 * 			read: { variation_requests: { where: { raised_by: { eq: { var: 'requestor.id' } } } } },
 * 			create: {
 * 				columns: { variation_requests: ['job_assignment_id', 'title', 'amount'] },
 * 				check: function* (rows, ctx) {
 * 					const { job_assignments } = yield* ctx.db.query({
 * 						job_assignments: { where: { id: { in: rows.map((r) => r.job_assignment_id) } }, fields: ['assignee_user_id'] }
 * 					});
 * 					const mine = job_assignments.rows.every((j) => j.assignee_user_id === ctx.actor.id);
 * 					return mine
 * 						? ctx.approve((flow) => flow.step('Controller review', { teams: ['field_ops_controllers'] }))
 * 						: ctx.deny('Raise variations on your own jobs.', { path: 'variation_requests', field: 'job_assignment_id' });
 * 				}
 * 			}
 * 		}
 * 	},
 * 	capabilities: { apps: ['field_ops'] }
 * });
 */
export function policy<const P extends PolicyBase>(
	spec: P & NoInfer<Checked<PolicyBase, P, Exact<P, PolicyFor<keyof Grants<P> & Grantable>>>>
): P {
	return spec;
}
