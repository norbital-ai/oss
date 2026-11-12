// `policy()` (§3.3.7): per model, the read outputs holders may read and the rows of each (decision 3: a model's policy
// alone guards its access points and every layer under them), one typed `verdict` per write verb returning a `Verdict` (an
// approval flow among them, spec §8), capabilities, manual starts and limits. A grant never changes an output's shape.
// Everything a grant says is typed from the model's own declaration; nothing else type-checks.
import { Schema } from 'effect';
import type { CreateVerdict, DeleteVerdict, UpdateVerdict } from '../ctx.ts';
import type { Checked, Exact } from '../fields.ts';
import type {
	AppName,
	AutomationName,
	ModelName,
	ExposureSpecOf,
	Columns,
	HostToolName,
	LayerColumn,
	McpName,
	OutputName,
	PathModel,
	ReadPath,
	ReadableName,
	SyncKey,
	TeamName,
	WritePath
} from '../names.ts';
import type { NonEmpty, Rate } from '../values.ts';
import type { GroupName } from '../runtime/names.ts'; // hook:access
import type { ModelWhere } from '../where.ts';

// ── names a grant uses ──
/** The names of `C`'s `state` fields: what a policy's `moves` grant is keyed by. */
type StateField<C> = StateFieldOf<C>;
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

// ── approval flows ──
/** The named teams that decide a write, in step order. Superseders may decide any step with a reason. */
export type ApprovalFlow = {
	readonly steps: NonEmpty<{ readonly name: string; readonly teams: NonEmpty<TeamName> }>;
	readonly superseded_by?: readonly TeamName[];
};
const FlowData = Schema.Struct({
	steps: Schema.NonEmptyArray(
		Schema.Struct({
			name: Schema.String.check(
				Schema.makeFilter((name) => name.trim() !== '' || 'A step needs a name.')
			),
			teams: Schema.NonEmptyArray(Schema.String)
		})
	),
	superseded_by: Schema.optionalKey(Schema.Array(Schema.String))
});
const decodeFlow = Schema.decodeUnknownSync(FlowData, { onExcessProperty: 'error' });

/** One step of a stored flow: its name and approvers (team handles, `sys_user` ids). */
export type ApprovalStep = {
	readonly name: string;
	readonly teams: readonly string[];
	readonly users: readonly string[];
};
/** The immutable flow stored when a request opens or is resubmitted. */
export type ApprovalSnapshot = {
	readonly kind: 'steps';
	readonly steps: readonly ApprovalStep[];
	readonly superseded_by: readonly string[];
};

// ── verdicts: what a write `check` returns ──
/**
 * A verdict as it crosses the guest edge (JSON): execute, refuse the batch (`at`: its row and root column), or hold it
 * for the approval flow snapshot.
 */
export type VerdictData =
	| { readonly kind: 'allow' }
	| {
			readonly kind: 'deny';
			readonly message: string;
			readonly values?: { readonly [name: string]: string | number };
			readonly at?: { readonly row?: number; readonly field?: string };
	  }
	| { readonly kind: 'approve'; readonly flow: ApprovalSnapshot };
