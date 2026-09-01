// repository-health:allow SEM_PARALLEL -- access-control consumes the system-collections registry
// over the #lib alias (SYSTEM_COLLECTION_NAMES), so the pair is linked, not parallel.
import { Context, Effect, Layer, Result, Schema } from 'effect';
import { EffectId } from '@norbital-ai/bolt-protocol';
import { asc, ilike, inArray } from 'drizzle-orm';
import type { PolicyDeclaration, WorkspaceDefinition } from '#lib/authoring/workspace-schema.js';
import { SYSTEM_MODEL_TABLES } from '#lib/authoring/system-models.js';
import { SYSTEM_COLLECTION_NAMES } from '#lib/runtime/schema/system-collections.js';
import * as Database from '#lib/runtime/facilities/database.js';
import { composer, executeBuilt } from '#lib/runtime/persistence.js';
import * as Workspace from '#lib/runtime/workspace.js';
import type * as Identity from '#lib/runtime/identity/identity.js';
import { rateLimitWindowMillis, type RateLimitRule } from '#lib/authoring/rate-limits-schema.js';
import {
	AccessDenied,
	createInvocationFactory,
	type Decision,
	type Invocation
} from './invocation.js';
import { compileStructuredPredicate, mergePredicateSemantics } from './effective-plan.js';
import type { PredicateSemantics, RowPredicate, RowPredicateExpression } from './predicate.js';

export { AccessDenied } from './invocation.js';
export type { Invocation } from './invocation.js';
export {
	compileEffectiveQueryPlan,
	EffectivePlanError,
	policyIndexRequirements,
	resolveCompiledRelationship
} from './effective-plan.js';
export { compileStructuredPredicate };
export type {
	EffectiveFieldRequirement,
	EffectiveProjection,
	EffectiveQueryPlan
} from './effective-plan.js';
export { predicateExpression, predicateIsUnrestricted, predicateStatement } from './predicate.js';
export type { RowPredicate } from './predicate.js';
export { unrestricted } from './policy-surface.js';

const isJson = Schema.is(Schema.Json);

type PolicyDecision = Readonly<{
	readonly allowed: boolean;
	readonly reason: string;
}>;

/** Whether this policy belongs to the subject before action/resource matching. */
export const subjectHasPolicy = (
	policy: PolicyDeclaration,
	subject: Identity.Subject,
	held: ReadonlySet<string>
): boolean => {
	if (policy.system === true) return subject.system === true;
	if (policy.administrator === true) return subject.admin === true && subject.system !== true;
	if (policy.authenticated === true) return subject.system !== true;
	return held.has(policy.name.toLocaleLowerCase());
};

/** Matches one policy against a fully resolved subject and policy coordinate. */
export const matchesPolicy = (
	policy: PolicyDeclaration,
	subject: Identity.Subject,
	action: string,
	resource: string,
	held: ReadonlySet<string>
): boolean => {
	if (!subjectHasPolicy(policy, subject, held)) return false;
	const grants = policy.grants ?? [];
	if (grants.length > 0 && action === 'agent') return (policy.capabilities?.apps ?? []).length > 0;
	if (grants.length > 0)
		return grants.some((grant) => grant.collection === resource && grant.action === action);
	const actions = policy.actions ?? [];
	return (
		(actions.includes(action) || actions.includes('*')) &&
		((policy.capabilities?.apps ?? []).includes(resource) ||
			(policy.capabilities?.apps ?? []).includes('*'))
	);
};

/** Applies deny precedence to one access coordinate. */
export const decidePolicies = (
	policies: ReadonlyArray<PolicyDeclaration>,
	subject: Identity.Subject,
	action: string,
	resource: string,
	held: ReadonlySet<string>
): PolicyDecision => {
	const applicable = policies.filter((policy) =>
		matchesPolicy(policy, subject, action, resource, held)
	);
	if (applicable.some(({ effect }) => effect === 'deny'))
		return { allowed: false, reason: 'explicit deny' };
	if (applicable.some(({ effect }) => effect !== 'deny'))
		return { allowed: true, reason: 'explicit allow' };
	return { allowed: false, reason: 'no matching allow policy' };
};

const approvalReadExpression = (
	resource: string,
	subject: Identity.Subject
): RowPredicateExpression => {
	const team = subject.teamPath[0];
	return team === undefined
		? { kind: 'constant', value: false }
		: { kind: 'approval-read', resource, team: team.toLocaleLowerCase() };
};

