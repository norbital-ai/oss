// repository-health:allow SEM_PARALLEL -- access-control consumes the system-collections registry
// over the #lib alias (SYSTEM_COLLECTION_NAMES), so the pair is linked, not parallel.
import { Context, Effect, Layer, Schema } from 'effect';
import { EffectId } from '@norbital-ai/bolt-protocol';
import {
	and,
	arrayContains,
	asc,
	eq,
	ilike,
	inArray,
	isNull,
	or,
	sql,
	type SQL,
	type SQLChunk
} from 'drizzle-orm';
import type { PolicyDeclaration, WorkspaceDefinition } from '#lib/authoring/workspace-schema.js';
import { SYSTEM_MODEL_TABLES } from '#lib/authoring/system-models.js';
import { physicalColumnNames } from '#lib/compiler/relational-schema.js';
import { SYSTEM_COLLECTION_NAMES } from '#lib/runtime/schema/system-collections.js';
import * as Database from '#lib/runtime/facilities/database.js';
import { composer, executeBuilt, jsonb, toStatement } from '#lib/runtime/persistence.js';
import * as Workspace from '#lib/runtime/workspace.js';
import type * as Identity from '#lib/runtime/identity/identity.js';
import { rateLimitWindowMillis, type RateLimitRule } from '#lib/authoring/rate-limits-schema.js';

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

type Decision = Readonly<{
	readonly allowed: boolean;
	readonly reason: string;
}>;

export type RowPredicate = Readonly<{
	readonly allowed: boolean;
	readonly reason: string;
	readonly sql: string;
	readonly parameters: ReadonlyArray<Schema.Json>;
	/** Whether this row set is bound to the authenticated actor rather than only shared authority. */
	readonly actorBound: boolean;
	readonly fields?: ReadonlyArray<string> | undefined;
	readonly authorization?: Schema.Json | undefined;
	readonly approval?: Schema.Json | undefined;
}>;

/**
 * The row predicate an elevated write uses.
 *
 * After hooks and approval resumes operate on records that already passed authorization, so their
 * follow-up writes must not be re-filtered by the very row predicate the original write cleared.
 */
export const unrestricted: RowPredicate = {
	allowed: true,
	reason: 'elevated',
	sql: 'true',
	parameters: [],
	actorBound: false
};

/**
 * Lifts this module's opaque policy result into a bound Drizzle expression.
 *
 * The general string-to-SQL adapter deliberately lives nowhere in persistence. Callers can only
 * hand this function a complete `RowPredicate` produced by AccessControl, and each compiler-owned
 * `$n` remains a bound parameter when the surrounding query renders.
 */
export const predicateExpression = (predicate: RowPredicate): SQL => {
	const chunks: Array<SQLChunk> = [];
	let offset = 0;
	for (const match of predicate.sql.matchAll(/\$(\d+)/g)) {
		chunks.push(sql.raw(predicate.sql.slice(offset, match.index)));
		chunks.push(sql.param(predicate.parameters[Number(match[1]) - 1] ?? null));
		offset = match.index + match[0].length;
	}
	chunks.push(sql.raw(predicate.sql.slice(offset)));
	return sql.join(chunks);
};

/** The `Schema.Json` predicate, built once: it is consulted for every clause and every approval value. */
const isJson = Schema.is(Schema.Json);

/** The `NonEmptyString` predicate, built once: it is evaluated for every team-tree row. */
const isNonEmptyString = Schema.is(Schema.NonEmptyString);

/** Treats a team name as an exact case-insensitive value when it is bound to an ILIKE predicate. */
const escapeLikePattern = (value: string): string =>
	value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');

