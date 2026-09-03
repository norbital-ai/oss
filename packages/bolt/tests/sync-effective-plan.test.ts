import { Result, Schema } from 'effect';
import { describe, expect, it } from 'vitest';
import { CollectionPredicate } from '@norbital-ai/bolt-protocol/collections';
import type { FieldDefinition, WorkspaceDefinition } from '../src/authoring/workspace-schema.js';
import {
	compileEffectiveQueryPlan,
	compileStructuredPredicate,
	resolveCompiledRelationship
} from '../src/runtime/access/effective-plan.js';
import type { RowPredicate, RowPredicateExpression } from '../src/runtime/access/predicate.js';
import { buildSchemaPlan } from '../src/runtime/schema/schema-plan.js';
import { withSystemCollections } from '../src/runtime/schema/system-collections.js';

const field = (
	type: 'string' | 'uuid' | 'number' | 'boolean' | 'instant' | 'json' | 'reference',
	extra: Omit<Partial<FieldDefinition>, 'type'> = {}
): FieldDefinition => ({ type, required: false, indexed: false, ...extra });

const definition = {
	name: 'effective-plan',
	version: '1',
	collections: [
		{
			name: 'accounts',
			history: true,
			fields: { name: field('string'), team: field('string', { indexed: true }) }
		},
		{
			name: 'projects',
			history: true,
			fields: {
				account_id: field('uuid'),
				name: field('string', { indexed: true }),
				owner_id: field('string'),
				team: field('string'),
				metadata: field('json'),
				source: field('reference', {
					reference: {
						targets: [
							{ tag: 'TASK', collection: 'tasks', storageColumn: 'source_task_id' },
							{ tag: 'NOTE', collection: 'notes', storageColumn: 'source_note_id' }
						],
						onDelete: 'restrict'
					}
				})
			}
		},
		{
			name: 'project_tags',
			history: true,
			fields: { project_id: field('uuid'), tag_id: field('uuid') }
		},
		{ name: 'tags', history: true, fields: { label: field('string') } },
		{ name: 'tasks', history: true, fields: { title: field('string') } },
		{ name: 'notes', history: true, fields: { body: field('string') } }
	],
	relations: [
		{
			name: 'account',
			source: 'projects',
			target: 'accounts',
			cardinality: 'one',
			from: { collection: 'projects', column: 'account_id' },
			to: { collection: 'accounts', column: 'id' }
		},
		{
			name: 'projects',
			source: 'accounts',
			target: 'projects',
			cardinality: 'many',
			from: { collection: 'accounts', column: 'id' },
			to: { collection: 'projects', column: 'account_id' }
		},
		{
			name: 'projectTags',
			source: 'projects',
			target: 'project_tags',
			cardinality: 'many',
			from: { collection: 'projects', column: 'id' },
			to: { collection: 'project_tags', column: 'project_id' }
		},
		{
			name: 'tag',
			source: 'project_tags',
			target: 'tags',
			cardinality: 'one',
			from: { collection: 'project_tags', column: 'tag_id' },
			to: { collection: 'tags', column: 'id' }
		}
	],
	policies: [],
	teams: {},
	apps: [],
	prompt: 'Compile effective Live Query plans for the test workspace.',
	tools: [],
	skills: [],
	automations: [],
	envoys: [],
	integrations: [],
	requiredFacilities: []
} satisfies WorkspaceDefinition;

const subject = {
	userId: 'user-1',
	tenantId: 'tenant-1',
	teamPath: ['Finance', 'Operations'],
	policies: [],
	email: 'user@example.test',
	admin: false
};

const unrestricted = (collection: string, fields?: ReadonlyArray<string>): RowPredicate => ({
	allowed: true,
	reason: 'test',
	expression: { kind: 'constant', value: true },
	actorBound: false,
	...(fields === undefined ? {} : { fields }),
	semantics: {
		dependencies: [collection],
		reversePaths: [],
		indexRequirements: [],
		routing: [],
		fields: [],
		subjectOperands: [],
		opaque: false
	}
});

const succeed = <A, E>(result: Result.Result<A, E>): A => {
	if (Result.isFailure(result)) throw result.failure;
	return result.success;
};