const isActorBoundWhere = (value: unknown): boolean => {
	if (Array.isArray(value)) return value.some(isActorBoundWhere);
	if (value === null || typeof value !== 'object') return false;
	if (typeof Reflect.get(value, '$subject') === 'string') return true;
	return Object.values(value).some(isActorBoundWhere);
};

type GrantScopeProblem = Readonly<{
	readonly policy: string;
	readonly collection: string;
	readonly action: string;
	readonly column: string;
	readonly message: string;
}>;

const collectionSemantics = (collection: string): PredicateSemantics => ({
	dependencies: [collection],
	reversePaths: [],
	indexRequirements: [],
	routing: [],
	fields: [],
	subjectOperands: [],
	opaque: false
});

/** Reports authored row scopes whose bare column references could bind to an outer relation. */
export const grantScopeProblems = (
	definition: WorkspaceDefinition
): ReadonlyArray<GrantScopeProblem> => {
	const problems: Array<GrantScopeProblem> = [];
	const inspectionSubject: Identity.Subject = {
		userId: 'policy-inspection',
		tenantId: 'policy-inspection',
		teamPath: ['policy-inspection'],
		policies: [],
		email: 'policy-inspection@example.invalid',
		admin: false
	};
	for (const policy of definition.policies) {
		for (const grant of policy.grants ?? []) {
			if (grant.where === undefined) continue;
			const compiled = compileStructuredPredicate({
				definition,
				rootCollection: grant.collection,
				where: grant.where,
				subject: inspectionSubject,
				node: `policy.${policy.name}.${grant.collection}.${grant.action}`
			});
			if (Result.isSuccess(compiled)) continue;
			problems.push({
				policy: policy.name,
				collection: grant.collection,
				action: grant.action,
				column: compiled.failure.node,
				message: compiled.failure.message
			});
		}
	}
	return problems;
};

/** Reads one grant through the canonical effective-plan compiler. */
const grantScope = (
	where: NonNullable<PolicyDeclaration['grants']>[number]['where'],
	subject: Identity.Subject,
	resource: string,
	definition: WorkspaceDefinition
): Readonly<{
	readonly expression: RowPredicateExpression;
	readonly semantics: PredicateSemantics;
	readonly invalidReason?: string;
}> => {
	if (where === undefined)
		return {
			expression: { kind: 'constant', value: true },
			semantics: collectionSemantics(resource)
		};
	const compiled = compileStructuredPredicate({
		definition,
		rootCollection: resource,
		where,
		subject,
		node: `policy.${resource}.where`
	});
	return Result.isSuccess(compiled)
		? { expression: compiled.success.expression, semantics: compiled.success.semantics }
		: {
				expression: { kind: 'constant', value: false },
				semantics: collectionSemantics(resource),
				invalidReason: compiled.failure.message
			};
};

type CompiledGrant = Readonly<{
	readonly grant: NonNullable<PolicyDeclaration['grants']>[number];
	readonly expression: RowPredicateExpression;
	readonly semantics: PredicateSemantics;
	readonly invalidReason?: string;
	readonly actorBound: boolean;
}>;

const grantResult = (
	compiled: ReadonlyArray<CompiledGrant>,
	expression: RowPredicateExpression
): RowPredicate => {
	const fields = compiled.flatMap(({ grant }) => grant.fields ?? []);
	const authorization = compiled[0]?.grant.authorization;
	const approval = compiled.find(({ grant }) => grant.approval !== undefined)?.grant.approval;
	const semantics = mergePredicateSemantics(compiled.map(({ semantics: value }) => value));
	return {
		allowed: true,
		reason: 'matching authored grant',
		expression,
		actorBound: compiled.some(({ actorBound }) => actorBound),
		semantics,
		fields: fields.length === 0 ? undefined : [...new Set(fields)],
		authorization:
			authorization === undefined
				? undefined
				: isJson(authorization)
					? authorization
					: String(authorization),
		approval: approval === undefined ? undefined : isJson(approval) ? approval : String(approval)
	};
};