/** Carries access denied through the typed access failure channel without losing diagnostic context. */
export class AccessDenied extends Schema.TaggedError<AccessDenied>()(
	'Bolt.AccessControl.AccessDenied',
	{
		action: Schema.NonEmptyString,
		resource: Schema.NonEmptyString,
		reason: Schema.NonEmptyString
	}
) {
	readonly category = 'access-denied' as const;
}

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
export const policiesHeld = (
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

/** Owns authored policy membership, action/resource matching, and requestor-token binding. */
const PolicyEvaluation = {
	/**
	 * Whether this policy applies to this subject.
	 *
	 * `held` is the set of policy names the subject's team confers, folded, resolved by the caller
	 * that holds the workspace definition. The two other ways to match are both flags the runtime
	 * sets on its own declarations and `PolicyDefinition` cannot express, so for anything a workspace
	 * authors there is still exactly one selector: a policy has a name, a team declares which names
	 * it holds, and nothing else selects one.
	 */
	subjectHasPolicy: (
		policy: PolicyDeclaration,
		subject: Identity.Subject,
		held: ReadonlySet<string>
	): boolean => {
		// The runtime's own policy, selected by a flag only `systemSubject` mints. Checked first
		// because it is the one policy no team can confer and no name can reach.
		if (policy.system === true) return subject.system === true;
		// Runtime controls remain enumerated even for administrators. The administrator bypass below is
		// restricted to authored collections, apps and agents; this selector admits only coordinates in
		// the runtime-owned administration policy.
		if (policy.administrator === true) return isAdministrator(subject) && subject.system !== true;
		// `SYSTEM_READ_POLICY`, which grants reads of the runtime's own collections to whoever signed
		// in. Excluding the host principal is the point of writing it this way rather than as an
		// unconditional `true`: it is not a person, and its authority is the two grants
		// `COLONY_SYSTEM_POLICY` enumerates and nothing else.
		if (policy.authenticated === true) return subject.system !== true;
		return held.has(policy.name.toLocaleLowerCase());
	},
	matches: (
		policy: PolicyDeclaration,
		subject: Identity.Subject,
		action: string,
		resource: string,
		held: ReadonlySet<string>
	): boolean => {
		if (!PolicyEvaluation.subjectHasPolicy(policy, subject, held)) return false;
		const grants = policy.grants ?? [];
		if (grants.length > 0 && action === 'agent')
			return (policy.capabilities?.apps ?? []).length > 0;
		if (grants.length > 0)
			return grants.some((grant) => grant.collection === resource && grant.action === action);
		const actions = policy.actions ?? [];
		return (
			(actions.includes(action) || actions.includes('*')) &&
			((policy.capabilities?.apps ?? []).includes(resource) ||
				(policy.capabilities?.apps ?? []).includes('*'))
		);
	},
	subjectValue: (subject: Identity.Subject, path: string): Schema.Json | undefined => {
		if (path === 'requestor.id' || path === 'requestor.userId') return subject.userId;
		if (path === 'requestor.tenantId') return subject.tenantId;
		if (path === 'requestor.email') return subject.email;
		if (path === 'requestor.team') return subject.teamPath[0];
		if (path === 'requestor.admin') return subject.admin === true;
		return undefined;
	}
};

/** Owns decide behavior at the access boundary so validation and typed semantics stay consistent for every caller. */
export const decide = (
	policies: ReadonlyArray<PolicyDeclaration>,
	subject: Identity.Subject,
	action: string,
	app: string,
	held: ReadonlySet<string>
): Decision => {
	const applicable = policies.filter((policy) =>
		PolicyEvaluation.matches(policy, subject, action, app, held)
	);
	if (applicable.some(({ effect }) => effect === 'deny'))
		return { allowed: false, reason: 'explicit deny' };
	if (applicable.some(({ effect }) => effect !== 'deny'))
		return { allowed: true, reason: 'explicit allow' };
	return { allowed: false, reason: 'no matching allow policy' };
};

/** Resolves the small, explicit requestor token vocabulary without allowing arbitrary property traversal. */
/**
 * Tokens that expand to a *subquery* rather than to a bound value.
 *
 * `${requestor.id}` and its siblings are values: the compiler binds each as a parameter,
 * which is the only safe way to put an identity into SQL. A hierarchy is not a value — "everybody at
 * or below my team" is a set the database has to walk — so it cannot be expressed that way, and an
 * author trying to write it by hand would be hand-rolling a recursive CTE inside a policy string.
 *
 * **This exists because inheriting a policy is not inheriting its rows.** Descent gives a manager
 * every policy their reports hold, but a grant scoped `${requestor.id}` re-evaluates
 * against whoever is asking — so the manager holding a report's self-scoped policy sees their *own*
 * records and nobody else's. The hierarchy has to enter the predicate, not just the policy set.
 *
 * One rule then reads differently at every level, because the tree does the work:
 *
 * ```ts
 * const ownOrBelow = { $sql: '"owner_id"::text IN ${requestor.team_scope_users}' } as const;
 * ```
 *
 * The expansion yields `text`, and the owning column is cast to match. That is deliberate rather
 * than sloppy: a `file()`-style `uuid` column and a `string()` column both name people in real
 * workspaces, and Postgres has no `uuid = text` operator — so a fragment that emitted `uuid` would
 * work for one shape and fail the other with `operator does not exist`, an error naming neither the
 * policy nor the column. One cast on each side is the spelling that works for both.
 *
 * A salesperson whose team has no children matches their own team's members; their manager matches
 * those plus everyone beneath; a director matches the whole branch. Team *granularity* is therefore
 * how "mine" versus "my team's" is chosen — a person who is their own leaf team matches only
 * themselves — and that is an organisational decision, not a code one.
 *
 * `$1` inside the expansion is the subject's own id, bound by the caller exactly like any other
 * identity value; nothing about the subject is interpolated as text. The depth bound matches
 * `TEAM_TREE_SQL` and exists for the same reason: `parent_id` is an operator-edited graph that can
 * be made cyclic, and a recursive CTE over a cycle does not fail, it runs.
 */
const SCOPE_FRAGMENTS: Readonly<Record<string, Readonly<{ $sql: string }>>> = {
	'requestor.team_scope_users': {
		$sql: `(
		with recursive scope as (
			select t."id" as id, 1 as depth
			  from "team" t
			  join "user" me on me."team_id" = t."id"
			 where me."id"::text = $SUBJECT
			union all
			select c."id", p.depth + 1
			  from "team" c join scope p on c."parent_id" = p.id
			 where p.depth < 8
		)
		select u."id"::text from "user" u where u."team_id" in (select id from scope)
	)`
	}
};

/**
 * The record a subject has been asked to approve, readable because they were asked.
 *
 * Being named on an open approval step is what entitles somebody to see the thing they are deciding
 * about. Nothing else can supply that: an approver's authored grants describe their ordinary work,
 * and the record under review is by definition one somebody *else* raised — so a reviewer whose row
 * scope is their own team, or their own records, is exactly the reviewer a narrowing excludes.
 *
 * This is a **union** branch, never a replacement. It widens a predicate by precisely the rows under
 * an open approval this subject's team may decide, and by nothing else. When the approval closes,
 * `closed_at` stops being null and the row leaves the branch on the next request — the entitlement
 * lasts exactly as long as the reason for it.
 *
 * Deliberately not applied when the subject has *no* grant on the collection at all. That case would
 * mean flipping `allowed` from false to true, and `allowed` is also what `Sync.shape` reads to
 * decide which collections replicate — so every collection would enter every subject's replica for
 * the sake of rows they usually do not have. An approver who cannot reach the collection is a
 * workspace that has asked somebody to review a surface they were never given; that is an authoring
 * problem, and widening the sync shape is the wrong place to answer it.
 *
 * The approver leg reads `bolt_approvals`, not `approval_request.steps`, for the same reason its
 * sibling in `system-collections.ts` does: `steps` is a cursor — `[{"step":0}]` — and a containment
 * test over it compiles, runs, and matches nothing.
 */
const approvalReadTerm = (
	resource: string,
	subject: Identity.Subject,
	firstParameterIndex: number
): Readonly<{ sql: string; parameters: ReadonlyArray<Schema.Json> }> | undefined => {
	const team = subject.teamPath[0];
	if (team === undefined) return undefined;
	const { approval_request: approvalRequest } = SYSTEM_MODEL_TABLES;
	const foldedTeam = team.toLocaleLowerCase();
	const query = composer
		.select({ recordId: approvalRequest.record_id })
		.from(approvalRequest)
		.where(
			and(
				eq(approvalRequest.collection_name, resource),
				isNull(approvalRequest.closed_at),
				or(
					arrayContains(approvalRequest.approver_teams, jsonb([foldedTeam])),
					arrayContains(approvalRequest.superseder_teams, jsonb([foldedTeam]))
				)
			)
		);
	const statement = toStatement(query.toSQL());
	return {
		sql: `"id"::text in (${statement.sql.replaceAll(
			/\$(\d+)/g,
			(_token, index: string) => `$${Number(index) + firstParameterIndex - 1}`
		)})`,
		parameters: statement.parameters
	};
};

type CompiledOwnerWhere = Readonly<{
	readonly sql: string;
	readonly parameters: ReadonlyArray<Schema.Json>;
}>;

const OWNER_COMPARISONS = {
	eq: '=',
	ne: '<>',
	gt: '>',
	gte: '>=',
	lt: '<',
	lte: '<=',
	like: 'like',
	ilike: 'ilike',
	notLike: 'not like',
	notIlike: 'not ilike',
	arrayContains: '@>',
	arrayContained: '<@',
	arrayOverlaps: '&&',
	contains: '@>'
} as const;

/**
 * Replaces exact identity tokens at every depth of a structured policy predicate.
 *
 * A token is an operand, never a string interpolation: `${requestor.id}` therefore becomes one
 * bound UUID whether it appears directly, under `eq`, or in a logical branch. An unknown token is
 * left as `undefined`, which the compiler below turns into `false`; a stale identity path must narrow
 * access rather than widening it.
 */
const resolveOwnerOperand = (value: unknown, subject: Identity.Subject): unknown => {
	if (typeof value === 'string') {
		const token = /^\$\{([^}]+)\}$/.exec(value);
		return token === null ? value : PolicyEvaluation.subjectValue(subject, token[1] ?? '');
	}
	if (Array.isArray(value)) return value.map((entry) => resolveOwnerOperand(entry, subject));
	if (value === null || typeof value !== 'object') return value;
	return Object.fromEntries(
		Object.entries(value).map(([key, entry]) => [key, resolveOwnerOperand(entry, subject)])
	);
};

