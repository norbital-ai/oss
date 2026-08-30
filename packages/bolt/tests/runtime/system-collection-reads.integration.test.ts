import { Effect } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';
import {
	EffectId,
	EnvironmentName,
	Invocation,
	InvocationId,
	PROTOCOL_VERSION,
	ReleaseId,
	TenantId
} from '@norbital-ai/bolt-protocol';
import { app, collection, field, policy, workspace } from '../../src/authoring/workspace-schema.js';
import * as AccessControl from '../../src/runtime/access/access-control.js';
import { decidePolicies } from '../../src/runtime/access/policy-compiler.js';
import { systemSubject } from '../../src/runtime/access/system-principal.js';
import * as Identity from '../../src/runtime/identity/identity.js';
import { ADMIN_STATUS } from '../../src/runtime/identity/identity.js';
import * as Approvals from '../../src/runtime/approvals/approvals.js';
import * as Collections from '../../src/runtime/collections/collections.js';
import { dispatchInvocation } from '../../src/runtime/dispatch.js';
import {
	SYSTEM_READ_POLICY,
	withSystemCollections
} from '../../src/runtime/schema/system-collections.js';
import { makeBoltTestRuntime, type BoltTestRuntime } from '../support/bolt-test-layer.js';
import { fixtureUserId, seedSession, seedTeam } from '../support/fixture-identity.js';

/**
 * What an ordinary member may read of the runtime's own collections.
 *
 * `SYSTEM_READ_POLICY` says in its comment that "reading runtime state is allowed for any
 * authenticated subject", and `withSystemCollections` merges it into every workspace so that the
 * promise does not depend on a template remembering to declare it. But a policy is selected by name
 * — `subjectHasPolicy` matches `policy.system === true` against `subject.system`, or the folded
 * `policy.name` against the set `policiesHeldByTeam` builds from `+teams.ts` — and no team in any
 * template names `bolt.system-collections`. So the grant is merged in, evaluated, and matched by
 * nobody.
 *
 * The workspace below is shaped like `templates/field-operations`: a controller team composing
 * policies that grant every action on the collections the app authors and nothing on `user`, whose
 * seeded members are ordinary people. That template's controller app runs
 * `client.db.user.findMany({ columns: { id: true, name: true } })` to label the
 * `user_id` column on its Contractors tab, which is exactly the directory read the masked grant
 * exists to serve.
 *
 * Each case pairs a member with an administrator against the same collection, because the
 * `isAdministrator` short-circuit in `decide` and `rowPredicate` is the only other thing that admits
 * these reads: a suite that only asserted the refusal would pass just as well against a runtime that
 * served nobody at all.
 */

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

const scope = {
	tenantId: TenantId.make('test-tenant'),
	environment: EnvironmentName.make('development'),
	releaseId: ReleaseId.make('local')
};

const command = (name: string, credential: string, input: unknown = null) =>
	Invocation.cases.Command.make({
		protocolVersion: PROTOCOL_VERSION,
		id: InvocationId.make(`command-${name}-${credential}-${JSON.stringify(input)}`),
		scope,
		deadlineEpochMs: Date.now() + 30_000,
		command: name,
		input: input as never,
		headers: { authorization: [`Bearer ${credential}`] }
	});

const CONTROLLER_TEAM = 'Field Operations Controllers';
const CONTRACTOR_TEAM = 'Field Operations Contractors';

/** The one fingerprint the release admits a browser mutation against. */
const MUTATION_SCHEMA_FINGERPRINT = 'sha256:system-collection-reads-fixture';

/**
 * The approval the contractor's `create` grant carries, named after the team that may decide it.
 *
 * `approvers` and `team.name` are the same string — that is the whole binding, and it is what
 * the approver leg of the read predicate resolves through. Written here rather than in a fixture
 * helper because the *name* is what both halves of every assertion below turn on.
 */
const jobApproval = {
	id: '019f6f10-0001-7000-8000-000000000003',
	steps: [
		{
			id: '019f6f10-0001-7000-8000-000000000103',
			approvers: [CONTROLLER_TEAM]
		}
	],
	superceded_by: []
};