/** Unions matching authored grants into the predicate and write metadata used by execution. */
export const compileRowPredicate = (
	policies: ReadonlyArray<PolicyDeclaration>,
	subject: Identity.Subject,
	action: string,
	resource: string,
	held: ReadonlySet<string>,
	definition: WorkspaceDefinition
): RowPredicate => {
	const rootSemantics = collectionSemantics(resource);
	const applicable = policies.filter((policy) =>
		matchesPolicy(policy, subject, action, resource, held)
	);
	const grants = applicable.flatMap(
		(policy) =>
			policy.grants?.filter((grant) => grant.collection === resource && grant.action === action) ??
			[]
	);
	if (applicable.some(({ effect }) => effect === 'deny'))
		return {
			allowed: false,
			reason: 'explicit deny',
			expression: { kind: 'constant', value: false },
			actorBound: false,
			semantics: rootSemantics
		};
	if (grants.length === 0) {
		const decision = decidePolicies(policies, subject, action, resource, held);
		return {
			...decision,
			expression: { kind: 'constant', value: decision.allowed },
			actorBound: false,
			semantics: rootSemantics
		};
	}
	if (grants.length > 1)
		return {
			allowed: false,
			reason: `overlapping grants for ${action} ${resource}`,
			expression: { kind: 'constant', value: false },
			actorBound: false,
			semantics: rootSemantics
		};
	const compiled = grants.map((grant) => {
		const planned = grantScope(grant.where, subject, resource, definition);
		const approvalSemantics: PredicateSemantics = {
			dependencies: ['approval_request'],
			reversePaths: [],
			indexRequirements: [],
			routing: [],
			fields: [],
			subjectOperands: ['team'],
			opaque: false
		};
		return {
			grant,
			...planned,
			semantics:
				action === 'read'
					? mergePredicateSemantics([planned.semantics, approvalSemantics])
					: planned.semantics,
			actorBound: isActorBoundWhere(grant.where)
		};
	});
	const invalid = compiled.find(({ invalidReason }) => invalidReason !== undefined)?.invalidReason;
	if (invalid !== undefined)
		return {
			allowed: false,
			reason: invalid,
			expression: { kind: 'constant', value: false },
			actorBound: compiled.some(({ actorBound }) => actorBound),
			semantics: mergePredicateSemantics(compiled.map(({ semantics }) => semantics))
		};
	if (
		action !== 'read' &&
		compiled.some(({ expression }) => expression.kind === 'constant' && expression.value)
	)
		return grantResult(compiled, { kind: 'constant', value: true });
	const branches = compiled.map(({ expression }) => expression);
	if (action === 'read') branches.push(approvalReadExpression(resource, subject));
	const first = branches[0] ?? { kind: 'constant' as const, value: false };
	return grantResult(
		compiled,
		branches.length === 1 ? first : { kind: 'or', expressions: branches }
	);
};

/**
 * Everything a subject may call, as opposed to everything it may read.
 *
 * Four lists rather than one, because the admission rules differ: a tool name is matched exactly, an
 * MCP call is matched by its server prefix, a skill is loaded by name, and an app is a route.
 */
type SubjectCapabilities = Readonly<{
	readonly apps: ReadonlySet<string>;
	readonly tools: ReadonlySet<string>;
	readonly mcp: ReadonlySet<string>;
	readonly skills: ReadonlySet<string>;
	readonly envoyHistory: boolean;
}>;

/** The `NonEmptyString` predicate, built once: it is evaluated for every team-tree row. */
const isNonEmptyString = Schema.is(Schema.NonEmptyString);

/** Treats a team name as an exact case-insensitive value when it is bound to an ILIKE predicate. */
const escapeLikePattern = (value: string): string =>
	value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');

/**
 * Whether this subject administers the workspace.
 *
 * Read off `user.status` by `Identity.authenticate` and off nothing else — not a header,
 * not a cookie, not a role array a caller can assert. A real administrator bypasses authored
 * access policy. A team preview explicitly clears this flag before evaluation, so impersonation
 * remains the exact view of the selected team rather than an administrator overlay.
 *
 * `=== true` rather than a truthiness test, because the key is optional on `Subject`: a subject
 * built before this field existed, or projected from a table that has no `status` column, is an
 * ordinary user. Absence must never widen.
 */
const isAdministrator = (subject: Identity.Subject): boolean => subject.admin === true;