/**
 * Actor-valued requestor operands prevent two members of the same authority holder from sharing a
 * streamed partition. Team, tenant and administrator operands remain uniform inside their existing
 * holder partition; id, email and the team-scope expansion carry the concrete actor into SQL.
 */
const isActorBoundWhere = (value: unknown): boolean => {
	if (typeof value === 'string')
		return /\$\{requestor\.(?:id|userId|email|team_scope_users)\}/u.test(value);
	if (Array.isArray(value)) return value.some(isActorBoundWhere);
	if (value === null || typeof value !== 'object') return false;
	return Object.values(value).some(isActorBoundWhere);
};

/**
 * Every column name one authored row scope names, at any depth.
 *
 * Four keys are structure rather than columns, and they are the same four `compileWhereOwner`
 * reads specially before treating everything else as a column. The two readings have to agree: a
 * structural key missing here is reported as a column the collection does not have, and one
 * missing there is a column nothing checks.
 */
const grantScopeColumns = (where: unknown, named: Set<string>): void => {
	if (where === null || typeof where !== 'object' || Array.isArray(where)) return;
	for (const [key, condition] of Object.entries(where)) {
		// A `$sql` fragment is opaque on purpose: it is a whole SQL expression that brings its own
		// tables and aliases — `"team" t`, `me."id"` — so nothing here could tell one of its
		// identifiers from a column of the collection, and guessing would refuse correct policies.
		if (key === '$sql') continue;
		if (key === 'AND' || key === 'OR') {
			if (Array.isArray(condition))
				for (const branch of condition) grantScopeColumns(branch, named);
			continue;
		}
		if (key === 'NOT') {
			grantScopeColumns(condition, named);
			continue;
		}
		named.add(key);
	}
};

