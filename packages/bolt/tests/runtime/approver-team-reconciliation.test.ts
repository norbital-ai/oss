import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';
import {
	EffectId,
	EnvironmentName,
	InvocationId,
	PROTOCOL_VERSION,
	ReleaseId,
	TenantId,
	type Activation,
	type DatabaseRequest,
	type DatabaseResponse,
	type FacilityBinding,
	type TaskRequest,
	type TaskResponse
} from '@norbital-ai/bolt-protocol';
import { collection, field, policy, workspace } from '../../src/authoring/workspace-schema.js';
import { buildManifest } from '../../src/manifest/manifest.js';
import { makeBundle } from '../../src/runtime/app.js';
import * as Database from '../../src/runtime/facilities/database.js';
import {
	declaredApproverTeams,
	reconcileApproverTeams
} from '../../src/runtime/identity/approver-teams.js';
import {
	makeTestDatabase,
	provisioningStatements,
	testCallContext
} from '../support/bolt-test-layer.js';

/**
 * A release names the teams its approvals route to, and activation makes them exist.
 *
 * `step.approvers` and `bolt_team.name` are the same string, bound by nothing but that. Before this,
 * a release could declare `approvers: ['Payroll Approvers']` against a workspace with no such row
 * and nothing would say so: the deploy succeeded, the surface listed the teams that happened to
 * exist, and the fault surfaced later as an approval request that no subject in the workspace was
 * eligible to decide — a record stuck ONGOING with no error anywhere naming the cause.
 *
 * The case that matters is the first one below and it is driven through the real `bundle.activate`,
 * not through the reconciler alone: a test that called the function directly would prove the SQL and
 * leave "activation actually runs it" — the entire claim — unchecked.
 */

const definition = workspace({
	name: 'approver-teams',
	version: '1',
	collections: [
		collection({ name: 'payroll_runs', fields: { label: field.string({ required: true }) } })
	],
	apps: [],
	policies: [
		policy({
			name: 'Payroll Officer',
			effect: 'allow',
			grants: [
				{
					collection: 'payroll_runs',
					action: 'update',
					approval: {
						id: 'payroll-run-approval',
						name: 'Payroll run approval',
						steps: [
							{
								id: 'sign-off',
								name: 'Sign off',
								// Declared in `+teams.ts` as holding nothing, which is what a review-only team
								// is: `approvers` is a generated union of that file's keys, so a name it does
								// not declare is a compile error rather than an approval nobody can decide.
								//
								// **No `bolt_team` row is seeded for either of them anywhere in this file.**
								// Declaring a team is a statement in the release; the row is runtime, and the
								// assertions below are what has to bring it into existence.
								approvers: ['Payroll Approvers', 'Senior Management']
							}
						]
					}
				}
			]
		}),
		// A second policy whose grant carries no approval at all, so the walk has something to step
		// over: a release where every grant named a team would pass a reconciler that ignored the
		// shape entirely.
		policy({
			name: 'Employee',
			effect: 'allow',
			grants: [{ collection: 'payroll_runs', action: 'read' }]
		})
	],
	teams: {
		'Payroll Officer': ['Payroll Officer'],
		Employee: ['Employee'],
		// Holding nothing, and that is the whole declaration: these two decide approvals and act on
		// nothing else. Before `approvers` was typed, a review-only team's only trace anywhere was a
		// string inside one policy file.
		'Payroll Approvers': [],
		'Senior Management': []
	},
	automations: [],
	integrations: [],
	prompt: 'You are the test workspace agent.',
	tools: [],
	skills: [],
	envoys: [],
	requiredFacilities: []
});

const manifest = buildManifest(definition, { artifactId: 'approver-teams' });

const activation: Activation = {
	protocolVersion: PROTOCOL_VERSION,
	id: InvocationId.make('activation-approver-teams'),
	scope: {
		tenantId: TenantId.make('tenant-1'),
		environment: EnvironmentName.make('test'),
		releaseId: ReleaseId.make('release-1')
	},
	deadlineEpochMs: Date.now() + 20_000,
	reason: 'deploy'
};

/** Activation writes schedules through the tasks facility's wake, so it has to accept one. */
const acceptingTasks: FacilityBinding<TaskRequest, TaskResponse> = {
	call: async () => ({ _tag: 'Success', value: {} })
};

/**
 * The tenant's database as it stands the moment activation begins: migrated, and with whatever team
 * rows the test seeded.
 *
 * Real SQL rather than a double, because the claim is about what a row's absence and presence mean —
 * including the folded uniqueness that keeps `payroll approvers` from becoming a second team beside
 * `Payroll Approvers`. A double would answer whatever the test author imagined.
 */
const provisionedDatabase = async (seed: ReadonlyArray<string> = []) => {
	const database = await makeTestDatabase();
	const run = async (id: string, sql: string, parameters: ReadonlyArray<unknown> = []) => {
		const result = await database.binding.call(
			{
				invocationId: activation.id,
				effectId: EffectId.make(`provision:${id}`),
				deadlineEpochMs: activation.deadlineEpochMs,
				idempotencyKey: id
			},
			{ _tag: 'Query', sql, parameters: parameters as never },
			new AbortController().signal
		);
		if (result._tag !== 'Success')
			throw new Error(`provisioning ${id} failed: ${JSON.stringify(result)}`);
	};
	for (const step of await provisioningStatements(definition)) await run(step.id, step.sql);
	for (const name of seed) {
		await run(`team:${name}`, 'insert into bolt_team ("id", "name") values ($1, $2)', [
			globalThis.crypto.randomUUID(),
			name
		]);
	}
	return database;
};