/**
 * Every policy this subject holds, resolved against what the release actually declares.
 *
 * Two sources, one union, and one rule: **a holder names an array of policies; a subject's authority
 * is the union of what that holder names.** A person's holder is their own team, `teamPath[0]`.
 * Descendants remain in `teamPath` for row-scope predicates but do not confer authority; otherwise a
 * database hierarchy edit could compose policies that no reviewed `+teams.ts` entry names. A static
 * identity — an envoy or automation — names policies directly in its declaration.
 *
 * The two cannot be confused for one another, because `policies` is a `MINTED_IDENTITY` field: no
 * row projects one and no payload may claim one, so the only way a subject carries policies directly
 * is that this runtime minted it from a declaration.
 *
 * **A team naming a policy that does not exist is inert, never fatal.** The two sides are bound by
 * name and they move independently: the team is a row an operator edits, the policy is a file that
 * ships with a release, and a rename or a deletion on either side leaves a name pointing at nothing.
 * Refusing the request would take a workspace down over a stale string; granting it is unthinkable.
 * So the name is dropped — the subject holds the policies that do exist and none that do not — and
 * the runtime says so once, naming both halves so somebody can go and fix the map.
 */
const policiesHeld = (
	definition: WorkspaceDefinition,
	subject: Identity.Subject,
	/** Layer-owned deduplication keeps one stale `(team, policy)` from burying authorization logs. */
	reportedStalePolicies: Set<string> = new Set(),
	/** Injectable only so the pure policy resolver can be tested without replacing a global logger. */
	reportWarning: (message: string) => void = (message) => Effect.runSync(Effect.logWarning(message))
): ReadonlySet<string> => {
	const held = new Set<string>();
	const path = subject.teamPath ?? [];
	const declaredTeams = definition.teams ?? {};
	// Folded on both sides, once, rather than at each comparison — team names are matched
	// case-insensitively everywhere, which is the single rule replacing the two this design had.
	const teamsByFoldedName = new Map(
		Object.entries(declaredTeams).map(([name, policies]) => [name.toLocaleLowerCase(), policies])
	);
	const declaredPolicies = new Set(
		definition.policies.map((policy) => policy.name.toLocaleLowerCase())
	);
	// A declaration's own policies, before any team is walked. A name the release does not declare is
	// dropped here as it is for a team — an envoy that outlived the policy it named answers with less
	// authority rather than with none of the runtime.
	for (const policyName of subject.policies ?? []) {
		const folded = policyName.toLocaleLowerCase();
		if (declaredPolicies.has(folded)) {
			held.add(folded);
			continue;
		}
		const key = `declaration:${policyName}`;
		if (reportedStalePolicies.has(key)) continue;
		reportedStalePolicies.add(key);
		reportWarning(
			`[bolt.access] subject "${subject.userId}" names policy "${policyName}" directly, which this release does not declare — ignoring it.`
		);
	}
	const ownTeam = path[0];
	for (const teamName of ownTeam === undefined ? [] : [ownTeam]) {
		const policies = teamsByFoldedName.get(teamName.toLocaleLowerCase());
		// A team row whose name the release does not declare holds nothing. That is the ordinary case
		// for a team an operator created before the code caught up, and it is not worth a line.
		if (policies === undefined) continue;
		for (const policyName of policies) {
			const folded = policyName.toLocaleLowerCase();
			if (declaredPolicies.has(folded)) {
				held.add(folded);
				continue;
			}
			const key = `${teamName}:${policyName}`;
			if (reportedStalePolicies.has(key)) continue;
			reportedStalePolicies.add(key);
			reportWarning(
				`[bolt.access] team "${teamName}" names policy "${policyName}", which this release does not declare — ignoring it. ` +
					`Either the policy was renamed or removed, or the team map in +teams.ts is stale.`
			);
		}
	}
	return held;
};

/** A team an administrator may view this workspace as. */
type ImpersonationTeam = Readonly<{ readonly id: string; readonly name: string }>;

/**
 * What a "team" is here, and why the list is the workspace's policies.
 *
 * The product asks for "impersonating a team, and the policy it has", and in an authored workspace
 * those are one declaration. `hr-payroll` declares `Employee`, `HR` and `Management`: each names a
 * body of staff *and* the authority that body holds, which is exactly the pair being impersonated.
 *
 * It is deliberately **not** the approver teams a grant names — `L1 Manager`, `HR Manager`,
 * `HQ Payroll HR`. Those select who may decide an approval step. They are not roles, no policy lists
 * one under `roles`, and `subjectHasPolicy` matches a subject to a policy by role — so a subject
 * carrying `roles: ['L1 Manager']` matches no policy at all, sees no app and may read nothing. That
 * view would satisfy "an employee cannot see hr_controller" by seeing *nothing whatsoever*, which is
 * a false pass rather than a preview of anyone's workspace.
 *
 * The id is the policy's own name. `subjectAsTeam` resolves it case-insensitively, because the
 * compiled client registry lists policies by lowercased filename (`employee`) while the declaration
 * names them `Employee`, and either spelling has to reach the same policy.
 */