/** One authored grant whose row scope names something its collection does not have. */
export type GrantScopeProblem = Readonly<{
	readonly policy: string;
	readonly collection: string;
	readonly action: string;
	readonly column: string;
	readonly message: string;
}>;

/**
 * Refuses a grant whose row scope names a column the collection does not have.
 *
 * A compiled row scope is a **bare** column reference — `"employment_id" = $1` — because the
 * collection is its own `from` clause and nothing else is in scope. That stopped being true when a
 * `with` clause became one statement: a related collection is read inside a lateral subquery, where
 * the row being joined from is also in scope. PostgreSQL resolves an unqualified name innermost
 * first, so a scope naming a column the *target* has still binds to the target — but one naming a
 * column it does **not** have silently binds outward and filters the parent row instead of the
 * related one. That is a grant quietly evaluating against the wrong record, and it is the failure
 * mode a policy must never have.
 *
 * Checked here rather than fixed by qualifying identifiers, because qualifying them is not
 * something this module can do correctly: `$sql` fragments carry their own tables and aliases, and
 * rewriting their identifiers would break every policy that uses one. Refusing an unresolvable
 * column at release restores the loud failure that unqualified SQL used to give for free — a
 * collection with no such column raised "column does not exist" the moment the query ran.
 *
 * Reported rather than thrown: the workspace's other release-time authority checks collect their
 * diagnostics and refuse activation together, and one policy typo should not hide the next.
 */
