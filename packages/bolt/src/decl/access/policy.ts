// `policy()` (§3.3.7): grants per collection, optional source approval fallbacks (§3.8), capabilities and
// limits. Each spec below takes the literal it checks as a defaulted parameter: with the default it is the general
// type the RFC names (`Grant<C>`, `Approval<C>`), with the literal it adds the checks a general type cannot carry
// (`'read'` only beside `read`, `via` alone, non-empty steps).
import type { ActionName, InputSel, QueryName } from '../ctx.ts';
import type { Checked, Exact } from '../fields.ts';
import type {
	AppName,
	AutomationName,
	CollectionName,
	Columns,
	FedName,
	FieldName,
	HostToolName,
	KioskName,
	McpName,
	NamesPart,
	OneRels,
	ReadField,
	ReadableName,
	SkillName,
	TeamName
} from '../names.ts';
import type { NonEmpty, Rate } from '../values.ts';
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
/** What an op's grant may admit field by field: the collection's allowlist for that op, relation actions included. */
export type WriteField<C, O = 'create' | 'update'> =
	InputSel<C, O> extends infer S
		? S extends { columns: readonly (infer P)[] }
			? (P | (S extends { with: infer W } ? keyof W : never)) & string
			: never
		: never;

// ── approval (§3.8) ──
/**
 * When an approval route applies: the record matches `record`, the write changes one of `changed`, the requestor is in a team
 * (or none, or one of `team`), combined with `and`/`or`/`not`; an update may also test the `previous` row.
 */
export type ApprovalMatch<C extends CollectionName, O = Op> = {
	record?: Where<C>;
	changed?: readonly FieldName<C>[];
	requestor?: 'in_team' | 'no_team' | { team: readonly TeamName[] };
	and?: readonly ApprovalMatch<C, O>[];
	or?: readonly ApprovalMatch<C, O>[];
	not?: ApprovalMatch<C, O>;
} & (O extends 'update' ? { previous?: Where<C> } : {});
type Steps<S> = S extends readonly []
	? 'error: an approval needs at least one step'
	: S extends readonly (readonly TeamName[])[]
		? [Extract<S[number], readonly []>] extends [never]
			? S
			: 'error: every approval step names a source team handle'
		: readonly NonEmpty<TeamName>[];
/** One route: the first route whose `match` matches supplies the steps (sequential; teams in one step are alternatives). */
export type Approval<C extends CollectionName, O = Op, R = unknown> = {
	match?: ApprovalMatch<C, O>;
	where?: Where<C>;
	fields?: O extends 'delete' ? never : readonly WriteField<C, O>[];
	steps: unknown extends R
		? NonEmpty<NonEmpty<TeamName>>
		: Steps<R extends { steps: infer S } ? S : never>;
	superseded_by?: readonly TeamName[];
} & (O extends 'update' ? { previous?: Where<C> } : {});
type Route<C extends CollectionName, O, R> = R extends { steps: unknown }
	? Approval<C, O, R>
	: Steps<readonly []>;
type Routes<C extends CollectionName, O, A> = unknown extends A
	? Approval<C, O> | readonly Approval<C, O>[]
	: A extends readonly unknown[]
		? { readonly [I in keyof A]: Route<C, O, A[I]> }
		: Route<C, O, A>;

// ── grants ──
// `& object` on every all-optional arm: the parameter is `P & Exact<P, …>`, and a string intersected with such an arm
// is not refused, so `update: 'read'` without a `read` grant would pass.
type Scope<C extends CollectionName> = Where<C> & object;
type ReadGrant<C extends CollectionName> =
	true | Scope<C> | ({ where?: Scope<C>; fields?: readonly ReadField<C>[] } & object);
type Part<G, K extends string> = G extends { [P in K]: unknown } ? G[K & keyof G] : unknown;
/** A create or update grant; `G` is the whole grant literal, so `'read'` exists only beside a `read` grant (rule 35). */
export type WriteGrant<
	C extends CollectionName,
	O extends 'create' | 'update' = 'create' | 'update',
	G = { read: true }
> = (G extends { read: unknown } ? 'read' : never) extends infer Rd
	? | true
		| Rd
		| Scope<C>
		| ({ where?: Scope<C> | Rd; fields?: readonly WriteField<C, O>[] } & (O extends 'update'
				? { previous?: Scope<C> | true }
				: {}) &
				object)
	: never;
type DeleteGrant<C extends CollectionName, G> = true | Scope<C> | ({ where?: Scope<C> } & object);
type Scoped<C extends CollectionName, G> = {
	read?: ReadGrant<C>;
	history?: ReadGrant<C>;
	queries?: readonly QueryName<C>[];
	moves?: 'all' | { [F in StateField<C>]?: readonly Edge<C, F>[] };
	/** Optional review of a denied write; declaring this never grants direct write permission. */
	approval?: { [O in Op]?: Routes<C, O, Part<Part<G, 'approval'>, O>> };
} & (C extends FedName
	? { update?: WriteGrant<C, 'update', G> } // a feed target: only its local fields are written
	: {
			create?: WriteGrant<C, 'create', G>;
			update?: WriteGrant<C, 'update', G>;
			delete?: DeleteGrant<C, G>;
			actions?: readonly ActionName<C>[];
		});
/** A collection grant: scoped operations, or `via` alone, which inherits the parent's grant. */
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
type Identity = 'sys_user' | 'sys_team' | 'sys_invitation';
// Ledgers and API keys take no grant. Invitations are readable for provisioning automations.
type Grantable = Exclude<ReadableName, 'sys_api_key'>;

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
 * What a `limits` entry throttles: acts, reads, agent turns, registration, uploads, envoy traffic, or one `'<c>.<query|action>'`.
 */
export type LimitKey =
	| 'act'
	| 'read'
	| 'agent'
	| 'register'
	| 'upload'
	| EnvoyKey
	| { [C in CollectionName]: `${C}.${QueryName<C> | ActionName<C>}` }[CollectionName];

// ── the policy ──
/** What `policy.automations` may start: automations, and feed runs (`<definition>.<feed>`). */
export type StartableName = AutomationName | (NamesPart<'fed'>[FedName] & string);
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
	/** Per collection: `read`, `history`, `create`, `update`, `delete` (each `true`, a scope or fields), `queries`, `actions`, state `moves`, approvals, or `via` a parent. */
	grants: { readonly [collection: string]: object };
	/** The automations (and `<definition>.<feed>` runs) holders may start. */
	automations?: readonly string[];
	/** The apps (or groups), host tools, MCP servers and agent skills holders may use. */
	capabilities?: { readonly [k: string]: readonly string[] };
	/** Rate limits per limit key. */
	limits?: { readonly [key: string]: unknown };
};

/**
 * `src/access_control/policy/+<name>.policy.ts`: what holders may do: per-collection `grants` (read, create, update, delete, queries,
 * actions, state moves, approvals), the automations they may start, capabilities (apps, host tools, MCP servers, skills)
 * and rate `limits`. Teams hold policies in `src/access_control/team/+team.ts`. Returns the literal.
 * @example
 * export default policy({
 * 	description: 'Reads the product catalogue.',
 * 	grants: { products: { read: true } },
 * 	capabilities: { apps: ['crm'] }
 * });
 */
export function policy<const P extends PolicyBase>(
	spec: P & NoInfer<Checked<PolicyBase, P, Exact<P, PolicyFor<P, keyof Grants<P> & Grantable>>>>
): P {
	return spec;
}