const { team: teamTable, bolt_audit: auditTable } = SYSTEM_MODEL_TABLES;

/**
 * Merges one rule into a pattern's bucket: the more permissive wins.
 *
 * Keyed by the bucket's key, so two policies naming `envoys.receive` — one per sender, one per
 * subject — compose into both rather than one winning. "More permissive" is admissions per
 * millisecond, so a comparison between different windows is still a comparison of the same quantity.
 */
const mergeLimitRule = (
	byKey: Map<string, RateLimitRule>,
	rule: RateLimitRule,
	rate: (rule: RateLimitRule) => number
): void => {
	const existing = byKey.get(rule.key);
	if (existing === undefined || rate(rule) > rate(existing)) byKey.set(rule.key, rule);
};

export type Interface = Readonly<{
	/** Creates the only cache whose lifetime may span policy calls: exactly one runtime invocation. */
	readonly invocation: () => Invocation;
	readonly authorize: (
		subject: Identity.Subject,
		action: string,
		app: string
	) => Effect.Effect<void, AccessDenied>;
	readonly visibleApps: (subject: Identity.Subject) => ReadonlyArray<string>;
	/**
	 * The tools, MCP servers and skills this subject may reach — the union over the policies it holds.
	 *
	 * The whole of what an agent is offered, and the reason there is no agent declaration left to
	 * consult. Two people in one workspace get different tools on the *same* web agent because they
	 * hold different policies, and an envoy gets what its declared policies name. Adding a tool file
	 * widens nobody until a policy names it.
	 */
	readonly capabilities: (subject: Identity.Subject) => SubjectCapabilities;
	/**
	 * This subject's own rate rules, merged over the policies it holds.
	 *
	 * Per-holder rather than per-workspace, which is the point: a contractor and a controller can be
	 * given different budgets for the same command without either of them being the workspace's
	 * default.
	 */
	readonly limits: (
		subject: Identity.Subject
	) => Readonly<Record<string, ReadonlyArray<RateLimitRule>>>;
	readonly impersonate: (
		actor: Identity.Subject,
		target: Identity.Subject
	) => Effect.Effect<Identity.Subject, AccessDenied | Database.FacilityError>;
	/** The teams an administrator may view this workspace as, for the sidebar's picker. */
	/**
	 * The teams this workspace has, for the picker — read from `team`, not derived from policies.
	 *
	 * An Effect because a team is a row now. It used to list the workspace's *policies* and call them
	 * teams, which is why the picker offered "employee" and "hr_manager" as though they were bodies of
	 * staff, and why previewing one could never narrow approval eligibility.
	 */
	readonly impersonationTeams: () => Effect.Effect<
		ReadonlyArray<ImpersonationTeam>,
		Database.FacilityError
	>;
	/** Whether this actor may impersonate at all. The picker is offered on this and nothing else. */
	readonly mayImpersonate: (actor: Identity.Subject) => boolean;
	/**
	 * The actor as a member of one team, with no audit row.
	 *
	 * This is the per-invocation seam: every command a previewing browser sends carries the choice, so
	 * writing a row here would put one audit entry per request into `bolt_audit` and bury the entry
	 * that says the preview began. `impersonateTeam` is the audited entry point and is called once.
	 */
	readonly subjectAsTeam: (
		actor: Identity.Subject,
		teamId: string
	) => Effect.Effect<Identity.Subject, AccessDenied | Database.FacilityError>;
	/** `subjectAsTeam`, plus the `bolt_audit` row recording that this actor started the preview. */
	readonly impersonateTeam: (
		actor: Identity.Subject,
		teamId: string
	) => Effect.Effect<Identity.Subject, AccessDenied | Database.FacilityError>;
	readonly predicate: (subject: Identity.Subject, action: string, resource: string) => RowPredicate;
	readonly mask: (
		subject: Identity.Subject,
		action: string,
		resource: string,
		value: Readonly<Record<string, Schema.Json>>
	) => Readonly<Record<string, Schema.Json>>;
	readonly explain: (subject: Identity.Subject, action: string, resource: string) => Decision;
}>;

/** Identifies the access service in Effect's context so dependency wiring remains explicit and type checked. */
export const Service = Context.Service<Interface>('@norbital-ai/bolt/AccessControl');

