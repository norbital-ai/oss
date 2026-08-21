import { Context, Effect, Layer, Schema } from 'effect';
import { EffectId } from '@norbital-ai/bolt-protocol';
import type { PolicyDeclaration, WorkspaceDefinition } from '../../authoring/workspace-schema.js';
import { Database } from '../facilities/database.js';
import { Workspace } from '../workspace.js';
import type { Identity } from '../identity/identity.js';

export type Decision = Readonly<{
	readonly allowed: boolean;
	readonly reason: string;
}>;

export type RowPredicate = Readonly<{
	readonly allowed: boolean;
	readonly reason: string;
	readonly sql: string;
	readonly parameters: ReadonlyArray<Schema.Json>;
	readonly fields?: ReadonlyArray<string>;
	readonly approval?: Schema.Json;
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
	parameters: []
};

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
 * Read off `bolt_auth_user.status` by `Identity.authenticate` and off nothing else — not a header,
 * not a cookie, not a role array a caller can assert. Every short-circuit below is guarded by this
 * one predicate so there is a single place to read to know what an administrator is.
 *
 * `=== true` rather than a truthiness test, because the key is optional on `Subject`: a subject
 * built before this field existed, or projected from a table that has no `status` column, is an
 * ordinary user. Absence must never widen.
 */
export const isAdministrator = (subject: Identity.Subject): boolean => subject.admin === true;

/**
 * Every `(team, policy)` pair already reported as unresolvable, so one stale name is one line.
 *
 * Module-scoped rather than per-request: this is read on the authorization path, which runs on every
 * command, and a workspace whose `+teams.ts` names a policy that no longer exists would otherwise
 * emit the same warning thousands of times a minute and bury everything else in the log.
 */
const reportedStalePolicies = new Set<string>();

/**
 * The policies a subject holds through its team, resolved against what the release actually
 * declares.
 *
 * **A team naming a policy that does not exist is inert, never fatal.** The two sides are bound by
 * name and they move independently: the team is a row an operator edits, the policy is a file that
 * ships with a release, and a rename or a deletion on either side leaves a name pointing at nothing.
 * Refusing the request would take a workspace down over a stale string; granting it is unthinkable.
 * So the name is dropped — the subject holds the policies that do exist and none that do not — and
 * the runtime says so once, naming both halves so somebody can go and fix the map.
 *
 * The warning is `console.warn` rather than an Effect log because this is a synchronous predicate on
 * the authorization path. It reaches an operator: the isolate forwards guest output to the host.
 */
