import { Context, Effect, Layer, Schema } from 'effect';
import { EffectId } from '@norbital-ai/bolt-protocol';
import type { PolicyDeclaration } from '../../authoring/workspace-schema.js';
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

/** Owns authored policy membership, action/resource matching, and requestor-token binding. */
const PolicyEvaluation = {
	subjectHasPolicy: (policy: PolicyDeclaration, subject: Identity.Subject): boolean => {
		const roles = policy.roles ?? [policy.name];
		if (roles.length === 0) return true;
		const subjectRoles = subject.roles.map((role) => role.toLocaleLowerCase());
		return roles.some((role) => subjectRoles.includes(role.toLocaleLowerCase()));
	},
	matches: (policy: PolicyDeclaration, subject: Identity.Subject, action: string, resource: string): boolean => {
		if (!PolicyEvaluation.subjectHasPolicy(policy, subject)) return false;
		const grants = policy.grants ?? [];
		if (grants.length > 0 && action === 'agent') return (policy.apps ?? []).length > 0;
		if (grants.length > 0) return grants.some((grant) => grant.collection === resource && grant.action === action);
		const actions = policy.actions ?? [];
		return (actions.includes(action) || actions.includes('*')) && ((policy.apps ?? []).includes(resource) || (policy.apps ?? []).includes('*'));
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
	app: string
): Decision => {
	const applicable = policies.filter((policy) => PolicyEvaluation.matches(policy, subject, action, app));
	if (applicable.some(({ effect }) => effect === 'deny')) return { allowed: false, reason: 'explicit deny' };
	if (applicable.some(({ effect }) => effect !== 'deny')) return { allowed: true, reason: 'explicit allow' };
	return { allowed: false, reason: 'no matching allow policy' };
};

/** Resolves the small, explicit requestor token vocabulary without allowing arbitrary property traversal. */
/** Compiles trusted authored row scope into parameterized SQL while binding every identity value separately. */
const compileWhereOwner = {
compile: (where: Readonly<Record<string, unknown>> | undefined, subject: Identity.Subject): Readonly<{ sql: string; parameters: ReadonlyArray<Schema.Json> }> => {
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
		const resolved = typeof value === 'string' && /^\$\{[^}]+\}$/.test(value)
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
const rowPredicate = (policies: ReadonlyArray<PolicyDeclaration>, subject: Identity.Subject, action: string, resource: string): RowPredicate => {
	const applicable = policies.filter((policy) => PolicyEvaluation.matches(policy, subject, action, resource));
	if (applicable.some(({ effect }) => effect === 'deny')) return { allowed: false, reason: 'explicit deny', sql: 'false', parameters: [] };
	const grants = applicable.flatMap((policy) => policy.grants?.filter((grant) => grant.collection === resource && grant.action === action) ?? []);
	if (grants.length === 0) {
		const decision = decide(policies, subject, action, resource);
		return { ...decision, sql: decision.allowed ? 'true' : 'false', parameters: [] };
	}
	const compiled = grants.map((grant) => ({ grant, predicate: compileWhereOwner.compile(grant.where, subject) }));
	if (compiled.some(({ predicate }) => predicate.sql === 'true' && predicate.parameters.length === 0)) {
		const fields = compiled.flatMap(({ grant }) => grant.fields ?? []);
		const approval = compiled.find(({ grant }) => grant.approval !== undefined)?.grant.approval;
		return {
			allowed: true,
			reason: 'matching authored grant',
			sql: 'true',
			parameters: [],
			...(fields.length === 0 ? {} : { fields: [...new Set(fields)] }),
			...(approval === undefined ? {} : { approval: Schema.is(Schema.Json)(approval) ? approval : String(approval) })
		};
	}
	const parameters: Array<Schema.Json> = [];
	const sql = compiled.map(({ predicate }) => {
		const offset = parameters.length;
		parameters.push(...predicate.parameters);
		return `(${predicate.sql.replaceAll(/\$(\d+)/g, (_token, index: string) => `$${Number(index) + offset}`)})`;
	}).join(' or ');
	const fields = compiled.flatMap(({ grant }) => grant.fields ?? []);
	const approval = compiled.find(({ grant }) => grant.approval !== undefined)?.grant.approval;
	return {
		allowed: true,
		reason: 'matching authored grant',
		sql,
		parameters,
		...(fields.length === 0 ? {} : { fields: [...new Set(fields)] }),
		...(approval === undefined ? {} : { approval: Schema.is(Schema.Json)(approval) ? approval : String(approval) })
	};
};

/**
 * The role that may view this workspace as somebody else.
 *
 * Named once because two places have to agree on it and neither can derive it: `mayImpersonate`
 * checks it, and `identity.admitFounder` grants it. No policy declares it and none should — a policy
 * says what a group of people may do with the workspace's data, and "see the workspace as another
 * group" is not that. It is a property of being the administrator who owns the workspace, so the
 * founder is given it explicitly rather than it being derived from an authored policy that would
 * have to exist in every workspace for the feature to work in any of them.
 */
export const IMPERSONATOR_ROLE = 'impersonator';

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
const impersonationTeams = (policies: ReadonlyArray<PolicyDeclaration>): ReadonlyArray<ImpersonationTeam> =>
	policies.map(({ name }) => ({ id: name, name }));

/** Whether this subject may view the workspace as somebody else. Always asked of the real actor. */
const mayImpersonate = (actor: Identity.Subject): boolean => actor.roles.includes(IMPERSONATOR_ROLE);

export type Interface = Readonly<{
	readonly authorize: (subject: Identity.Subject, action: string, app: string) => Effect.Effect<void, AccessDenied>;
	readonly visibleApps: (subject: Identity.Subject) => ReadonlyArray<string>;
	readonly impersonate: (actor: Identity.Subject, target: Identity.Subject) => Effect.Effect<Identity.Subject, AccessDenied | Database.FacilityError>;
	/** The teams an administrator may view this workspace as, for the sidebar's picker. */
	readonly impersonationTeams: () => ReadonlyArray<ImpersonationTeam>;
	/** Whether this actor may impersonate at all. The picker is offered on this and nothing else. */
	readonly mayImpersonate: (actor: Identity.Subject) => boolean;
	/**
	 * The actor as a member of one team, with no audit row.
	 *
	 * This is the per-invocation seam: every command a previewing browser sends carries the choice, so
	 * writing a row here would put one audit entry per request into `bolt_audit` and bury the entry
	 * that says the preview began. `impersonateTeam` is the audited entry point and is called once.
	 */
	readonly subjectAsTeam: (actor: Identity.Subject, teamId: string) => Effect.Effect<Identity.Subject, AccessDenied>;
	/** `subjectAsTeam`, plus the `bolt_audit` row recording that this actor started the preview. */
	readonly impersonateTeam: (actor: Identity.Subject, teamId: string) => Effect.Effect<Identity.Subject, AccessDenied | Database.FacilityError>;
	readonly resolveScope: (subject: Identity.Subject) => { readonly tenantId: string; readonly userId: string; readonly roles: ReadonlyArray<string>; readonly teams: ReadonlyArray<string> };
	readonly predicate: (subject: Identity.Subject, action: string, resource: string) => RowPredicate;
	readonly mask: (subject: Identity.Subject, action: string, resource: string, value: Readonly<Record<string, Schema.Json>>) => Readonly<Record<string, Schema.Json>>;
	readonly explain: (subject: Identity.Subject, action: string, resource: string) => Decision;
}>;

/** Identifies the access service in Effect's context so dependency wiring remains explicit and type checked. */
export const Service = Context.Service<Interface>('@norbital-ai/bolt/AccessControl');

export const layer = Layer.effect(
	Service,
	Effect.gen(function* () {
		const workspace = yield* Workspace.Service;
		const database = yield* Database.Service;
		const authorize = Effect.fn('AccessControl.authorize')(function* (subject: Identity.Subject, action: string, app: string) {
			const decision = decide(workspace.definition.policies, subject, action, app);
			if (!decision.allowed) return yield* new AccessDenied({ action, resource: app, reason: decision.reason });
		});
		/**
		 * The same person, holding one policy's roles instead of their own.
		 *
		 * Identity is deliberately left alone. `userId`, `tenantId` and `email` stay the actor's, so an
		 * `Employee` preview resolves `${requestor.email}` to the administrator's *own* employee row
		 * rather than opening a colleague's. Impersonating a team asks what the workspace looks like
		 * under a policy, and answering it by borrowing a real person's identity would disclose that
		 * person's records to answer a question that never named them — that is what
		 * `impersonate(actor, target)` is for, and it is a different question with its own audit row.
		 *
		 * `roles` becomes exactly the policy's roles and nothing else, which is what makes this one
		 * narrowing rather than an overlay: `subjectHasPolicy` reads `subject.roles`, so every decision
		 * the runtime makes — `visibleApps`, `authorize`, `predicate`, `mask` — moves to the previewed
		 * policy together. There is no separate app-visibility path that could drift from the row
		 * predicate, which is the failure this seam exists to avoid: hiding navigation is not authority.
		 *
		 * `teams` is emptied rather than guessed. A policy names authority, not membership: nothing in
		 * the definition says which tenant teams an `Employee` belongs to, and inventing one would hand
		 * the preview approval eligibility it was never granted. Empty can only ever narrow.
		 *
		 * `impersonatedBy` is the actor's own id. It marks the subject as synthetic for anything
		 * downstream that keys per-user state off it, and it is the same id the audit row names.
		 */
		const subjectAsTeam = Effect.fn('AccessControl.subjectAsTeam')(function* (actor: Identity.Subject, teamId: string) {
			// Asked of the actor, whose roles came from the credential the boundary authenticated. An
			// administrator already holds every policy's roles, so assuming one can only take authority
			// away; for anybody else there is nothing to assume and the claim is refused outright rather
			// than ignored — a request to run as somebody else is a claim, not a preference.
			if (!mayImpersonate(actor)) {
				return yield* new AccessDenied({ action: 'impersonate', resource: teamId, reason: 'impersonation not permitted' });
			}
			const wanted = teamId.trim().toLocaleLowerCase();
			const matched = workspace.definition.policies.find(({ name }) => name.toLocaleLowerCase() === wanted);
			if (matched === undefined) {
				return yield* new AccessDenied({ action: 'impersonate', resource: teamId, reason: 'no policy of that name' });
			}
			return {
				...actor,
				roles: matched.roles ?? [matched.name],
				teams: [],
				impersonatedBy: actor.userId
			} satisfies Identity.Subject;
		});
		return Service.of({
			authorize,
			resolveScope: ({ tenantId, userId, roles, teams }) => ({ tenantId, userId, roles, teams }),
			predicate: (subject, action, resource) => rowPredicate(workspace.definition.policies, subject, action, resource),
			mask: (subject, action, resource, value) => {
				const predicate = rowPredicate(workspace.definition.policies, subject, action, resource);
				if (!predicate.allowed) return {};
				if (predicate.fields === undefined) return value;
				return Object.fromEntries(Object.entries(value).filter(([field]) => predicate.fields?.includes(field)));
			},
			explain: (subject, action, resource) => decide(workspace.definition.policies, subject, action, resource),
			visibleApps: (subject) => workspace.definition.apps
				.filter(({ name }) => workspace.definition.policies.some((policy) =>
					policy.grants === undefined
						? PolicyEvaluation.matches(policy, subject, 'view', name)
						: PolicyEvaluation.subjectHasPolicy(policy, subject) && (policy.apps ?? []).some((app) => app === '*' || app === name || name.startsWith(`${app}/`))
				))
				.map(({ name }) => name),
			impersonationTeams: () => impersonationTeams(workspace.definition.policies),
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
					parameters: ['impersonation_started', actor.userId, { tenantId: actor.tenantId, team: teamId, roles: [...subject.roles] }]
				});
				return subject;
			}),
			impersonate: Effect.fn('AccessControl.impersonate')(function* (actor, target) {
				if (!mayImpersonate(actor) || actor.tenantId !== target.tenantId) {
					return yield* new AccessDenied({ action: 'impersonate', resource: target.userId, reason: 'impersonation not permitted' });
				}
				yield* database.execute(EffectId.make(`impersonate:${actor.userId}:${target.userId}`), {
					_tag: 'Query',
					sql: 'insert into bolt_audit (kind, subject_id, payload) values ($1, $2, $3)',
					parameters: ['impersonation_started', actor.userId, { tenantId: actor.tenantId, targetUserId: target.userId }]
				});
				return { ...target, impersonatedBy: actor.userId };
			})
		});
	})
);

export * as AccessControl from './access-control.js';