export const layer = Layer.effect(
	Service,
	Effect.gen(function* () {
		const workspace = yield* Workspace.Service;
		const database = yield* Database.Service;
		const reportedStalePolicies = new Set<string>();
		/**
		 * The policies this subject's team confers, resolved once per question.
		 *
		 * Every decision below goes through it, so there is one place that knows how a team becomes
		 * authority — and so hiding an app can never disagree with serving a row, which is the failure
		 * this whole seam exists to prevent.
		 */
		const held = (subject: Identity.Subject): ReadonlySet<string> =>
			policiesHeld(workspace.definition, subject, reportedStalePolicies);
		const authoredCollections = new Set(
			workspace.definition.collections
				.filter(({ name }) => !SYSTEM_COLLECTION_NAMES.has(name))
				.map(({ name }) => name)
		);
		const administratorBypasses = (
			subject: Identity.Subject,
			action: string,
			resource: string
		): boolean =>
			isAdministrator(subject) && (action === 'agent' || authoredCollections.has(resource));
		const administratorPredicate = (): RowPredicate => ({
			allowed: true,
			reason: 'workspace administrator bypass',
			expression: { kind: 'constant', value: true },
			actorBound: false
		});
		const makeInvocation = createInvocationFactory((subject) => {
			const subjectHeld = policiesHeld(workspace.definition, subject, reportedStalePolicies);
			return {
				decision: (action, resource) =>
					administratorBypasses(subject, action, resource)
						? administratorPredicate()
						: decidePolicies(workspace.definition.policies, subject, action, resource, subjectHeld),
				predicate: (action, resource) =>
					administratorBypasses(subject, action, resource)
						? administratorPredicate()
						: compileRowPredicate(
								workspace.definition.policies,
								subject,
								action,
								resource,
								subjectHeld,
								workspace.definition
							)
			};
		});
		const authorize = Effect.fn('AccessControl.authorize')(function* (
			subject: Identity.Subject,
			action: string,
			app: string
		) {
			yield* makeInvocation().authorize(subject, action, app);
		});
		/** Team preview is an explicit policy coordinate, always evaluated for the real actor. */
		const mayImpersonate = (actor: Identity.Subject): boolean =>
			decidePolicies(workspace.definition.policies, actor, 'impersonate', 'identity', held(actor))
				.allowed;
		/**
		 * The same person, belonging to one team instead of their own.
		 *
		 * Identity is deliberately left alone. `userId`, `tenantId` and `email` stay the actor's, so an
		 * `Employee` preview resolves `subject.email` to the administrator's *own* employee row
		 * rather than opening a colleague's. Previewing a team asks what the workspace looks like to
		 * that team, and answering it by borrowing a real person's identity would disclose that
		 * person's records to answer a question that never named them — that is what
		 * `impersonate(actor, target)` is for, and it is a different question with its own audit row.
		 *
		 * `team` and `teamPath` become exactly the previewed team's, which is what makes this one
		 * narrowing rather than an overlay. Both halves of authority move together: the policies the
		 * team declares decide `visibleApps`, `authorize`, `predicate` and `mask`, and the team name
		 * decides which approvals the preview may act on. Substituting a *policy* — which is what this
		 * did before teams were rows — moved only the first half, so a preview could see a screen it
		 * could never have approved on.
		 *
		 * `impersonatedBy` is the actor's own id. It marks the subject as synthetic for anything
		 * downstream that keys per-user state off it, and it is the same id the audit row names.
		 */
		/**
		 * One team by name, with the path its members hold — the same walk `authenticate` performs.
		 *
		 * Shared by the picker and the preview so the two cannot disagree about what a team is. The
		 * path is resolved here rather than assumed to be the team alone, because a team confers what
		 * sits beneath it — descent is unconditional — and a preview that ignored the subtree would
		 * show a narrower workspace than the team's real members see.
		 */
		const resolveTeam = Effect.fn('AccessControl.resolveTeam')(function* (name: string) {
			const found = yield* executeBuilt(
				EffectId.make(`team-lookup:${name}`),
				database,
				composer
					.select({ id: teamTable.id, name: teamTable.name })
					.from(teamTable)
					.where(ilike(teamTable.name, escapeLikePattern(name)))
					.limit(1)
			);
			const row = found.rows[0];
			if (row == null || typeof row !== 'object') return undefined;
			const teamId = Reflect.get(row, 'id');
			const teamName = Reflect.get(row, 'name');
			if (typeof teamId !== 'string' || typeof teamName !== 'string') return undefined;
			const path: Array<string> = [teamName];
			const visited = new Set<string>([teamId]);
			let parents: ReadonlyArray<string> = [teamId];
			for (let depth = 1; depth < 8 && parents.length > 0; depth += 1) {
				const descendants = yield* executeBuilt(
					EffectId.make(`team-tree:${name}:${depth}`),
					database,
					composer
						.select({ id: teamTable.id, name: teamTable.name })
						.from(teamTable)
						.where(inArray(teamTable.parent_id, parents))
						.orderBy(asc(teamTable.name))
				);
				const next: Array<string> = [];
				for (const entry of descendants.rows) {
					if (entry === null || typeof entry !== 'object') continue;
					const id = Reflect.get(entry, 'id');
					const childName = Reflect.get(entry, 'name');
					if (typeof id !== 'string' || !isNonEmptyString(childName) || visited.has(id)) continue;
					visited.add(id);
					next.push(id);
					path.push(childName);
				}
				parents = next;
			}
			return { name: teamName, path: path.length === 0 ? [teamName] : path };
		});
		const subjectAsTeam = Effect.fn('AccessControl.subjectAsTeam')(function* (
			actor: Identity.Subject,
			teamId: string
		) {
			// Asked of the actor minted from the authenticated credential. Administrative status grants
			// this narrow preview control, not the target team's policies; those are substituted only after
			// this gate. For anybody else the claim is refused rather than ignored.
			if (!mayImpersonate(actor)) {
				return yield* new AccessDenied({
					action: 'impersonate',
					resource: teamId,
					reason: 'impersonation not permitted'
				});
			}
			/**
			 * Resolved from `team`, which is also why the runtime's own policy is now unreachable
			 * here by construction rather than by a filter. `colony system` is not a team and cannot be
			 * one: it is selected by a minted flag, so no row and no name reaches it.
			 */
			const matched = yield* resolveTeam(teamId.trim());
			if (matched === undefined) {
				return yield* new AccessDenied({
					action: 'impersonate',
					resource: teamId,
					reason: 'no team of that name'
				});
			}
			return {
				...actor,
				/**
				 * The previewed team, and the path it resolves to.
				 *
				 * A preview now names a real `team`, so it narrows the same two things a real
				 * membership decides: which policies apply, and which approvals the subject may decide.
				 * It used to substitute a *policy* name into `roles` and blank `teams` — so a preview
				 * could see a screen it could never have approved on, which is not a preview of anybody.
				 *
				 * One field, not two. `teamPath[0]` is the previewed team, and approval eligibility reads
				 * it from there — the same place `AccessControl` reads authority from.
				 */
				teamPath: matched.path,
				// Static identities may carry policies directly; a team preview is always a person's view and
				// therefore clears any direct declaration authority as well as administrator status.
				policies: [],
				// Dropped explicitly so built-in administrator-selected controls do not leak into a team
				// preview. Tenant access still comes solely from the substituted team's policies.
				admin: false,
				impersonatedBy: actor.userId
			} satisfies Identity.Subject;
		});
		return Service.of({
			invocation: makeInvocation,
			authorize,
			// Collection/query execution should create one invocation at its boundary and reuse it
			// across authorize/predicate/mask calls.
			predicate: (subject, action, resource) =>
				makeInvocation().predicate(subject, action, resource),
			mask: (subject, action, resource, value) =>
				makeInvocation().mask(subject, action, resource, value),
			explain: (subject, action, resource) =>
				administratorBypasses(subject, action, resource)
					? administratorPredicate()
					: decidePolicies(workspace.definition.policies, subject, action, resource, held(subject)),
			capabilities: (subject) => {
				if (isAdministrator(subject)) {
					return {
						apps: new Set(workspace.definition.apps.map(({ name }) => name)),
						tools: new Set(
							workspace.definition.tools
								.filter(({ mcp }) => mcp === undefined)
								.map(({ name }) => name)
						),
						mcp: new Set(
							workspace.definition.tools.flatMap(({ mcp }) =>
								mcp === undefined ? [] : [mcp.server]
							)
						),
						skills: new Set(workspace.definition.skills.map(({ name }) => name)),
						envoyHistory: true
					};
				}
				const holds = held(subject);
				const apps = new Set<string>();
				const tools = new Set<string>();
				const mcp = new Set<string>();
				const skills = new Set<string>();
				let envoyHistory = false;
				for (const policy of workspace.definition.policies) {
					if (!subjectHasPolicy(policy, subject, holds)) continue;
					for (const name of policy.capabilities?.apps ?? []) apps.add(name);
					for (const name of policy.capabilities?.tools ?? []) tools.add(name);
					for (const name of policy.capabilities?.mcp ?? []) mcp.add(name);
					for (const name of policy.capabilities?.skills ?? []) skills.add(name);
					if (policy.capabilities?.envoyHistory === 'this_envoy') envoyHistory = true;
				}
				return { apps, tools, mcp, skills, envoyHistory };
			},
			/**
			 * The merged rate rules for one subject.
			 *
			 * Most specific pattern wins, exactly as `rateLimitFor` decides between patterns. Where two
			 * policies declare the *same* pattern, the more permissive rule wins — measured as
			 * admissions per millisecond, so a comparison between different windows is still a
			 * comparison of the same quantity. That direction is deliberate and matches how grants
			 * compose: holding a second policy is holding more, never less, so adding one can widen a
			 * budget and can never quietly shrink it under somebody who was already working.
			 */
			limits: (subject) => {
				const holds = held(subject);
				const merged = new Map<string, Map<string, RateLimitRule>>();
				const rate = (rule: RateLimitRule): number => {
					const windowMillis = rateLimitWindowMillis(rule.window);
					return windowMillis === undefined ? 0 : rule.limit / windowMillis;
				};
				for (const policy of workspace.definition.policies) {
					if (!subjectHasPolicy(policy, subject, holds)) continue;
					for (const [pattern, rules] of Object.entries(policy.limits ?? {})) {
						const byKey = merged.get(pattern) ?? new Map<string, RateLimitRule>();
						for (const rule of rules) mergeLimitRule(byKey, rule, rate);
						merged.set(pattern, byKey);
					}
				}
				return Object.fromEntries(
					[...merged].map(([pattern, byKey]) => [pattern, [...byKey.values()]])
				);
			},
			visibleApps: (subject) => {
				if (isAdministrator(subject)) return workspace.definition.apps.map(({ name }) => name);
				const holds = held(subject);
				return workspace.definition.apps
					.filter(({ name }) =>
						workspace.definition.policies.some((policy) =>
							policy.grants === undefined
								? matchesPolicy(policy, subject, 'view', name, holds)
								: subjectHasPolicy(policy, subject, holds) &&
									(policy.capabilities?.apps ?? []).some(
										(app) => app === '*' || app === name || name.startsWith(`${app}/`)
									)
						)
					)
					.map(({ name }) => name);
			},
			impersonationTeams: () =>
				executeBuilt(
					EffectId.make('team-list'),
					database,
					composer
						.select({ id: teamTable.id, name: teamTable.name })
						.from(teamTable)
						.orderBy(asc(teamTable.name))
				).pipe(
					Effect.map((result) =>
						result.rows.flatMap((row): ReadonlyArray<ImpersonationTeam> => {
							const name =
								row !== null && typeof row === 'object' ? Reflect.get(row, 'name') : undefined;
							return isNonEmptyString(name) ? [{ id: name, name }] : [];
						})
					)
				),
			mayImpersonate,
			subjectAsTeam,
			impersonateTeam: Effect.fn('AccessControl.impersonateTeam')(function* (actor, teamId) {
				const subject = yield* subjectAsTeam(actor, teamId);
				// The trace, written once when the preview begins rather than on every request it covers.
				// The same `kind` carries both forms of impersonation so an auditor asking "who acted as
				// somebody else" gets one answer; the payload says which form it was.
				yield* executeBuilt(
					EffectId.make(`impersonate-team:${actor.userId}:${teamId}`),
					database,
					composer.insert(auditTable).values({
						kind: 'impersonation_started',
						subject_id: actor.userId,
						payload: { tenantId: actor.tenantId, team: teamId, teamPath: [...subject.teamPath] }
					})
				);
				return subject;
			}),
			impersonate: Effect.fn('AccessControl.impersonate')(function* (actor, target) {
				if (!mayImpersonate(actor) || actor.tenantId !== target.tenantId) {
					return yield* new AccessDenied({
						action: 'impersonate',
						resource: target.userId,
						reason: 'impersonation not permitted'
					});
				}
				yield* executeBuilt(
					EffectId.make(`impersonate:${actor.userId}:${target.userId}`),
					database,
					composer.insert(auditTable).values({
						kind: 'impersonation_started',
						subject_id: actor.userId,
						payload: { tenantId: actor.tenantId, targetUserId: target.userId }
					})
				);
				return { ...target, impersonatedBy: actor.userId };
			})
		});
	})
);