/** The template's own shape: authored grants on authored collections, and nothing else. */
const fieldOpsWorkspace = workspace({
	name: 'test-workspace',
	version: '1',
	collections: [
		collection({
			name: 'jobs',
			fields: { title: field.string({ required: true }), user_id: field.string() }
		})
	],
	apps: [
		app({ name: 'field_ops_controller', label: 'Field Operations Controller' }),
		app({ name: 'field_ops_contractor', label: 'Field Operations Contractor' })
	],
	policies: [
		/**
		 * The one owner of `jobs read`, which both teams reach by composing it.
		 *
		 * A coordinate has exactly one grant across every reachable policy, so the read both roles
		 * need cannot be restated in each of their policies. Composition is how a template gives two
		 * roles the same view, and it is the shape the refusal message prescribes.
		 */
		policy({
			name: 'field_ops_jobs',
			effect: 'allow',
			grants: [{ collection: 'jobs', action: 'read' }]
		}),
		policy({
			name: 'field_ops_controller',
			effect: 'allow',
			capabilities: { apps: ['field_ops_controller'] },
			grants: [
				{ collection: 'jobs', action: 'update' },
				{ collection: 'jobs', action: 'delete' }
			]
		}),
		/**
		 * The party who raises an approval, and the reason there is a second policy here at all.
		 *
		 * `Approvals.gate` embeds the configuration carried by a grant *this subject's team holds*
		 * into the durable state, so an approval only ever names approvers because the requestor's own
		 * policy said so. A fixture that raised one as the controller would prove nothing about the
		 * two-sided rule — which is also why `jobs create` is owned here and not by the controller:
		 * the gated create belongs to the party, and the controller is the side that decides it.
		 */
		policy({
			name: 'field_ops_contractor',
			effect: 'allow',
			capabilities: { apps: ['field_ops_contractor'] },
			grants: [{ collection: 'jobs', action: 'create', approval: jobApproval }]
		})
	],
	teams: {
		[CONTROLLER_TEAM]: ['field_ops_jobs', 'field_ops_controller'],
		[CONTRACTOR_TEAM]: ['field_ops_jobs', 'field_ops_contractor']
	},
	automations: [],
	integrations: [],
	prompt: 'You are the test workspace agent.',
	tools: [],
	skills: [],
	envoys: [],
	requiredFacilities: [],
	schemaFingerprint: MUTATION_SCHEMA_FINGERPRINT
});

/** A seeded non-admin in the controller team — `foo_suan_wood@bca.gov.sg`'s standing in the seed. */
const seedController = async (runtime: BoltTestRuntime) => {
	await seedTeam(runtime, CONTROLLER_TEAM);
	await seedSession(runtime, {
		token: 'controller-token',
		user: 'user-controller',
		team: CONTROLLER_TEAM
	});
};

/** The party: a contractor who raises approvals and decides none of them. */
const seedContractor = async (runtime: BoltTestRuntime) => {
	await seedTeam(runtime, CONTRACTOR_TEAM);
	await seedSession(runtime, {
		token: 'contractor-token',
		user: 'user-contractor',
		team: CONTRACTOR_TEAM
	});
};

/**
 * A second contractor: a member of a team that raises approvals, who raised *this* one.
 *
 * Deliberately in the same team as the party rather than in none. A bystander with no team at all
 * would be refused by the team join returning null, which is a weaker fact than what is being
 * asserted — that holding the identical policy, in the identical team, does not let you read
 * somebody else's request.
 */
const seedBystander = async (runtime: BoltTestRuntime) => {
	await seedTeam(runtime, CONTRACTOR_TEAM);
	await seedSession(runtime, {
		token: 'bystander-token',
		user: 'user-bystander',
		team: CONTRACTOR_TEAM
	});
};

/** The subject the approval gate runs as, matching the session `contractor-token` resolves to. */
const contractorSubject: Identity.Subject = {
	userId: fixtureUserId('user-contractor'),
	tenantId: 'test-tenant',
	teamPath: [CONTRACTOR_TEAM],
	policies: []
};

const APPROVAL_EFFECT_ID = EffectId.make('approval-system-collection-read');
const APPROVAL_ROOT = {
	collection: 'jobs',
	id: '019f6f10-0003-7000-8000-000000000001',
	action: 'create'
} as const;
const REQUEST_ID = Approvals.approvalRequestId(APPROVAL_ROOT, APPROVAL_EFFECT_ID);

/**
 * One approval, raised the only way approvals are ever raised.
 *
 * The approval gate is the sole owner of all three rows this suite reads — the `bolt_approvals`
 * state that carries the approver names, the `approval_request` projection, and the `requestor` row
 * that is the only record of who raised it. Seeding them by hand would let the fixture describe a
 * shape the runtime does not actually write, which is exactly the failure this predicate had to be
 * rewritten to avoid: `approval_request.steps` looks like it holds approvers and holds `[{step: n}]`.
 */