export const policiesHeldByTeam = (
	definition: WorkspaceDefinition,
	subject: Identity.Subject
): ReadonlySet<string> => {
	const held = new Set<string>();
	const path = subject.teamPath ?? [];
	if (path.length === 0) return held;
	const declaredTeams = definition.teams ?? {};
	// Folded on both sides, once, rather than at each comparison — team names are matched
	// case-insensitively everywhere, which is the single rule replacing the two this design had.
	const teamsByFoldedName = new Map(
		Object.entries(declaredTeams).map(([name, policies]) => [name.toLocaleLowerCase(), policies])
	);
	const declaredPolicies = new Set(
		definition.policies.map((policy) => policy.name.toLocaleLowerCase())
	);
	for (const teamName of path) {
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
			console.warn(
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
		if (grants.length > 0 && action === 'agent') return (policy.apps ?? []).length > 0;
		if (grants.length > 0)
			return grants.some((grant) => grant.collection === resource && grant.action === action);
		const actions = policy.actions ?? [];
		return (
			(actions.includes(action) || actions.includes('*')) &&
			((policy.apps ?? []).includes(resource) || (policy.apps ?? []).includes('*'))
		);
	},
	subjectValue: (subject: Identity.Subject, path: string): Schema.Json | undefined => {
		if (path === 'requestor.norbital_id' || path === 'requestor.userId') return subject.userId;
		if (path === 'requestor.tenantId') return subject.tenantId;
		if (path === 'requestor.email') return subject.email;
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
	// Before a single policy is consulted, and deliberately so. An administrator matches no policy —
	// `subjectHasPolicy` matches by role and no workspace declares an `admin` role — so evaluating
	// the ladder for them can only ever answer "no matching allow policy". The alternative that was
	// tried, putting the founder in every team at once, made the administrator's authority a
	// derivative of the ladder: it changed whenever a template changed. Authority that is a property
	// of the person is read off the person.
	if (isAdministrator(subject)) return { allowed: true, reason: 'administrator' };
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
/** Compiles trusted authored row scope into parameterized SQL while binding every identity value separately. */
const compileWhereOwner = {
	compile: (
		where: Readonly<Record<string, unknown>> | undefined,
		subject: Identity.Subject
	): Readonly<{ sql: string; parameters: ReadonlyArray<Schema.Json> }> => {
		if (where === undefined) return { sql: 'true', parameters: [] };
		const raw = where.$sql;
		if (typeof raw === 'string') {
			const parameters: Array<Schema.Json> = [];
			const sql = raw.replaceAll(/\$\{([^}]+)\}/g, (_token, path: string) => {
				const value = PolicyEvaluation.subjectValue(subject, path);
				if (value === undefined) return 'null';
				parameters.push(value);
				return `$${parameters.length}`;
			});
			return { sql, parameters };
		}
		const parameters: Array<Schema.Json> = [];
		const clauses = Object.entries(where).flatMap(([field, value]) => {
			if (field === 'AND' || field === 'OR' || field === 'NOT' || field === 'RAW') return [];
			const resolved =
				typeof value === 'string' && /^\$\{[^}]+\}$/.test(value)
					? PolicyEvaluation.subjectValue(subject, value.slice(2, -1))
					: value;
			if (resolved === undefined) return ['false'];
			parameters.push(Schema.is(Schema.Json)(resolved) ? resolved : String(resolved));
			return [`"${field.replaceAll('"', '""')}" = $${parameters.length}`];
		});
		return { sql: clauses.length === 0 ? 'true' : clauses.join(' and '), parameters };
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
	// The same short-circuit as `decide`, and it has to be here too rather than only there: hiding an
	// app is not authority, so an administrator who was allowed the app and then filtered out of its
	// rows would see nine apps and nine empty tables. `unrestricted` carries no field mask, so `mask`
	// returns the whole row.
	if (isAdministrator(subject)) return unrestricted;
	const applicable = policies.filter((policy) =>
		PolicyEvaluation.matches(policy, subject, action, resource, held)
	);
	if (applicable.some(({ effect }) => effect === 'deny'))
		return { allowed: false, reason: 'explicit deny', sql: 'false', parameters: [] };
	const grants = applicable.flatMap(
		(policy) =>
			policy.grants?.filter((grant) => grant.collection === resource && grant.action === action) ??
			[]
	);
	if (grants.length === 0) {
		const decision = decide(policies, subject, action, resource, held);
		return { ...decision, sql: decision.allowed ? 'true' : 'false', parameters: [] };
	}
	const compiled = grants.map((grant) => ({
		grant,
		predicate: compileWhereOwner.compile(grant.where, subject)
	}));
	if (
		compiled.some(({ predicate }) => predicate.sql === 'true' && predicate.parameters.length === 0)
	) {
		const fields = compiled.flatMap(({ grant }) => grant.fields ?? []);
		const approval = compiled.find(({ grant }) => grant.approval !== undefined)?.grant.approval;
		return {
			allowed: true,
			reason: 'matching authored grant',
			sql: 'true',
			parameters: [],
			...(fields.length === 0 ? {} : { fields: [...new Set(fields)] }),
			...(approval === undefined
				? {}
				: { approval: Schema.is(Schema.Json)(approval) ? approval : String(approval) })
		};
	}
	const parameters: Array<Schema.Json> = [];
	const sql = compiled
		.map(({ predicate }) => {
			const offset = parameters.length;
			parameters.push(...predicate.parameters);
			return `(${predicate.sql.replaceAll(/\$(\d+)/g, (_token, index: string) => `$${Number(index) + offset}`)})`;
		})
		.join(' or ');
	const fields = compiled.flatMap(({ grant }) => grant.fields ?? []);
	const approval = compiled.find(({ grant }) => grant.approval !== undefined)?.grant.approval;
	return {
		allowed: true,
		reason: 'matching authored grant',
		sql,
		parameters,
		...(fields.length === 0 ? {} : { fields: [...new Set(fields)] }),
		...(approval === undefined
			? {}
			: { approval: Schema.is(Schema.Json)(approval) ? approval : String(approval) })
	};
};

/** A team an administrator may view this workspace as. */
export type ImpersonationTeam = Readonly<{ readonly id: string; readonly name: string }>;

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
/**
 * The SQL the picker and the preview both resolve through.
 *
 * One statement, so "which teams exist" and "what does previewing this one mean" cannot disagree.
 * `$1` is a team name, folded; passing null lists every team instead.
 */
/**
 * A team's subtree, depth-ordered — the same eight-level bound `authenticate` uses, and for the same
 * reason: `parent_id` is a graph an operator edits, and a recursive CTE over a cycle does not fail,
 * it simply never returns.
 */
const TEAM_TREE_LOOKUP_SQL = `with recursive tree as (
	select "norbital_id" as id, "name", 1 as depth from bolt_team where "norbital_id" = $1::uuid
	union all
	select c."norbital_id", c."name", p.depth + 1
	  from bolt_team c join tree p on c."parent_id" = p.id
	 where p.depth < 8
)
select "name" from tree order by depth`;

const TEAM_LOOKUP_SQL = `select "norbital_id"::text as id, "name"
	from bolt_team
	where $1::text is null or lower("name") = lower($1::text)
	order by "name"`;

/**
 * Whether this subject may view the workspace as somebody else. Always asked of the real actor.
 *
 * This used to be a synthetic `impersonator` role that `identity.admitFounder` bolted onto the
 * founder's role array, because no policy declares such a role and none should. That was the admin
 * status flag in disguise — a property of the person, smuggled through the namespace that says what
 * a *group* may do — and it is now simply the flag. Nothing has to agree on a magic string any more,
 * and the role ladder holds only roles a workspace actually declares.
 */
const mayImpersonate = (actor: Identity.Subject): boolean => isAdministrator(actor);

export type Interface = Readonly<{
	readonly authorize: (
		subject: Identity.Subject,
		action: string,
		app: string
	) => Effect.Effect<void, AccessDenied>;
	readonly visibleApps: (subject: Identity.Subject) => ReadonlyArray<string>;
	readonly impersonate: (
		actor: Identity.Subject,
		target: Identity.Subject
	) => Effect.Effect<Identity.Subject, AccessDenied | Database.FacilityError>;
	/** The teams an administrator may view this workspace as, for the sidebar's picker. */
	/**
	 * The teams this workspace has, for the picker — read from `bolt_team`, not derived from policies.
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
		readonly team?: string;
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
		/**
		 * The policies this subject's team confers, resolved once per question.
		 *
		 * Every decision below goes through it, so there is one place that knows how a team becomes
		 * authority — and so hiding an app can never disagree with serving a row, which is the failure
		 * this whole seam exists to prevent.
		 */
		const held = (subject: Identity.Subject): ReadonlySet<string> =>
			policiesHeldByTeam(workspace.definition, subject);
		const authorize = Effect.fn('AccessControl.authorize')(function* (
			subject: Identity.Subject,
			action: string,
			app: string
		) {
			const decision = decide(workspace.definition.policies, subject, action, app, held(subject));
			if (!decision.allowed)
				return yield* new AccessDenied({ action, resource: app, reason: decision.reason });
		});
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
			const found = yield* database.execute(EffectId.make(`team-lookup:${name}`), {
				_tag: 'Query',
				sql: TEAM_LOOKUP_SQL,
				parameters: [name]
			});
			const row = found.rows[0];
			if (row === null || row === undefined || typeof row !== 'object') return undefined;
			const teamName = Reflect.get(row, 'name');
			if (typeof teamName !== 'string') return undefined;
			const descendants = yield* database.execute(EffectId.make(`team-tree:${name}`), {
				_tag: 'Query',
				sql: TEAM_TREE_LOOKUP_SQL,
				parameters: [Reflect.get(row, 'id')]
			});
			const path = descendants.rows
				.map((entry) =>
					entry !== null && typeof entry === 'object' ? Reflect.get(entry, 'name') : undefined
				)
				.filter((entry): entry is string => typeof entry === 'string');
			return { name: teamName, path: path.length === 0 ? [teamName] : path };
		});
		const subjectAsTeam = Effect.fn('AccessControl.subjectAsTeam')(function* (
			actor: Identity.Subject,
			teamId: string
		) {
			// Asked of the actor, whose roles came from the credential the boundary authenticated. An
			// administrator already holds every policy's roles, so assuming one can only take authority
			// away; for anybody else there is nothing to assume and the claim is refused outright rather
			// than ignored — a request to run as somebody else is a claim, not a preference.
			if (!mayImpersonate(actor)) {
				return yield* new AccessDenied({
					action: 'impersonate',
					resource: teamId,
					reason: 'impersonation not permitted'
				});
			}
			/**
			 * Resolved from `bolt_team`, which is also why the runtime's own policy is now unreachable
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
				 * A preview now names a real `bolt_team`, so it narrows the same two things a real
				 * membership decides: which policies apply, and which approvals the subject may decide.
				 * It used to substitute a *policy* name into `roles` and blank `teams` — so a preview
				 * could see a screen it could never have approved on, which is not a preview of anybody.
				 */
				team: matched.name,
				teamPath: matched.path,
				// Dropped explicitly, and this is the line that makes the preview mean anything. The
				// spread carries the actor's own `admin: true`, and every short-circuit above is guarded
				// on it — so a preview that kept the flag would answer "administrator" to `decide`,
				// `predicate` and `visibleApps` alike and show the administrator their own view under
				// another team's name. Only an administrator can reach this code at all, so setting it
				// false can only ever narrow.
				admin: false,
				impersonatedBy: actor.userId
			} satisfies Identity.Subject;
		});
		return Service.of({
			authorize,
			resolveScope: ({ tenantId, userId, team, teamPath }) => ({
				tenantId,
				userId,
				...(team === undefined ? {} : { team }),
				teamPath
			}),
			predicate: (subject, action, resource) =>
				rowPredicate(workspace.definition.policies, subject, action, resource, held(subject)),
			mask: (subject, action, resource, value) => {
				const predicate = rowPredicate(
					workspace.definition.policies,
					subject,
					action,
					resource,
					held(subject)
				);
				if (!predicate.allowed) return {};
				if (predicate.fields === undefined) return value;
				return Object.fromEntries(
					Object.entries(value).filter(([field]) => predicate.fields?.includes(field))
				);
			},
			explain: (subject, action, resource) =>
				decide(workspace.definition.policies, subject, action, resource, held(subject)),
			visibleApps: (subject) => {
				// An administrator is shown the registry whole rather than the union of what the policies
				// happen to name. Filtering them through the ladder is what produced an empty sidebar for
				// the only person who could fix it.
				if (isAdministrator(subject)) return workspace.definition.apps.map(({ name }) => name);
				const holds = held(subject);
				return workspace.definition.apps
					.filter(({ name }) =>
						workspace.definition.policies.some((policy) =>
							policy.grants === undefined
								? PolicyEvaluation.matches(policy, subject, 'view', name, holds)
								: PolicyEvaluation.subjectHasPolicy(policy, subject, holds) &&
									(policy.apps ?? []).some(
										(app) => app === '*' || app === name || name.startsWith(`${app}/`)
									)
						)
					)
					.map(({ name }) => name);
			},
			impersonationTeams: () =>
				database
					.execute(EffectId.make('team-list'), {
						_tag: 'Query',
						sql: TEAM_LOOKUP_SQL,
						parameters: [null]
					})
					.pipe(
						Effect.map((result) =>
							result.rows
								.map((row) =>
									row !== null && typeof row === 'object' ? Reflect.get(row, 'name') : undefined
								)
								.filter((name): name is string => typeof name === 'string')
								.map((name) => ({ id: name, name }))
						)
					),
			mayImpersonate,
			subjectAsTeam,
			impersonateTeam: Effect.fn('AccessControl.impersonateTeam')(function* (actor, teamId) {
				const subject = yield* subjectAsTeam(actor, teamId);
				// The trace, written once when the preview begins rather than on every request it covers.
				// The same `kind` carries both forms of impersonation so an auditor asking "who acted as
				// somebody else" gets one answer; the payload says which form it was.
				yield* database.execute(EffectId.make(`impersonate-team:${actor.userId}:${teamId}`), {
					_tag: 'Query',
					sql: 'insert into bolt_audit (kind, subject_id, payload) values ($1, $2, $3)',
					parameters: [
						'impersonation_started',
						actor.userId,
						{ tenantId: actor.tenantId, team: teamId, teamPath: [...subject.teamPath] }
					]
				});
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
				yield* database.execute(EffectId.make(`impersonate:${actor.userId}:${target.userId}`), {
					_tag: 'Query',
					sql: 'insert into bolt_audit (kind, subject_id, payload) values ($1, $2, $3)',
					parameters: [
						'impersonation_started',
						actor.userId,
						{ tenantId: actor.tenantId, targetUserId: target.userId }
					]
				});
				return { ...target, impersonatedBy: actor.userId };
			})
		});
	})
);

export * as AccessControl from './access-control.js';
