import { Schema } from 'effect';
import type {
	FieldDefinition,
	PolicyDeclaration,
	WorkspaceDefinition
} from '#lib/authoring/workspace-schema.js';
import { isPolicySqlPredicate } from '#lib/authoring/policy-sql.js';
import { physicalColumnNames } from '#lib/compiler/relational-schema.js';
import type * as Identity from '#lib/runtime/identity/identity.js';
import {
	comparisonSql,
	type RowPredicate,
	type RowPredicateExpression,
	type RowPredicateSqlPart
} from './predicate.js';

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

/** Resolves the explicit requestor-token vocabulary without arbitrary property traversal. */
const subjectValue = (subject: Identity.Subject, path: string): Schema.Json | undefined => {
	if (path === 'requestor.id' || path === 'requestor.userId') return subject.userId;
	if (path === 'requestor.tenantId') return subject.tenantId;
	if (path === 'requestor.email') return subject.email;
	if (path === 'requestor.team') return subject.teamPath[0];
	if (path === 'requestor.admin') return subject.admin === true;
	return undefined;
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

const SCOPE_FRAGMENTS: Readonly<Record<string, string>> = {
	'requestor.team_scope_users': `(
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

const resolveOperand = (value: unknown, subject: Identity.Subject): unknown => {
	if (typeof value === 'string') {
		const token = /^\$\{([^}]+)\}$/.exec(value);
		return token === null ? value : subjectValue(subject, token[1] ?? '');
	}
	if (Array.isArray(value)) return value.map((entry) => resolveOperand(entry, subject));
	if (value === null || typeof value !== 'object') return value;
	return Object.fromEntries(
		Object.entries(value).map(([key, entry]) => [key, resolveOperand(entry, subject)])
	);
};

const isActorBoundWhere = (value: unknown): boolean => {
	if (typeof value === 'string')
		return /\$\{requestor\.(?:id|userId|email|team_scope_users)\}/u.test(value);
	if (Array.isArray(value)) return value.some(isActorBoundWhere);
	if (value === null || typeof value !== 'object') return false;
	return Object.values(value).some(isActorBoundWhere);
};

const grantScopeColumns = (where: unknown, named: Set<string>): void => {
	if (where === null || typeof where !== 'object' || Array.isArray(where)) return;
	if (isPolicySqlPredicate(where)) return;
	for (const [key, condition] of Object.entries(where)) {
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

type GrantScopeProblem = Readonly<{
	readonly policy: string;
	readonly collection: string;
	readonly action: string;
	readonly column: string;
	readonly message: string;
}>;

/** Reports authored row scopes whose bare column references could bind to an outer relation. */
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
						`(A \`policySql\` predicate is not checked here: it brings its own tables, so it must qualify every column it names.)`
				});
			}
		}
	}
	return problems;
};