export const grantScopeProblems = (
	definition: WorkspaceDefinition
): ReadonlyArray<GrantScopeProblem> => {
	const columnsByCollection = new Map(
		definition.collections.map((collection) => [
			collection.name,
			physicalColumnNames(collection.fields)
		])
	);
	const problems: Array<GrantScopeProblem> = [];
	for (const policy of definition.policies) {
		for (const grant of policy.grants ?? []) {
			// A grant on a collection this workspace does not declare is a different fault, and one this
			// check has nothing true to say about: it has no column list to compare against.
			const columns = columnsByCollection.get(grant.collection);
			if (columns === undefined) continue;
			const named = new Set<string>();
			grantScopeColumns(grant.where, named);
			for (const column of [...named].toSorted()) {
				if (columns.has(column)) continue;
				problems.push({
					policy: policy.name,
					collection: grant.collection,
					action: grant.action,
					column,
					message:
						`policy "${policy.name}" scopes ${grant.action} on ${grant.collection} by "${column}", ` +
						`which ${grant.collection} does not have. A row scope compiles to a bare column reference, so inside ` +
						`the lateral join a \`with\` clause reads this collection through, an unknown name resolves against the ` +
						`outer row instead of failing — the grant would filter the wrong record rather than refuse. Name a column ` +
						`${grant.collection} has; a polymorphic reference is scoped by its storage column, not by the field name. ` +
						`(A \`$sql\` fragment is not checked here: it brings its own tables, so it must qualify every column it names.)`
				});
			}
		}
	}
	return problems;
};