/** A check's answer: only `ctx.allow()` and `ctx.approve(…)` make one; a plain object is never one. */
export class Verdict {
	readonly #verdict = true;
	readonly data: VerdictData;
	private constructor(data: VerdictData) {
		this.data = data;
	}
	/** The verdict members of a check's ctx (the guest edge installs them on `PolicyCtx`). */
	static readonly allow = (): Verdict => new Verdict({ kind: 'allow' });
	static readonly approve = (flow: ApprovalFlow): Verdict => {
		const decoded = decodeFlow(flow);
		return new Verdict({
			kind: 'approve',
			flow: {
				kind: 'steps',
				steps: decoded.steps.map(({ name, teams }) => ({ name, teams, users: [] })),
				superseded_by: [...new Set(decoded.superseded_by)]
			}
		});
	};
	/** The data of what a check returned; anything no verdict member made is an authoring error. */
	static dataOf(v: unknown): VerdictData {
		if (!(v instanceof Verdict) || !v.#verdict)
			throw new Error(
				'policy verdict: return ctx.allow() or ctx.approve(…), or yield* ctx.refuse(…)'
			);
		return v.data;
	}
}

// ── grants ──
// `& object` on every all-optional arm: the parameter is `P & Exact<P, …>`, and a string intersected with such an arm
// is not refused.
// A grant's `where` is the policy's authority over the model's rows, not a caller's read: it may name any field and cross
// any relation, and the related model's own policies never apply to it.
type ChildPath<Parent extends string, Path> = Path extends `${Parent}.${infer Relation}`
	? Relation extends `${string}.${string}`
		? never
		: Path
	: never;
type Scope<C extends ModelName, O, P extends string> = {
	where?: ModelWhere<PathModel<C, P>> & object;
} & {
	[
		Child in ChildPath<P, ReadPath<C, O>> as Child extends `${P}.${infer Relation}`
			? Relation
			: never
	]?: Scope<C, O, Child>;
};
/** A grant of an output: `{}` for every row, or a scope on its root and any of its relations. History uses the root scope. */
export type ReadGrant<C extends ModelName, O = 'default'> = Scope<C, O, C> & { history?: true } & object;
/** A write grant narrows the model's declared fields at each nested child. */
type WriteColumns<C, O extends 'create' | 'update', P extends string = C & string> = {
	readonly fields: readonly LayerColumn<C, O, P>[];
} & {
	readonly [Child in ChildPath<P, WritePath<C, O>> as Child extends `${P}.${infer Relation}` ? Relation : never]?: WriteColumns<C, O, Child>;
};
/**
 * A create or update grant: the `columns` per write layer it admits (every declared one when omitted, checked before
 * the `verdict` runs, without guest code) and the `verdict` that judges the whole batch (allow when omitted), so `{}`
 * admits every declared column. Among the holder's policies any `allow` executes; otherwise the first `approve` in the
 * team's policy order holds the write for its flow; otherwise it is refused with the first refusal.
 */
export type WriteGrant<C extends ModelName, O extends 'create' | 'update'> = {
	columns?: WriteColumns<C, O>;
	verdict?: O extends 'create' ? CreateVerdict<C> : UpdateVerdict<C>;
} & (O extends 'update'
	? { moves?: 'all' | { [F in StateField<C>]?: readonly Edge<C, F>[] } }
	: object);
/** A delete grant: `{}`, or `{ verdict }`. */
type DeleteGrant<C extends ModelName> = { verdict?: DeleteVerdict<C> } & object;
type Declares<C, V> = ExposureSpecOf<C> extends { [P in V & string]: unknown } ? true : false;
/**
 * A model grant names the `outputs` its holders may read and the model verbs they may call.
 * State `moves` are part of `update`.
 */
export type Grant<C extends ModelName> = {
	outputs?: { [O in OutputName<C>]?: ReadGrant<C, O> };
	create?: Declares<C, 'create'> extends true ? WriteGrant<C, 'create'> : never;
	update?: Declares<C, 'update'> extends true ? WriteGrant<C, 'update'> : never;
	delete?: Declares<C, 'delete'> extends true ? DeleteGrant<C> : never;
};
/** Rule 38c: identity models are read-only to every policy: their `default` output or a named one (`directory`), rows by scope. */
type IdentityGrant<C extends ModelName> = {
	outputs?: { [O in OutputName<C>]?: ReadGrant<C, O> };
};
type Identity = 'sys_user' | 'sys_invitation';
// Ledgers and API keys take no grant. Invitations are readable for provisioning automations.
type Grantable = Exclude<ReadableName, 'sys_api_key'>;
/** Contextual typing for each write grant's verdict callback. */
type VerdictSlots = {
	readonly [C in Grantable]?: {
		readonly create?: object & { readonly verdict?: CreateVerdict<C> };
		readonly update?: object & { readonly verdict?: UpdateVerdict<C> };
		readonly delete?: object & { readonly verdict?: DeleteVerdict<C> };
	} & { readonly [key: string]: unknown };
};

// ── limits (rule 38) ──
/** A rate limit (rule 38): `'<n>/<unit>'`, optionally `per` actor or IP; a list applies every rule. */
export type Limit =
	Rate | { rate: Rate; per: 'actor' | 'ip' } | readonly { rate: Rate; per: 'actor' | 'ip' }[];
/** A rate limit on an envoy's inbound traffic, counted `per` sender or per subject. */
type EnvoyLimit =
	| Rate
	| { rate: Rate; per: 'sender' | 'subject' }
	| readonly { rate: Rate; per: 'sender' | 'subject' }[];
type EnvoyKey = 'envoys.receive' | 'envoys.unrecognised';
/**
 * What a `limits` entry throttles: acts, reads, agent turns, registration, uploads, page PDF previews
 * (`convert`, `ctx.preview_pdf`; default `30/min`) or envoy traffic. Requests only: automation bodies are never limited,
 * and manual starts have a separate fixed quota per automation and starter.
 */
export type LimitKey = 'act' | 'read' | 'agent' | 'register' | 'upload' | 'convert' | EnvoyKey;

// ── the policy ──
type Grants<P> = P extends { grants: infer G } ? G : {};
interface PolicyFor<C extends Grantable> {
	description: string;
	grants: { [K in C]?: K extends Identity ? IdentityGrant<K> : Grant<K> };
	capabilities?: {
		automations?: readonly AutomationName[];
		/** Remote reads the holder may refresh through the native sync controls (`model.sync_name`). */
		syncs?: readonly SyncKey[];
		apps?: readonly (AppName | GroupName)[];
		tools?: readonly HostToolName[];
		mcp?: readonly McpName[];
	};
	limits?: { [K in LimitKey]?: K extends EnvoyKey ? EnvoyLimit : Limit };
}
type PolicyBase = {
	/** What holding the policy is for, for people and the agent. */
	description: string;
	/** Per model, the granted outputs and their scopes and history, and the admitted model verbs. */
	grants: { readonly [model: string]: object } & VerdictSlots;
	/** The apps, manual starts, host tools and MCP servers holders may use; every agent skill is open to all. */
	capabilities?: { readonly [k: string]: readonly string[] };
	/** Rate limits per limit key. */
	limits?: { readonly [key: string]: unknown };
};

/**
 * `src/access_control/policy/+<name>.policy.ts`: what holders may do: per-model `grants` (the read outputs they read —
 * the default and named `outputs` and a row filter per layer of each, and `create`, `update` and `delete`
 * with their `columns` per layer and a `verdict` returning `allow` or `approve`, or refusing), the
 * automations they may start, remote syncs they may refresh, capabilities (apps, host tools, MCP servers) and rate `limits`.
 * A model's policy alone guards its access points and every layer under them. Teams and automations hold policies.
 * `approve(flow)` is the whole approval mechanism: the write is held as a native approval request, the named step
 * approvers decide it in the record's approval panel, and a rejection restores the checkpoint. A page needs no
 * separate approval control. The model's verb effects receive the write and approval events.
 * Returns the literal.
 * @example
 * export default policy({
 * 	description: 'Contractors raise variations on their own jobs.',
 * 	grants: {
 * 		variation_requests: {
 * 			outputs: { default: { where: { raised_by: { eq: { var: 'requestor.id' } } } } },
 * 			create: {
 * 				columns: { fields: ['job_assignment_id', 'title', 'amount'] },
 * 				verdict: function* (rows, ctx) {
 * 					const { job_assignments } = yield* ctx.query({
 * 						job_assignments: { where: { id: { in: rows.map((r) => r.after.job_assignment_id) } }, fields: ['assignee_user_id'] }
 * 					});
 * 					const mine = job_assignments.rows.every((j) => j.assignee_user_id === ctx.actor.id);
 * 					return mine
 * 						? ctx.approve({ steps: [{ name: 'Controller review', teams: ['field_ops_controllers'] }] })
 * 						: yield* ctx.refuse('errors.own_jobs_only', { field: 'job_assignment_id' });
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