const raiseApproval = (harness: BoltTestRuntime) =>
	harness.runtime.runPromise(
		Effect.gen(function* () {
			return yield* (yield* Approvals.Service).gate({
				effectId: APPROVAL_EFFECT_ID,
				subject: contractorSubject,
				root: APPROVAL_ROOT,
				storedGraph: { version: 1, ...APPROVAL_ROOT },
				proposedValues: { title: 'Extra scaffolding' },
				approval: jobApproval,
				review: undefined
			});
		})
	);

/** The `id`s a subject actually gets back, which is where a narrowing shows and a grant does not. */
const readIds = async (
	harness: BoltTestRuntime,
	credential: string,
	collectionName: string,
	key = 'id'
): Promise<ReadonlyArray<unknown>> => {
	const outcome = await readAs(harness, credential, collectionName);
	if (outcome._tag !== 'Success')
		throw new Error(
			`expected ${collectionName} to be served to ${credential}, got ${JSON.stringify(outcome)}`
		);
	const rows = outcome.success.value;
	if (!Array.isArray(rows)) throw new Error(`expected rows from ${collectionName}`);
	return (rows as ReadonlyArray<Record<string, unknown>>).map((row) => row[key]);
};

const seedAdministrator = async (runtime: BoltTestRuntime) => {
	await seedSession(runtime, {
		token: 'admin-token',
		user: 'user-admin',
		status: ADMIN_STATUS
	});
};

const readAs = (runtime: BoltTestRuntime, credential: string, collectionName: string) =>
	runtime.runtime.runPromise(
		dispatchInvocation(
			command('collections.export', credential, { collection: collectionName, limit: 10 })
		).pipe(Effect.result)
	);

/**
 * The coordinates a browser binds a durable mutation to.
 *
 * The wire is two commands now, `sync.connect` and `sync.advance`, and neither issues either of
 * these: the fingerprint is the release's own schema fact, declared by the fixture workspace above,
 * and the partition key is a client-chosen coordinate the journal folds into the
 * request digest rather than a server-issued handle it resolves.
 */
const MUTATION_PARTITION_KEY = 'sha256:system-collection-reads-partition';

/** The runtime's own collections that `SYSTEM_READ_POLICY` grants `read` on. */
const RUNTIME_OWNED = [
	'approval_request',
	'requestor',
	'user',
	'team',
	'chat_session',
	'chat_message',
	'automation_run',
	'bolt_notifications'
];

/**
 * Reaching a collection and reading its rows are two different questions, and this suite asks both.
 *
 * `decide` answers the first — the grant names the collection, so the read is not refused — and
 * `rowPredicate` answers the second, which for `approval_request` and `requestor` is now a
 * narrowing rather than `true`. A member with no approval of their own therefore gets `Success` and
 * an empty page, and the cases in the second `describe` below are what pin the difference: a suite
 * that only checked the `_tag` would pass just as well against a policy that served everything.
 */