const teamRows = (database: Awaited<ReturnType<typeof makeTestDatabase>>) =>
	database.query('select "name", "parent_id"::text as "parentId" from bolt_team order by "name"');

const activate = (database: Awaited<ReturnType<typeof makeTestDatabase>>) =>
	makeBundle(definition, manifest).activate(
		activation,
		{ scope: activation.scope, tasks: acceptingTasks, database: database.binding },
		new AbortController().signal
	);

describe('activation reconciles the teams a release names as approvers', () => {
	it('creates a row for an approvers name that has none', async () => {
		const database = await provisionedDatabase();
		try {
			// Nothing exists before. Stated rather than assumed: if the harness seeded these rows, the
			// assertion below would pass against a runtime that reconciled nothing at all.
			expect(await teamRows(database)).toEqual([]);

			const result = await activate(database);
			if (result._tag !== 'Activated')
				throw new Error(`activation failed: ${JSON.stringify(result)}`);

			expect((await teamRows(database)).map((row) => row['name'])).toEqual([
				'Payroll Approvers',
				'Senior Management'
			]);
		} finally {
			await database.close();
		}
	});

	it('creates it empty and unnested, holding nothing on its own', async () => {
		const database = await provisionedDatabase();
		try {
			await activate(database);
			// Unnested: a team the release conjured is created at the root, holding nothing and sitting
			// under nobody. Descent is unconditional now, so *where* a team sits is the whole of what it
			// composes — placing one is an operator decision made in `teams.update`, and the reconciler
			// declines to make it on their behalf.
			expect(await teamRows(database)).toEqual([
				{ name: 'Payroll Approvers', parentId: null },
				{ name: 'Senior Management', parentId: null }
			]);
			// And nobody is in it — there is no defensible person to put there, and an empty team is
			// exactly what the workspace-access projection is built to keep visible.
			expect(
				await database.query(
					'select 1 from bolt_auth_user where "team_id" is not null union all select 1 from bolt_external_subjects where team_id is not null'
				)
			).toEqual([]);
		} finally {
			await database.close();
		}
	});

	it('leaves an existing team alone, including one spelled in another case', async () => {
		// The operator's spelling of one, and a case-variant of the other. Neither may be duplicated:
		// the unique index on `name` is case-sensitive, while every comparison of a team name in this
		// runtime is folded — so a reconciler leaning on `on conflict` would mint a second row here and
		// make which team an approval matched an accident of typing.
		const database = await provisionedDatabase(['Payroll Approvers', 'senior management']);
		try {
			await activate(database);
			expect((await teamRows(database)).map((row) => row['name'])).toEqual([
				'Payroll Approvers',
				'senior management'
			]);
		} finally {
			await database.close();
		}
	});

	it('is idempotent across activations, because a deploy happens more than once', async () => {
		const database = await provisionedDatabase();
		try {
			await activate(database);
			await activate(database);
			expect((await teamRows(database)).map((row) => row['name'])).toEqual([
				'Payroll Approvers',
				'Senior Management'
			]);
		} finally {
			await database.close();
		}
	});
});

describe('the names a release declares', () => {
	it('reads every approvers entry, folds duplicates, and keeps the authored spelling', () => {
		const twice = workspace({
			...definition,
			policies: [
				policy({
					name: 'One',
					effect: 'allow',
					grants: [
						{
							collection: 'payroll_runs',
							action: 'update',
							approval: {
								id: 'a',
								name: 'A',
								steps: [
									{ id: 's1', name: 'S1', approvers: ['Payroll Approvers'] },
									// The same team, typed differently, in a second step. One row is wanted, and
									// the spelling that reaches the operator should be the first authored one.
									{ id: 's2', name: 'S2', approvers: ['payroll approvers', 'Finance'] }
								]
							}
						}
					]
				})
			]
		});
		expect(declaredApproverTeams(twice)).toEqual(['Payroll Approvers', 'Finance']);
	});

	it('is empty for a release whose grants carry no approval', () => {
		const plain = workspace({
			...definition,
			policies: [
				policy({
					name: 'Employee',
					effect: 'allow',
					grants: [{ collection: 'payroll_runs', action: 'read' }]
				})
			]
		});
		expect(declaredApproverTeams(plain)).toEqual([]);
	});
});

describe('reconciliation never refuses a release', () => {
	/**
	 * A database that answers every statement with a failure — the shape a host with an unreachable
	 * tenant database actually produces.
	 *
	 * The claim is the temperament `policiesHeldByTeam` set for this same binding: the two sides move
	 * independently, so a mismatch is reported and stepped over rather than taken as a reason to fail
	 * the thing that noticed it. A reconciler that propagated this would turn "one team row could not
	 * be written" into "this release does not deploy".
	 */
	const refusingDatabase: FacilityBinding<DatabaseRequest, DatabaseResponse> = {
		call: async () => ({
			_tag: 'Failure',
			error: {
				code: 'database.unreachable',
				message: 'the tenant database is not answering',
				retryable: true,
				outcome: 'unknown'
			}
		})
	};

	it('reports and carries on when the row cannot be written', async () => {
		const created = await Effect.runPromise(
			reconcileApproverTeams(EffectId.make('reconcile-refusing'), definition).pipe(
				Effect.provide(Database.layer(refusingDatabase, testCallContext('reconcile-refusing')))
			)
		);
		// It succeeded, and it created nothing — the two halves that make this a report rather than a
		// refusal. A version that failed instead would reject the promise and never reach this line.
		expect(created).toEqual([]);
	});
});