/** Compiles trusted authored row scope into parameterized SQL while binding every identity value separately. */
const compileWhereOwner = {
	compile: (
		where: Readonly<Record<string, unknown>> | undefined,
		subject: Identity.Subject
	): CompiledOwnerWhere => {
		if (where === undefined) return { sql: 'true', parameters: [] };
		const parameters: Array<Schema.Json> = [];
		const bind = (operand: unknown): string | undefined => {
			const resolved = resolveOwnerOperand(operand, subject);
			if (!isJson(resolved)) return undefined;
			parameters.push(resolved);
			return `$${parameters.length}`;
		};
		const rawSql = (raw: string): string =>
			raw.replaceAll(/\$\{([^}]+)\}/g, (_token, path: string) => {
				// A fragment first, because it is SQL rather than a value and must not be bound. It still
				// carries the subject's id as a parameter — `$SUBJECT` is replaced with the placeholder
				// number, never with the id itself.
				const fragment = SCOPE_FRAGMENTS[path];
				if (fragment !== undefined) {
					const id = PolicyEvaluation.subjectValue(subject, 'requestor.id');
					if (id === undefined) return '(select null where false)';
					parameters.push(id);
					return fragment.$sql.replaceAll('$SUBJECT', `$${parameters.length}`);
				}
				const value = PolicyEvaluation.subjectValue(subject, path);
				if (value === undefined) return 'null';
				parameters.push(value);
				return `$${parameters.length}`;
			});
		const join = (
			clauses: ReadonlyArray<string>,
			operator: 'and' | 'or',
			empty: 'true' | 'false'
		): string => {
			if (clauses.length === 0) return empty;
			if (clauses.length === 1) return clauses[0] ?? empty;
			return `(${clauses.join(` ${operator} `)})`;
		};
		const compileOperator = (field: string, operator: string, operand: unknown): string => {
			const column = `"${field.replaceAll('"', '""')}"`;
			if (Object.hasOwn(OWNER_COMPARISONS, operator)) {
				const placeholder = bind(operand);
				if (placeholder === undefined) return 'false';
				return `${column} ${OWNER_COMPARISONS[operator as keyof typeof OWNER_COMPARISONS]} ${placeholder}`;
			}
			if (operator === 'in' || operator === 'notIn') {
				if (!Array.isArray(operand)) return 'false';
				if (operand.length === 0) return operator === 'in' ? 'false' : 'true';
				const placeholders = operand.map(bind);
				if (placeholders.some((placeholder) => placeholder === undefined)) return 'false';
				return `${column} ${operator === 'in' ? 'in' : 'not in'} (${placeholders.join(', ')})`;
			}
			if (operator === 'isNull' || operator === 'isNotNull') {
				if (typeof operand !== 'boolean') return 'false';
				const wantsNull = operator === 'isNull' ? operand : !operand;
				return `${column} is ${wantsNull ? '' : 'not '}null`;
			}
			if (operator === 'contains_date') {
				const placeholder = bind(operand);
				if (placeholder === undefined) return 'false';
				return `((${column}->>'start')::timestamptz <= ${placeholder} and (${column}->>'end' is null or (${column}->>'end')::timestamptz >= ${placeholder}))`;
			}
			if (operator === 'overlaps') {
				if (operand === null || typeof operand !== 'object' || Array.isArray(operand))
					return 'false';
				const start = bind(Reflect.get(operand, 'start'));
				const end = bind(Reflect.get(operand, 'end'));
				if (start === undefined || end === undefined) return 'false';
				return `((${column}->>'start')::timestamptz <= ${end} and ${start}::timestamptz <= coalesce((${column}->>'end')::timestamptz, 'infinity'::timestamptz))`;
			}
			return 'false';
		};
		const compileField = (field: string, condition: unknown): string => {
			if (condition === null || typeof condition !== 'object' || Array.isArray(condition))
				return compileOperator(field, 'eq', condition);
			const clauses = Object.entries(condition).map(([operator, operand]) =>
				compileOperator(field, operator, operand)
			);
			return join(clauses, 'and', 'true');
		};
		const compileObject = (input: unknown): string => {
			if (input === null || typeof input !== 'object' || Array.isArray(input)) return 'false';
			const clauses: Array<string> = [];
			for (const [field, condition] of Object.entries(input)) {
				if (field === '$sql') {
					clauses.push(typeof condition === 'string' ? rawSql(condition) : 'false');
					continue;
				}
				if (field === 'AND' || field === 'OR') {
					if (!Array.isArray(condition)) {
						clauses.push('false');
						continue;
					}
					clauses.push(
						join(
							condition.map(compileObject),
							field === 'AND' ? 'and' : 'or',
							field === 'AND' ? 'true' : 'false'
						)
					);
					continue;
				}
				if (field === 'NOT') {
					clauses.push(`not (${compileObject(condition)})`);
					continue;
				}
				clauses.push(compileField(field, condition));
			}
			return join(clauses, 'and', 'true');
		};
		return { sql: compileObject(where), parameters };
	}
};