describe('reading runtime-owned collections as an ordinary member', () => {
	it('serves every runtime-owned collection to a member holding only an authored policy', async () => {
		harness = await makeBoltTestRuntime(fieldOpsWorkspace);
		await seedController(harness);

		for (const name of RUNTIME_OWNED) {
			const outcome = await readAs(harness, 'controller-token', name);
			if (outcome._tag === 'Failure' && outcome.failure instanceof AccessControl.AccessDenied)
				throw new Error(
					`${name} was refused to a member: ${outcome.failure.reason} (${outcome.failure.action} on ${outcome.failure.resource})`
				);
			expect(outcome._tag).toBe('Success');
			// The supported export path uses the same authorized collection read and answers rows directly.
			if (outcome._tag === 'Success') {
				expect(Array.isArray(outcome.success.value)).toBe(true);
			}
		}
	});

	/**
	 * The control. An administrator is selected by the same explicit built-in read policy as any
	 * other authenticated user. Status does not bypass that policy or its row predicates.
	 */
	it('serves the explicitly granted system collections to an administrator', async () => {
		harness = await makeBoltTestRuntime(fieldOpsWorkspace);
		await seedAdministrator(harness);

		for (const name of RUNTIME_OWNED) {
			const outcome = await readAs(harness, 'admin-token', name);
			expect(outcome._tag).toBe('Success');
		}
	});

	/** The authored half, unchanged: what the member's own policy grants still reaches them. */
	it('still serves the collection the member is authored a grant on', async () => {
		harness = await makeBoltTestRuntime(fieldOpsWorkspace);
		await seedController(harness);

		const outcome = await readAs(harness, 'controller-token', 'jobs');
		expect(outcome._tag).toBe('Success');
	});

	/**
	 * The mask is the other half of the directory grant, and it has to survive whatever admits the
	 * read: `user` holds an address, and the grant allows `id` and `name` only. `row_version` is the
	 * one framework field retained so a locally read row can carry its whole-row mutation fence.
	 */
	it.each(['user', 'team'])(
		'masks the %s directory down to id and name for a member',
		async (collectionName) => {
			harness = await makeBoltTestRuntime(fieldOpsWorkspace);
			await seedController(harness);

			const outcome = await readAs(harness, 'controller-token', collectionName);
			if (outcome._tag !== 'Success')
				throw new Error(`expected the directory read to be served, got ${JSON.stringify(outcome)}`);
			const rows = outcome.success.value;
			expect(Array.isArray(rows)).toBe(true);
			expect((rows as ReadonlyArray<object>).length).toBeGreaterThan(0);
			for (const row of rows as ReadonlyArray<Record<string, unknown>>) {
				expect(Object.keys(row).toSorted()).toEqual(['id', 'name', 'row_version']);
			}
		}
	);

	/**
	 * The host principal is not "an authenticated subject", and the flag that fixes the case above is
	 * the obvious way to widen it by accident.
	 *
	 * `COLONY_SYSTEM_POLICY` enumerates two `manage` grants and no read at all, so a system principal
	 * can migrate a workspace and admit its founder and cannot open a record in it. `user`
	 * and `requestor` are exactly the collections it would gain if `authenticated` had been written
	 * as an unconditional `true`, so they are what this pins.
	 */
	it('does not extend the built-in read grant to the host principal', () => {
		const policies = withSystemCollections(fieldOpsWorkspace).policies;
		const host = systemSubject('test-tenant');
		for (const name of RUNTIME_OWNED) {
			expect(decidePolicies(policies, host, 'read', name, new Set())).toEqual({
				allowed: false,
				reason: 'no matching allow policy'
			});
		}
		// And what it is granted is untouched, or the assertion above would pass against a principal
		// that had lost its authority rather than kept its limits.
		expect(decidePolicies(policies, host, 'manage', 'schema', new Set())).toEqual({
			allowed: true,
			reason: 'explicit allow'
		});
	});
});

describe('notifications are live system collections scoped to their recipient', () => {
	it('reads only the subject notifications and permits only their read flag to change', async () => {
		harness = await makeBoltTestRuntime(fieldOpsWorkspace);
		await seedController(harness);
		await seedBystander(harness);
		const ownId = '00000000-0000-5000-8000-000000000001';
		const otherId = '00000000-0000-5000-8000-000000000002';
		await harness.database.query(
			'insert into bolt_notifications (id, recipient, payload, read) values ($1, $2, $3::jsonb, false), ($4, $5, $6::jsonb, false)',
			[
				ownId,
				fixtureUserId('user-controller'),
				JSON.stringify({ text: 'Mine' }),
				otherId,
				fixtureUserId('user-bystander'),
				JSON.stringify({ text: 'Theirs' })
			]
		);

		expect(await readIds(harness, 'controller-token', 'bolt_notifications')).toEqual([ownId]);
		const updateNotification = (
			idempotencyKey: string,
			id: string,
			baseVersion: number,
			values: Readonly<Record<string, unknown>>
		) => ({
			protocolVersion: 2,
			idempotencyKey,
			issuedAtEpochMs: Date.now(),
			partitionKey: MUTATION_PARTITION_KEY,
			schemaFingerprint: MUTATION_SCHEMA_FINGERPRINT,
			graph: { action: 'update', collection: 'bolt_notifications', values: { id, ...values } },
			baseVersions: [
				{ row: { collection: 'bolt_notifications', recordId: id }, rowVersion: baseVersion }
			]
		});

		const markOwn = await harness.runtime.runPromise(
			dispatchInvocation(
				command(
					'collections.mutate',
					'controller-token',
					updateNotification('mark-own-notification-read', ownId, 1, { read: true })
				)
			).pipe(Effect.result)
		);
		expect(markOwn, JSON.stringify(markOwn)).toMatchObject({
			_tag: 'Success',
			success: { value: { resolution: 'accepted', mutationId: 'mark-own-notification-read' } }
		});

		const markOther = await harness.runtime.runPromise(
			dispatchInvocation(
				command(
					'collections.mutate',
					'controller-token',
					updateNotification('mark-other-notification-read', otherId, 1, { read: true })
				)
			).pipe(Effect.result)
		);
		expect(markOther).toMatchObject({
			_tag: 'Success',
			success: { value: { resolution: 'rejected', mutationId: 'mark-other-notification-read' } }
		});
		const refusedField = await harness.runtime.runPromise(
			dispatchInvocation(
				command(
					'collections.mutate',
					'controller-token',
					updateNotification('rewrite-own-notification-payload', ownId, 2, {
						payload: { text: 'Rewritten' }
					})
				)
			).pipe(Effect.result)
		);
		expect(refusedField).toMatchObject({
			_tag: 'Success',
			success: { value: { resolution: 'rejected', mutationId: 'rewrite-own-notification-payload' } }
		});

		expect(
			await harness.database.query('select id, payload, read from bolt_notifications order by id')
		).toEqual([
			{ id: ownId, payload: { text: 'Mine' }, read: true },
			{ id: otherId, payload: { text: 'Theirs' }, read: false }
		]);
	});
});