const render = (value: ReturnType<typeof compileStructuredPredicate>): string =>
	succeed(value)
		.sql.getSQL()
		.toQuery({
			escapeName: (name) => `"${name}"`,
			escapeParam: (index) => `$${index + 1}`,
			escapeString: (text) => `'${text.replaceAll("'", "''")}'`
		}).sql;

const conjunctKinds = (
	expression: RowPredicateExpression
): ReadonlyArray<RowPredicateExpression['kind']> =>
	expression.kind === 'and'
		? expression.expressions.flatMap((child) => conjunctKinds(child))
		: [expression.kind];

describe('sync engine effective-plan compilation', () => {
	it('resolves direct, inverse, and through chains from compiled endpoint identities', () => {
		const direct = succeed(
			compileStructuredPredicate({
				definition,
				rootCollection: 'projects',
				where: { account: { some: { name: { eq: 'Acme' } } } }
			})
		);
		expect(direct.semantics.dependencies).toEqual(['accounts', 'projects']);
		expect(direct.semantics.reversePaths).toContainEqual({
			collection: 'accounts',
			segments: [
				{
					relationship: 'projects.account',
					segment: 'projects.account:projects.account_id->accounts.id',
					fromCollection: 'accounts',
					fromField: 'id',
					toCollection: 'projects',
					toField: 'account_id'
				}
			]
		});

		const inverse = succeed(
			compileStructuredPredicate({
				definition,
				rootCollection: 'accounts',
				where: { projects: { some: { name: { eq: 'Atlas' } } } }
			})
		);
		expect(inverse.semantics.indexRequirements).toContainEqual({
			collection: 'projects',
			field: 'account_id',
			reason: 'relationship'
		});

		const through = succeed(
			compileStructuredPredicate({
				definition,
				rootCollection: 'projects',
				where: {
					projectTags: { some: { tag: { some: { label: { caseFoldEq: 'urgent' } } } } }
				}
			})
		);
		expect(through.semantics.dependencies).toEqual(['project_tags', 'projects', 'tags']);
		expect(
			through.semantics.reversePaths
				.find(({ collection }) => collection === 'tags')
				?.segments.map(({ relationship }) => relationship)
		).toEqual(['project_tags.tag', 'projects.projectTags']);
		expect(through.semantics.indexRequirements).toEqual(
			expect.arrayContaining([
				{ collection: 'project_tags', field: 'project_id', reason: 'relationship' },
				{ collection: 'project_tags', field: 'tag_id', reason: 'relationship' }
			])
		);
	});

	it('uses SQL TRUE semantics for nullable every', () => {
		const sql = render(
			compileStructuredPredicate({
				definition,
				rootCollection: 'accounts',
				where: { projects: { every: { team: { eq: null } } } }
			})
		);
		expect(sql).toContain('is not true');
		expect(sql).toContain('not (exists');
	});

	it('binds typed subject/team operands and registered case folding', () => {
		const compiled = succeed(
			compileStructuredPredicate({
				definition,
				rootCollection: 'projects',
				where: {
					owner_id: { eq: { $subject: 'id' } },
					team: { caseFoldEq: { $subject: 'team' } }
				},
				subject
			})
		);
		expect(compiled.semantics.subjectOperands).toEqual(['id', 'team']);
		const query = compiled.sql.getSQL().toQuery({
			escapeName: (name) => `"${name}"`,
			escapeParam: (index) => `$${index + 1}`,
			escapeString: (text) => `'${text}'`
		});
		expect(query.sql).toContain('lower');
		expect(query.params).toEqual(['user-1', 'Finance']);
	});

	it('compiles policy-only descendant-team user membership with derived impact facts', () => {
		const compiled = succeed(
			compileStructuredPredicate({
				definition,
				rootCollection: 'projects',
				where: { owner_id: { teamScopeUsers: true } },
				subject,
				node: 'policy.team-subtree.projects.read'
			})
		);
		expect(compiled.expression).toMatchObject({
			kind: 'team-scope-users',
			column: 'owner_id',
			subjectId: 'user-1'
		});
		expect(compiled.semantics.dependencies).toEqual(['projects', 'team', 'user']);
		expect(compiled.semantics.subjectOperands).toEqual(['id']);
		expect(compiled.semantics.indexRequirements).toEqual(
			expect.arrayContaining([
				{ collection: 'projects', field: 'owner_id', reason: 'routing' },
				{ collection: 'team', field: 'parent_id', reason: 'relationship' },
				{ collection: 'user', field: 'team_id', reason: 'relationship' }
			])
		);
		const query = compiled.sql.getSQL().toQuery({
			escapeName: (name) => `"${name}"`,
			escapeParam: (index) => `$${index + 1}`,
			escapeString: (text) => `'${text}'`
		});
		expect(query.sql).toContain('with recursive');
		expect(query.sql).toContain('"team"');
		expect(query.sql).toContain('"user"');
		expect(query.params).toEqual(['user-1']);

		const unbound = compileStructuredPredicate({
			definition,
			rootCollection: 'projects',
			where: { owner_id: { teamScopeUsers: true } },
			node: 'query.where'
		});
		expect(Result.isFailure(unbound)).toBe(true);
	});

	it('compiles typed JSON paths, JSON array membership, and reference discriminators', () => {
		const compiled = succeed(
			compileStructuredPredicate({
				definition,
				rootCollection: 'projects',
				where: {
					metadata: {
						jsonPath: { path: ['kind'], type: 'string', eq: 'invoice' },
						jsonArraySome: {
							path: ['approvers'],
							transform: 'case-fold',
							eq: 'Finance'
						}
					},
					source: { kind: { eq: 'TASK' } }
				}
			})
		);
		const kinds = conjunctKinds(compiled.expression);
		expect(kinds).toEqual(expect.arrayContaining(['json-path', 'json-array-some', 'null']));
	});

	it('derives approval membership from structured policy and compiled system segments', () => {
		const system = withSystemCollections(definition);
		const compiled = succeed(
			compileStructuredPredicate({
				definition: system,
				rootCollection: 'approval_request',
				where: { id: { approvalParty: true } },
				subject
			})
		);
		expect(compiled.semantics.dependencies).toEqual(['approval_request', 'requestor']);
		expect(compiled.semantics.reversePaths[0]?.segments[0]?.relationship).toBe(
			'approval_request.requestors'
		);
		expect(render(Result.succeed(compiled))).toContain('approver_teams');
	});

	it('includes relation-in-where dependencies without requiring the relation in with', () => {
		const plan = succeed(
			compileEffectiveQueryPlan({
				definition,
				rootCollection: 'projects',
				where: { account: { some: { name: { eq: 'Acme' } } } },
				orderBy: { name: 'asc' },
				limit: 25,
				kind: 'findMany',
				subject,
				policyFor: unrestricted
			})
		);
		expect(plan.dependencies).toEqual(expect.arrayContaining(['accounts', 'projects']));
		expect(plan.projection.children).toEqual([]);
		expect(plan.order).toEqual([
			{ field: 'name', direction: 'asc' },
			{ field: 'id', direction: 'asc' }
		]);
		expect(plan.limit).toBe(25);
	});

	it('feeds exhaustive relationship and routing requirements through the schema-plan owner', () => {
		const plan = buildSchemaPlan(definition, [
			{ collection: 'projects', field: 'owner_id', reason: 'routing' }
		]);
		const ids = new Set(plan.steps.map(({ id }) => id));
		expect(ids.has('collection:projects:live-index:account_id')).toBe(true);
		expect(ids.has('collection:project_tags:live-index:project_id')).toBe(true);
		expect(ids.has('collection:project_tags:live-index:tag_id')).toBe(true);
		expect(ids.has('collection:projects:live-index:owner_id')).toBe(true);
	});

	it('derives legacy equality routing requirements and enforces only schema-owner admission', () => {
		const deferred = succeed(
			compileEffectiveQueryPlan({
				definition,
				rootCollection: 'projects',
				where: { owner_id: { eq: 'legacy-owner' } },
				kind: 'findMany',
				subject,
				policyFor: unrestricted
			})
		);
		expect(deferred.routing).toContainEqual({ field: 'owner_id', values: ['legacy-owner'] });
		expect(deferred.indexRequirements).toContainEqual({
			collection: 'projects',
			field: 'owner_id',
			reason: 'routing'
		});

		const knownMissing = compileEffectiveQueryPlan({
			definition,
			rootCollection: 'projects',
			where: { owner_id: { eq: 'legacy-owner' } },
			kind: 'findMany',
			subject,
			policyFor: unrestricted,
			indexAdmission: { enforce: true, available: new Set() }
		});
		expect(Result.isFailure(knownMissing)).toBe(true);
		if (Result.isFailure(knownMissing)) expect(knownMissing.failure.code).toBe('missing-index');

		const installed = succeed(
			compileEffectiveQueryPlan({
				definition,
				rootCollection: 'projects',
				where: { owner_id: { eq: 'legacy-owner' } },
				kind: 'findMany',
				subject,
				policyFor: unrestricted,
				indexAdmission: {
					enforce: true,
					available: new Set(['projects.owner_id'])
				}
			})
		);
		expect(installed.indexRequirements).toEqual(deferred.indexRequirements);
	});

	it('never guesses relationship names and names the failed compiled identity', () => {
		const missing = compileStructuredPredicate({
			definition,
			rootCollection: 'accounts',
			where: { project: { some: { name: { eq: 'Atlas' } } } }
		});
		expect(Result.isFailure(missing)).toBe(true);
		if (Result.isFailure(missing)) {
			expect(missing.failure.code).toBe('unknown-relationship');
			expect(missing.failure.node).toBe('where.project');
			expect(missing.failure.relationship).toBe('accounts.project');
		}

		const unresolved = resolveCompiledRelationship(
			[
				{
					name: 'broken',
					source: 'projects',
					target: 'tags',
					cardinality: 'one'
				}
			],
			'projects',
			'broken',
			'where.broken'
		);
		expect(Result.isFailure(unresolved)).toBe(true);
		if (Result.isFailure(unresolved)) expect(unresolved.failure.code).toBe('unresolved-segment');
	});

	it('keeps aggregates one-shot and rejects unsupported live windows', () => {
		for (const kind of ['count', 'findGrouped'] as const) {
			const plan = succeed(
				compileEffectiveQueryPlan({
					definition,
					rootCollection: 'projects',
					kind,
					subject,
					policyFor: unrestricted
				})
			);
			expect(plan.mode).toBe('one-shot');
			expect(plan.dependencies).toEqual([]);
		}

		const offset = compileEffectiveQueryPlan({
			definition,
			rootCollection: 'projects',
			with: { account: { offset: 1 } },
			kind: 'findMany',
			subject,
			policyFor: unrestricted
		});
		expect(Result.isFailure(offset)).toBe(true);

		const unbounded = compileEffectiveQueryPlan({
			definition,
			rootCollection: 'projects',
			limit: 10_001,
			kind: 'findMany',
			subject,
			policyFor: unrestricted
		});
		expect(Result.isFailure(unbounded)).toBe(true);

		const opaquePolicy = (collection: string): RowPredicate => ({
			...unrestricted(collection),
			expression: { kind: 'constant', value: true },
			semantics: {
				...unrestricted(collection).semantics!,
				opaque: true
			}
		});
		const opaqueLive = compileEffectiveQueryPlan({
			definition,
			rootCollection: 'projects',
			kind: 'findMany',
			subject,
			policyFor: opaquePolicy
		});
		expect(Result.isFailure(opaqueLive)).toBe(true);
		expect(
			succeed(
				compileEffectiveQueryPlan({
					definition,
					rootCollection: 'projects',
					kind: 'count',
					subject,
					policyFor: opaquePolicy
				})
			).mode
		).toBe('one-shot');
	});

	it('tracks masked ordering fields as internal requirements without widening the projection', () => {
		const plan = succeed(
			compileEffectiveQueryPlan({
				definition,
				rootCollection: 'projects',
				orderBy: { name: 'asc' },
				kind: 'findMany',
				subject,
				policyFor: (collection) =>
					collection === 'projects' ? unrestricted(collection, ['id']) : unrestricted(collection)
			})
		);
		expect(plan.projection.fields).not.toContain('name');
		expect(plan.fields).toContainEqual({
			collection: 'projects',
			field: 'name',
			purpose: 'order'
		});
	});

	it('retains the implicit id tie-breaker in the effective projection and read mask', () => {
		const plan = succeed(
			compileEffectiveQueryPlan({
				definition,
				rootCollection: 'projects',
				orderBy: { name: 'asc' },
				kind: 'findMany',
				subject,
				policyFor: (collection) =>
					collection === 'projects' ? unrestricted(collection, ['name']) : unrestricted(collection)
			})
		);
		expect(plan.order).toEqual([
			{ field: 'name', direction: 'asc' },
			{ field: 'id', direction: 'asc' }
		]);
		expect(plan.projection.fields).toEqual(expect.arrayContaining(['name', 'id', 'row_version']));
		expect(plan.fields).toContainEqual({
			collection: 'projects',
			field: 'id',
			purpose: 'field-mask'
		});
	});

	it('carries the ordering fields a live selection omits instead of refusing it', () => {
		const plan = succeed(
			compileEffectiveQueryPlan({
				definition,
				rootCollection: 'projects',
				orderBy: { name: 'asc' },
				columns: { team: true },
				with: { account: { columns: { name: true } }, projectTags: true },
				kind: 'findMany',
				subject,
				policyFor: unrestricted
			})
		);
		expect(plan.mode).toBe('live-prefix');
		expect(plan.projection.fields).toEqual(['team', 'name', 'id']);
		expect(plan.execution.columns).toEqual({ team: true, name: true, id: true });
		expect(plan.execution.with).toEqual({
			account: { columns: { name: true, id: true } },
			projectTags: true
		});
		expect(plan.projection.children.map(({ fields }) => fields)).toEqual([
			['name', 'id'],
			expect.arrayContaining(['id', 'project_id', 'tag_id'])
		]);
		const excluded = succeed(
			compileEffectiveQueryPlan({
				definition,
				rootCollection: 'projects',
				columns: { id: false },
				kind: 'findMany',
				subject,
				policyFor: unrestricted
			})
		);
		expect(excluded.execution.columns).toBeUndefined();
		expect(excluded.projection.fields).toContain('id');
	});

	it('admits a live prefix up to the protocol key ceiling, and refuses one past it', () => {
		const admitted = succeed(
			compileEffectiveQueryPlan({
				definition,
				rootCollection: 'projects',
				limit: 10_000,
				kind: 'findMany',
				subject,
				policyFor: unrestricted
			})
		);
		expect(admitted.mode).toBe('live-prefix');
		expect(admitted.limit).toBe(10_000);
		const refused = compileEffectiveQueryPlan({
			definition,
			rootCollection: 'projects',
			limit: 10_001,
			kind: 'findMany',
			subject,
			policyFor: unrestricted
		});
		expect(Result.isFailure(refused) && refused.failure.code).toBe('unsupported-live-shape');
	});

	it('refuses a live ordering by a JSON or custom column at plan time, naming the field', () => {
		const refused = compileEffectiveQueryPlan({
			definition,
			rootCollection: 'projects',
			orderBy: { metadata: 'desc' },
			kind: 'findMany',
			subject,
			policyFor: unrestricted
		});
		expect(Result.isFailure(refused)).toBe(true);
		if (Result.isFailure(refused)) {
			expect(refused.failure.code).toBe('unsupported-live-shape');
			expect(refused.failure.node).toBe('query.orderBy.metadata');
			expect(refused.failure.message).toContain('projects.metadata is json');
		}
		const oneShot = succeed(
			compileEffectiveQueryPlan({
				definition,
				rootCollection: 'projects',
				orderBy: { metadata: 'desc' },
				after: 'cursor',
				kind: 'findMany',
				subject,
				policyFor: unrestricted
			})
		);
		expect(oneShot.mode).toBe('one-shot');
	});

	it('leaves a one-shot selection exactly as authored', () => {
		const plan = succeed(
			compileEffectiveQueryPlan({
				definition,
				rootCollection: 'projects',
				orderBy: { name: 'asc' },
				columns: { team: true },
				with: { account: { columns: { name: true } } },
				after: 'cursor',
				kind: 'findMany',
				subject,
				policyFor: unrestricted
			})
		);
		expect(plan.mode).toBe('one-shot');
		expect(plan.projection.fields).toEqual(['team']);
		expect(plan.execution.columns).toEqual({ team: true });
		expect(plan.execution.with).toEqual({ account: { columns: { name: true } } });
	});

	it('keeps the protocol predicate closed while admitting typed subject operands', () => {
		expect(Schema.is(CollectionPredicate)({ owner_id: { eq: { $subject: 'id' } } })).toBe(true);
		expect(Schema.is(CollectionPredicate)({ owner_id: { rawSql: 'true' } })).toBe(false);
	});
});