/** Unions matching authored grants into the exact predicate, mask, and approval metadata used by collection execution. */
const rowPredicate = (
	policies: ReadonlyArray<PolicyDeclaration>,
	subject: Identity.Subject,
	action: string,
	resource: string,
	held: ReadonlySet<string>
): RowPredicate => {
	const applicable = policies.filter((policy) =>
		PolicyEvaluation.matches(policy, subject, action, resource, held)
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
			sql: 'false',
			parameters: [],
			actorBound: false
		};
	if (grants.length === 0) {
		const decision = decide(policies, subject, action, resource, held);
		return {
			...decision,
			sql: decision.allowed ? 'true' : 'false',
			parameters: [],
			actorBound: false
		};
	}
	if (grants.length > 1) {
		return {
			allowed: false,
			reason: `overlapping grants for ${action} ${resource}`,
			sql: 'false',
			parameters: [],
			actorBound: false
		};
	}
	const compiled = grants.map((grant) => ({
		grant,
		predicate: compileWhereOwner.compile(grant.where, subject),
		actorBound: isActorBoundWhere(grant.where)
	}));
	if (
		compiled.some(({ predicate }) => predicate.sql === 'true' && predicate.parameters.length === 0)
	) {
		const fields = compiled.flatMap(({ grant }) => grant.fields ?? []);
		const authorization = compiled[0]?.grant.authorization;
		const approval = compiled.find(({ grant }) => grant.approval !== undefined)?.grant.approval;
		return {
			allowed: true,
			reason: 'matching authored grant',
			sql: 'true',
			parameters: [],
			actorBound: compiled.some(({ actorBound }) => actorBound),
			fields: fields.length === 0 ? undefined : [...new Set(fields)],
			authorization:
				authorization === undefined
					? undefined
					: isJson(authorization)
						? authorization
						: String(authorization),
			approval: approval === undefined ? undefined : isJson(approval) ? approval : String(approval)
		};
	}
	const parameters: Array<Schema.Json> = [];
	const branches = compiled.map(({ predicate }) => {
		const offset = parameters.length;
		parameters.push(...predicate.parameters);
		return `(${predicate.sql.replaceAll(/\$(\d+)/g, (_token, index: string) => `$${Number(index) + offset}`)})`;
	});
	// Being asked to approve a record is its own entitlement to read it, unioned on top of whatever
	// the authored grants narrow to. Reads only: approving something does not license editing it.
	if (action === 'read') {
		const approvalBranch = approvalReadTerm(resource, subject, parameters.length + 1);
		if (approvalBranch !== undefined) {
			parameters.push(...approvalBranch.parameters);
			branches.push(`(${approvalBranch.sql})`);
		}
	}
	const sql = branches.join(' or ');
	const fields = compiled.flatMap(({ grant }) => grant.fields ?? []);
	const authorization = compiled[0]?.grant.authorization;
	const approval = compiled.find(({ grant }) => grant.approval !== undefined)?.grant.approval;
	return {
		allowed: true,
		reason: 'matching authored grant',
		sql,
		parameters,
		actorBound: compiled.some(({ actorBound }) => actorBound),
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
	readonly resolveScope: (subject: Identity.Subject) => {
		readonly tenantId: string;
		readonly userId: string;
		readonly team: string | null;
		readonly teamPath: ReadonlyArray<string>;
	};
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
			sql: 'true',
			parameters: [],
			actorBound: false
		});
		const authorize = Effect.fn('AccessControl.authorize')(function* (
			subject: Identity.Subject,
			action: string,
			app: string
		) {
			if (administratorBypasses(subject, action, app)) return;
			const decision = decide(workspace.definition.policies, subject, action, app, held(subject));
			if (!decision.allowed)
				return yield* new AccessDenied({ action, resource: app, reason: decision.reason });
		});
		/** Team preview is an explicit policy coordinate, always evaluated for the real actor. */
		const mayImpersonate = (actor: Identity.Subject): boolean =>
			decide(workspace.definition.policies, actor, 'impersonate', 'identity', held(actor)).allowed;
		/**
		 * The same person, belonging to one team instead of their own.
		 *
		 * Identity is deliberately left alone. `userId`, `tenantId` and `email` stay the actor's, so an
		 * `Employee` preview resolves `${requestor.email}` to the administrator's *own* employee row
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
			authorize,
			resolveScope: ({ tenantId, userId, teamPath }) => ({
				tenantId,
				userId,
				team: teamPath[0] ?? null,
				teamPath
			}),
			predicate: (subject, action, resource) =>
				administratorBypasses(subject, action, resource)
					? administratorPredicate()
					: rowPredicate(workspace.definition.policies, subject, action, resource, held(subject)),
			mask: (subject, action, resource, value) => {
				if (administratorBypasses(subject, action, resource)) return value;
				const predicate = rowPredicate(
					workspace.definition.policies,
					subject,
					action,
					resource,
					held(subject)
				);
				if (!predicate.allowed) return {};
				if (predicate.fields === undefined) return value;
				// Replica rows are version-gated identities. A read field restriction may hide every
				// authored field except those named by the grant, but it cannot remove the two system
				// facts required to install and order an authoritative full-row update safely.
				return Object.fromEntries(
					Object.entries(value).filter(
						([field]) =>
							predicate.fields?.includes(field) ||
							(action === 'read' && (field === 'id' || field === 'row_version'))
					)
				);
			},
			explain: (subject, action, resource) =>
				administratorBypasses(subject, action, resource)
					? administratorPredicate()
					: decide(workspace.definition.policies, subject, action, resource, held(subject)),
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
					if (!PolicyEvaluation.subjectHasPolicy(policy, subject, holds)) continue;
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
					if (!PolicyEvaluation.subjectHasPolicy(policy, subject, holds)) continue;
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
								? PolicyEvaluation.matches(policy, subject, 'view', name, holds)
								: PolicyEvaluation.subjectHasPolicy(policy, subject, holds) &&
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