/**
 * Who may read an approval, and the shape of the answer.
 *
 * An approval request is readable by the parties to it and by whoever may decide it, and by nobody
 * else — the `requestor` join table answers the first, and the approver teams named in the durable
 * configuration answer the second. `requestor` follows the request it belongs to, or the membership
 * of every approval in the workspace would be one signed-in session away from anybody.
 *
 * **Where the approver names actually live.** Not in `approval_request.steps`, whatever the column
 * name suggests: `Approvals.projectRequest` writes `[{ step: <n> }]` there while a request is
 * pending and `[]` once it closes. The names are in `bolt_approvals.state.operation.approval.steps`,
 * embedded at request time from the requestor's own grant, which is the same value
 * `Approvals.decide` resolves before it decides eligibility. `an approver reads exactly what they
 * may decide` below is the case that would have failed against a `steps`-based predicate — it would
 * have matched nothing and silently withheld from approvers the requests they exist to act on.
 */
describe('approval requests are scoped to their parties and approvers', () => {
	it('shows a request to the party who raised it', async () => {
		harness = await makeBoltTestRuntime(fieldOpsWorkspace);
		await seedContractor(harness);
		await raiseApproval(harness);

		expect(await readIds(harness, 'contractor-token', 'approval_request')).toEqual([REQUEST_ID]);
	});

	/**
	 * The case that only passes under a genuine narrowing.
	 *
	 * The bystander holds the identical policy and sits in the identical team as the party, and the
	 * row exists — the case above reads it. So this cannot pass by the predicate collapsing to
	 * `true`, by the collection being refused outright, or by there being nothing to find.
	 */
	it('hides it from a member who is neither a party nor an approver', async () => {
		harness = await makeBoltTestRuntime(fieldOpsWorkspace);
		await seedContractor(harness);
		await seedBystander(harness);
		await raiseApproval(harness);

		expect(await readIds(harness, 'contractor-token', 'approval_request')).toEqual([REQUEST_ID]);
		expect(await readIds(harness, 'bystander-token', 'approval_request')).toEqual([]);
	});

	it('shows it to a member of the team named among its approvers', async () => {
		harness = await makeBoltTestRuntime(fieldOpsWorkspace);
		await seedContractor(harness);
		await seedController(harness);
		await raiseApproval(harness);

		expect(await readIds(harness, 'controller-token', 'approval_request')).toEqual([REQUEST_ID]);
	});

	it('uses an impersonated subject team instead of the actor persisted on the user row', async () => {
		harness = await makeBoltTestRuntime(fieldOpsWorkspace);
		await seedContractor(harness);
		await seedBystander(harness);
		await raiseApproval(harness);
		const actorId = fixtureUserId('user-bystander');
		const preview: Identity.Subject = {
			userId: actorId,
			tenantId: 'test-tenant',
			teamPath: [CONTROLLER_TEAM],
			policies: [],
			impersonatedBy: actorId
		};
		const rows = await harness.runtime.runPromise(
			Effect.gen(function* () {
				return yield* (yield* Collections.Service).findMany(
					EffectId.make('approval-preview-team'),
					preview,
					{ collection: 'approval_request', limit: 10 }
				);
			})
		);
		expect(rows.map((row) => Reflect.get(row as object, 'id'))).toEqual([REQUEST_ID]);
	});

	/**
	 * An approver reads exactly what they may decide, and a request routed past them is not it.
	 *
	 * The second request carries a different concrete route. Approval requests without a flow are
	 * invalid now, so the negative control is another valid request whose active step names nobody
	 * on the controller's team.
	 */
	it('does not show an approver a request their team is not named on', async () => {
		harness = await makeBoltTestRuntime(fieldOpsWorkspace);
		await seedContractor(harness);
		await seedController(harness);
		await raiseApproval(harness);
		const unroutedEffectId = EffectId.make('approval-unrouted');
		const unroutedRoot = {
			collection: 'people',
			id: '019f6f10-0003-7000-8000-000000000002',
			action: 'create'
		} as const;
		const unroutedRequestId = Approvals.approvalRequestId(unroutedRoot, unroutedEffectId);
		await harness.runtime.runPromise(
			Effect.gen(function* () {
				return yield* (yield* Approvals.Service).gate({
					effectId: unroutedEffectId,
					subject: contractorSubject,
					root: unroutedRoot,
					storedGraph: { version: 1, ...unroutedRoot },
					approval: {
						id: 'people:create',
						steps: [{ id: 'people:create:stage:1', approvers: ['Other Reviewers'] }],
						superceded_by: []
					},
					review: undefined
				});
			})
		);

		expect(await readIds(harness, 'controller-token', 'approval_request')).toEqual([REQUEST_ID]);
		expect((await readIds(harness, 'contractor-token', 'approval_request')).toSorted()).toEqual(
			[REQUEST_ID, unroutedRequestId].toSorted()
		);
	});

	/** The join table follows the request, for both readings of "may read it". */
	it('scopes the requestor join table by the same rule', async () => {
		harness = await makeBoltTestRuntime(fieldOpsWorkspace);
		await seedContractor(harness);
		await seedController(harness);
		await seedBystander(harness);
		await raiseApproval(harness);

		expect(await readIds(harness, 'contractor-token', 'requestor', 'approval_request_id')).toEqual([
			REQUEST_ID
		]);
		expect(await readIds(harness, 'controller-token', 'requestor', 'approval_request_id')).toEqual([
			REQUEST_ID
		]);
		expect(await readIds(harness, 'bystander-token', 'requestor', 'approval_request_id')).toEqual(
			[]
		);
	});

	/** Administrators can discover every request they may supersede, without tenant-data grants. */
	it('shows requests and their requestors to an administrator', async () => {
		harness = await makeBoltTestRuntime(fieldOpsWorkspace);
		await seedContractor(harness);
		await seedAdministrator(harness);
		await raiseApproval(harness);

		expect(await readIds(harness, 'admin-token', 'approval_request')).toEqual([REQUEST_ID]);
		expect(await readIds(harness, 'admin-token', 'requestor', 'approval_request_id')).toEqual([
			REQUEST_ID
		]);
	});

	/**
	 * The structural guard, against the one failure mode that inverts a narrowing into a widening.
	 *
	 * `rowPredicate` **unions** the `where` of every matching grant, and a grant with no `where`
	 * compiles to `true` — which short-circuits the union and serves the whole collection. So a
	 * second grant added beside these two would not add a case, it would delete the rule. The
	 * compiled predicate is checked as well as the declaration so a malformed persisted predicate
	 * cannot survive the manifest round-trip as an unconditional grant.
	 */
	it('leaves no unconditional grant beside the narrowed ones', async () => {
		harness = await makeBoltTestRuntime(fieldOpsWorkspace);
		await seedContractor(harness);

		for (const name of ['approval_request', 'requestor']) {
			const grants = (SYSTEM_READ_POLICY.grants ?? []).filter(
				(grant) => grant.collection === name && grant.action === 'read'
			);
			expect(grants).toHaveLength(1);
			expect(grants[0]?.where).toMatchObject({ kind: 'policy-sql' });
			expect(typeof Reflect.get(grants[0]?.where ?? {}, 'statement')).toBe('string');

			const compiled = await harness.runtime.runPromise(
				Effect.gen(function* () {
					return (yield* AccessControl.Service).predicate(contractorSubject, 'read', name);
				})
			);
			expect(compiled.allowed).toBe(true);
			const statement = AccessControl.predicateStatement(compiled);
			expect(statement.sql).not.toBe('true');
			expect(statement.sql).toContain('::jsonb');
			expect(statement.parameters).toContain(contractorSubject.userId);
			expect(statement.parameters).toContain(CONTRACTOR_TEAM);
			expect(statement.parameters).toContain(JSON.stringify([CONTRACTOR_TEAM.toLocaleLowerCase()]));
		}
	});
});