/** Compiles trusted authored row scope while binding every identity value separately. */
const compileWhere = (
	where: NonNullable<PolicyDeclaration['grants']>[number]['where'],
	subject: Identity.Subject,
	fields: Readonly<Record<string, FieldDefinition>>
): RowPredicateExpression => {
	if (where === undefined) return { kind: 'constant', value: true };
	const bind = (operand: unknown): Schema.Json | undefined => {
		const resolved = resolveOperand(operand, subject);
		return isJson(resolved) ? resolved : undefined;
	};
	const trustedSql = (statement: string): RowPredicateExpression => {
		const parts: Array<RowPredicateSqlPart> = [];
		let offset = 0;
		for (const match of statement.matchAll(/\$\{([^}]+)\}/g)) {
			parts.push({ kind: 'text', value: statement.slice(offset, match.index) });
			const path = match[1] ?? '';
			const fragment = SCOPE_FRAGMENTS[path];
			if (fragment !== undefined) {
				const id = subjectValue(subject, 'requestor.id');
				if (id === undefined) {
					parts.push({ kind: 'text', value: '(select null where false)' });
				} else {
					const [before = '', after = ''] = fragment.split('$SUBJECT');
					parts.push(
						{ kind: 'text', value: before },
						{ kind: 'value', value: id },
						{ kind: 'text', value: after }
					);
				}
			} else {
				const value = subjectValue(subject, path);
				parts.push(
					value === undefined ? { kind: 'text', value: 'null' } : { kind: 'value', value }
				);
			}
			offset = match.index + match[0].length;
		}
		parts.push({ kind: 'text', value: statement.slice(offset) });
		return { kind: 'trusted-sql', parts };
	};
	if (isPolicySqlPredicate(where)) return trustedSql(where.statement);
	const join = (
		clauses: ReadonlyArray<RowPredicateExpression>,
		operator: 'and' | 'or',
		empty: boolean
	): RowPredicateExpression => {
		if (clauses.length === 0) return { kind: 'constant', value: empty };
		if (clauses.length === 1) return clauses[0] ?? { kind: 'constant', value: empty };
		return { kind: operator, expressions: clauses };
	};
	const compileOperator = (
		field: string,
		operator: string,
		operand: unknown
	): RowPredicateExpression => {
		if (Object.hasOwn(comparisonSql, operator)) {
			const value = bind(operand);
			return value === undefined
				? { kind: 'constant', value: false }
				: {
						kind: 'comparison',
						column: field,
						operator: operator as keyof typeof comparisonSql,
						value,
						...(fields[field]?.type === 'json' ? { encoding: 'jsonb' as const } : {})
					};
		}
		if (operator === 'in' || operator === 'notIn') {
			if (!Array.isArray(operand)) return { kind: 'constant', value: false };
			const values = operand.map(bind);
			return values.some((value) => value === undefined)
				? { kind: 'constant', value: false }
				: {
						kind: 'membership',
						column: field,
						negated: operator === 'notIn',
						values: values as ReadonlyArray<Schema.Json>,
						...(fields[field]?.type === 'json' ? { encoding: 'jsonb' as const } : {})
					};
		}
		if (operator === 'isNull' || operator === 'isNotNull') {
			if (typeof operand !== 'boolean') return { kind: 'constant', value: false };
			const wantsNull = operator === 'isNull' ? operand : !operand;
			return { kind: 'null', column: field, negated: !wantsNull };
		}
		if (operator === 'contains_date') {
			const value = bind(operand);
			return value === undefined
				? { kind: 'constant', value: false }
				: { kind: 'contains-date', column: field, value };
		}
		if (operator === 'overlaps') {
			if (operand === null || typeof operand !== 'object' || Array.isArray(operand))
				return { kind: 'constant', value: false };
			const start = bind(Reflect.get(operand, 'start'));
			const end = bind(Reflect.get(operand, 'end'));
			return start === undefined || end === undefined
				? { kind: 'constant', value: false }
				: { kind: 'overlaps', column: field, start, end };
		}
		return { kind: 'constant', value: false };
	};
	const compileField = (field: string, condition: unknown): RowPredicateExpression => {
		if (condition === null || typeof condition !== 'object' || Array.isArray(condition))
			return compileOperator(field, 'eq', condition);
		return join(
			Object.entries(condition).map(([operator, operand]) =>
				compileOperator(field, operator, operand)
			),
			'and',
			true
		);
	};
	const compileObject = (input: unknown): RowPredicateExpression => {
		if (input === null || typeof input !== 'object' || Array.isArray(input))
			return { kind: 'constant', value: false };
		const clauses: Array<RowPredicateExpression> = [];
		for (const [field, condition] of Object.entries(input)) {
			if (field === 'AND' || field === 'OR') {
				if (!Array.isArray(condition)) {
					clauses.push({ kind: 'constant', value: false });
					continue;
				}
				clauses.push(
					join(condition.map(compileObject), field === 'AND' ? 'and' : 'or', field === 'AND')
				);
				continue;
			}
			if (field === 'NOT') {
				clauses.push({ kind: 'not', expression: compileObject(condition) });
				continue;
			}
			clauses.push(compileField(field, condition));
		}
		return join(clauses, 'and', true);
	};
	return compileObject(where);
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
			actorBound: false
		};
	if (grants.length === 0) {
		const decision = decidePolicies(policies, subject, action, resource, held);
		return {
			...decision,
			expression: { kind: 'constant', value: decision.allowed },
			actorBound: false
		};
	}
	if (grants.length > 1)
		return {
			allowed: false,
			reason: `overlapping grants for ${action} ${resource}`,
			expression: { kind: 'constant', value: false },
			actorBound: false
		};
	const fields =
		definition.collections.find((collection) => collection.name === resource)?.fields ?? {};
	const compiled = grants.map((grant) => ({
		grant,
		predicate: compileWhere(grant.where, subject, fields),
		actorBound: isActorBoundWhere(grant.where)
	}));
	if (
		action !== 'read' &&
		compiled.some(({ predicate }) => predicate.kind === 'constant' && predicate.value)
	) {
		return grantResult(compiled, { kind: 'constant', value: true });
	}
	const branches = compiled.map(({ predicate }) => predicate);
	if (action === 'read') branches.push(approvalReadExpression(resource, subject));
	return grantResult(
		compiled,
		branches.length === 1 ? branches[0]! : { kind: 'or', expressions: branches }
	);
};

type CompiledGrant = Readonly<{
	readonly grant: NonNullable<PolicyDeclaration['grants']>[number];
	readonly predicate: RowPredicateExpression;
	readonly actorBound: boolean;
}>;

const grantResult = (
	compiled: ReadonlyArray<CompiledGrant>,
	expression: RowPredicateExpression
): RowPredicate => {
	const fields = compiled.flatMap(({ grant }) => grant.fields ?? []);
	const authorization = compiled[0]?.grant.authorization;
	const approval = compiled.find(({ grant }) => grant.approval !== undefined)?.grant.approval;
	return {
		allowed: true,
		reason: 'matching authored grant',
		expression,
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
