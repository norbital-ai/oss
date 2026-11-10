// `policy()` (§3.3.7): per model, the read outputs holders may read and the rows of each (decision 3: a model's policy
// alone guards its access points and every layer under them), one typed `verdict` per write verb returning a `Verdict` (an
// approval flow among them, spec §8), capabilities, manual starts and limits. A grant never changes an output's shape.
// Everything a grant says is typed from the model's own declaration; nothing else type-checks.
import { Schema } from 'effect';
import type { CreateCheck, DeleteCheck, UpdateCheck } from '../ctx.ts';
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
	SyncCallable,
	TeamName,
	WritePath
} from '../names.ts';
import type { NonEmpty, Rate } from '../values.ts';
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
 * A verdict as it crosses the guest edge (JSON): execute, refuse the batch (`at`: its row, write path and column), or
 * hold it for the approval flow snapshot.
 */
export type VerdictData =
	| { readonly kind: 'allow' }
	| {
			readonly kind: 'deny';
			readonly message: string;
			readonly at?: { readonly row?: number; readonly path?: string; readonly field?: string };
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
type Scope<C extends ModelName> = ModelWhere<C> & object;
/**
 * A grant of one read output: `true` (every row of every layer), or a row filter per layer path of that output. A
 * layer's `where` filters it (the root's: which roots; a deeper one's: that layer's rows, or nulls a ref, never the
 * root). A layer the map does not name is unfiltered. The output's fields are the model's; a grant never changes them.
 */
export type ReadGrant<C extends ModelName, O = 'default'> =
	| true
	| ({
			[P in ReadPath<C, O>]?: { where?: ModelWhere<PathModel<C, P>> & object } & object;
	  } & object);
/** A `history` grant (rule 17): `true`, a scope, or `{ where }`; its revisions show the output the read names. */
type HistoryGrant<C extends ModelName> = true | Scope<C> | ({ where?: Scope<C> } & object);
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
			verdict?: O extends 'create' ? CreateCheck<C> : UpdateCheck<C>;
	  } & (O extends 'update'
			? { moves?: 'all' | { [F in StateField<C>]?: readonly Edge<C, F>[] } }
			: object));
/** A delete grant: `true`, or `{ verdict }`. */
export type DeleteGrant<C extends ModelName> = true | ({ verdict?: DeleteCheck<C> } & object);
type Declares<C, V> = ExposureSpecOf<C> extends { [P in V & string]: unknown } ? true : false;
/**
 * A model grant: its access points `read` (the `default` output) and `outputs` (named ones), `create`, `update`,
 * `delete` (each only when the model declares it) and `history`. State `moves` are part of `update`.
 */
export type Grant<C extends ModelName> = {
	read?: ReadGrant<C>;
	outputs?: { [O in Exclude<OutputName<C>, 'default'>]?: ReadGrant<C, O> };
	history?: HistoryGrant<C>;
	create?: Declares<C, 'create'> extends true ? WriteGrant<C, 'create'> : never;
	update?: Declares<C, 'update'> extends true ? WriteGrant<C, 'update'> : never;
	delete?: Declares<C, 'delete'> extends true ? DeleteGrant<C> : never;
};
/** Rule 38c: identity models are read-only to every policy: their `default` output or a named one (`directory`), rows by scope. */
export type IdentityGrant<C extends ModelName> = {
	read?: true | Scope<C>;
	outputs?: { [O in Exclude<OutputName<C>, 'default'>]?: true | Scope<C> };
};
type Identity = 'sys_user' | 'sys_invitation';
// Ledgers and API keys take no grant. Invitations are readable for provisioning automations.
type Grantable = Exclude<ReadableName, 'sys_api_key'>;
/** Contextual typing for each write grant's verdict callback. */
type VerdictSlots = {
	readonly [C in Grantable]?: {
		readonly create?: true | (object & { readonly verdict?: CreateCheck<C> });
		readonly update?: true | (object & { readonly verdict?: UpdateCheck<C> });
		readonly delete?: true | (object & { readonly verdict?: DeleteCheck<C> });
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
 * What a `limits` entry throttles: acts, reads, agent turns, registration, uploads, page PDF previews
 * (`convert`, `ctx.preview_pdf`; default `30/min`) or envoy traffic. Requests only: automation bodies are never limited,
 * and manual starts have a separate fixed quota per automation and starter.
 */
export type LimitKey = 'act' | 'read' | 'agent' | 'register' | 'upload' | 'convert' | EnvoyKey;

// ── the policy ──
/** What `capabilities.automations` may start: automations, and remote syncs with a `read` (`'<model>.sync.<sync>'`). */
export type StartableName = AutomationName | SyncCallable;
type Grants<P> = P extends { grants: infer G } ? G : {};
interface PolicyFor<C extends Grantable> {
	description: string;
	grants: { [K in C]?: K extends Identity ? IdentityGrant<K> : Grant<K> };
	capabilities?: {
		automations?: readonly StartableName[];
		apps?: readonly (AppName | GroupName)[];
		tools?: readonly HostToolName[];
		mcp?: readonly McpName[];
	};
	limits?: { [K in LimitKey]?: K extends EnvoyKey ? EnvoyLimit : Limit };
}
type PolicyBase = {
	/** What holding the policy is for, for people and the agent. */
	description: string;
	/** Per model: `read`/`outputs` (row filters of the outputs holders read), `history`, `create`/`update` (`columns` per layer and a `check`), `delete` (`check`), state `moves`. */
	grants: { readonly [model: string]: object } & VerdictSlots;
	/** The apps, manual starts, host tools and MCP servers holders may use; every agent skill is open to all. */
	capabilities?: { readonly [k: string]: readonly string[] };
	/** Rate limits per limit key. */
	limits?: { readonly [key: string]: unknown };
};

/**
 * `src/access_control/policy/+<name>.policy.ts`: what holders may do: per-model `grants` (the read outputs they read —
 * `read` for `default`, `outputs` for named ones — and a row filter per layer of each; `create`, `update` and `delete`
 * with their `columns` per layer and a `check` returning `allow`, `deny` or `approve`; `history`; state `moves`), the
 * automations and syncs they may start by hand, capabilities (apps, host tools, MCP servers) and rate `limits`.
 * A model's policy alone guards its access points and every layer under them. Teams and automations hold policies.
 * `approve(flow)` is the whole approval mechanism: the write is held as a native approval request, the named step
 * approvers decide it in the record's approval panel, and a rejection restores the checkpoint. A page needs no
 * separate approval control. `notify` on the model receives the write and approval events.
 * Returns the literal.
 * @example
 * export default policy({
 * 	description: 'Contractors raise variations on their own jobs.',
 * 	grants: {
 * 		variation_requests: {
 * 			read: { variation_requests: { where: { raised_by: { eq: { var: 'requestor.id' } } } } },
 * 			create: {
 * 				columns: { variation_requests: ['job_assignment_id', 'title', 'amount'] },
 * 				check: function* (rows, ctx) {
 * 					const { job_assignments } = yield* ctx.query({
 * 						job_assignments: { where: { id: { in: rows.map((r) => r.job_assignment_id) } }, fields: ['assignee_user_id'] }
 * 					});
 * 					const mine = job_assignments.rows.every((j) => j.assignee_user_id === ctx.actor.id);
 * 					return mine
 * 						? ctx.approve({ steps: [{ name: 'Controller review', teams: ['field_ops_controllers'] }] })
 * 						: yield* ctx.refuse('Raise variations on your own jobs.', { path: 'variation_requests', field: 'job_assignment_id' });
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
