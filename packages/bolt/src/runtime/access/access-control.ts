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

export type Interface = Readonly<{
	readonly authorize: (subject: Identity.Subject, action: string, app: string) => Effect.Effect<void, AccessDenied>;
	readonly visibleApps: (subject: Identity.Subject) => ReadonlyArray<string>;
	readonly impersonate: (actor: Identity.Subject, target: Identity.Subject) => Effect.Effect<Identity.Subject, AccessDenied | Database.FacilityError>;
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
			impersonate: Effect.fn('AccessControl.impersonate')(function* (actor, target) {
				if (!actor.roles.includes('impersonator') || actor.tenantId !== target.tenantId) {
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
