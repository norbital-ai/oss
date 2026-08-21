import { Effect } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';
import {
	EnvironmentName,
	InvocationId,
	Invocation,
	PROTOCOL_VERSION,
	ReleaseId,
	TenantId
} from '@norbital-ai/bolt-protocol';
import { collection, field, policy, workspace } from '../../src/authoring/workspace-schema.js';
import { AccessControl } from '../../src/runtime/access/access-control.js';
import { dispatchInvocation } from '../../src/runtime/dispatch.js';
import { makeBoltTestRuntime, recordId, type BoltTestRuntime } from '../support/bolt-test-layer.js';
import { seedSession } from '../support/fixture-identity.js';

/**
 * What the Data Browser runs as, and where that answer is allowed to come from.
 *
 * `data-browser` is the one plugin surface Bolt implements, so it is the one `Plugin` invocation that
 * does not fall through to the command switch — and it was reading tenant rows on the strength of a
 * `trustedContext` nobody had authenticated. In Colony the context arrives on gateway-HMAC-verified
 * headers and is genuinely trusted; over `POST /_bolt/plugin/data-browser/query` `bolt-server` rebuilds
 * it out of the request body, which is the part an attacker writes. Bolt cannot tell those two apart
 * from the invocation, so it stopped trying: the credential is the proof, and `trustedContext` may
 * only narrow what that credential already permits.
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

const query = (trustedContext: unknown, credential?: string) =>
	Invocation.cases.Plugin.make({
		protocolVersion: PROTOCOL_VERSION,
		id: InvocationId.make(`plugin-query-${credential ?? 'anonymous'}`),
		scope,
		deadlineEpochMs: Date.now() + 30_000,
		plugin: 'data-browser',
		command: 'query',
		input: { collection: 'people', input: { limit: 20 } },
		headers: credential === undefined ? {} : { authorization: [`Bearer ${credential}`] },
		trustedContext: trustedContext as never
	});

const outcomeOf = (runtime: BoltTestRuntime, invocation: Invocation) =>
	runtime.runtime.runPromise(dispatchInvocation(invocation).pipe(Effect.result));

const secretWorkspace = workspace({
	name: 'test-workspace',
	version: '1',
	collections: [collection({ name: 'people', fields: { name: field.string({ required: true }) } })],
	apps: [],
	// `nobody` is deliberately absent from the teams below: a team the release does not declare holds
	// no policies at all and is refused by default, which is the session a payload claiming
	// `teamPath: ['admin']` would try to widen.
	policies: [policy({ name: 'admin', effect: 'allow', actions: ['*'], capabilities: { apps: ['*'] } })],
	teams: {
		admin: ['admin']
	},
	automations: [],
	envoys: [],
	integrations: [],
		prompt: 'You are the test workspace agent.',
		tools: [],
		skills: [],
	requiredFacilities: []
});

/** A row that exists, so "no rows" cannot be mistaken for "the read was stopped". */
const seed = async (runtime: BoltTestRuntime) => {
	await runtime.database.query('insert into people (norbital_id, name) values ($1, $2)', [
		recordId('person-1'),
		'Ada'
	]);
	expect(await runtime.database.query('select name from people')).toEqual([{ name: 'Ada' }]);
};

describe('data browser plugin credential', () => {
	/**
	 * The exploit, not the refusal.
	 *
	 * The rows are asserted before the error is, so reverting the credential check fails this on the
	 * disclosed row rather than on a missing error — the diagnostic is the unauthenticated read
	 * landing, which is the whole thing being fixed.
	 */
	it('discloses no rows to an unauthenticated query claiming admin in its trustedContext', async () => {
		harness = await makeBoltTestRuntime(secretWorkspace);
		await seed(harness);

		const outcome = await outcomeOf(
			harness,
			query({ teamPath: ['admin'], subject: 'admin-external', impersonatedUser: 'admin-1' })
		);

		const disclosed = outcome._tag === 'Success' ? outcome.success.value : [];
		expect(disclosed, 'an unauthenticated plugin query returned tenant rows').toEqual([]);
		expect(outcome._tag).toBe('Failure');
		expect(outcome._tag === 'Failure' ? outcome.failure : undefined).toBeInstanceOf(
			AccessControl.AccessDenied
		);
	});

	// Refused, not downgraded: an empty page reads as "this workspace has no rows" and sends the
	// operator to look for a routing or seeding fault that is not there.
	it('refuses rather than answering an empty page', async () => {
		harness = await makeBoltTestRuntime(secretWorkspace);
		await seed(harness);
		for (const context of [{}, { teamPath: [] }, { subject: 'admin-external' }]) {
			const outcome = await outcomeOf(harness, query(context));
			expect(outcome._tag, JSON.stringify(context)).toBe('Failure');
			expect(
				outcome._tag === 'Failure' ? outcome.failure : undefined,
				JSON.stringify(context)
			).toBeInstanceOf(AccessControl.AccessDenied);
		}
	});

	it('reads the rows for a credential whose session carries the authority', async () => {
		harness = await makeBoltTestRuntime(secretWorkspace);
		await seed(harness);
		await seedSession(harness, { token: 'admin-token', user: 'user-admin-token', team: 'admin' });

		const outcome = await outcomeOf(harness, query({}, 'admin-token'));
		expect(outcome._tag).toBe('Success');
		expect(outcome._tag === 'Success' ? outcome.success.value : undefined).toMatchObject([
			{ name: 'Ada' }
		]);
	});

	/**
	 * The claim is inert in both directions: it cannot add authority a session lacks, and it cannot
	 * take away authority a session holds. Anything else would be a second place roles come from.
	 */
	it('takes roles from the session and not from the trustedContext beside it', async () => {
		harness = await makeBoltTestRuntime(secretWorkspace);
		await seed(harness);
		await seedSession(harness, { token: 'admin-token', user: 'user-admin-token', team: 'admin' });
		// A real team row whose name the release never declares — inert, holding nothing. That is what
		// the payload below tries to widen, and seeding no team at all would test the same refusal for
		// the weaker reason that the person is in no team.
		await seedSession(harness, {
			token: 'nobody-token',
			user: 'user-nobody-token',
			team: 'nobody'
		});

		const claimedDown = await outcomeOf(harness, query({ teamPath: ['nobody'] }, 'admin-token'));
		expect(claimedDown._tag === 'Success' ? claimedDown.success.value : undefined).toMatchObject([
			{ name: 'Ada' }
		]);

		const claimedUp = await outcomeOf(harness, query({ teamPath: ['admin'] }, 'nobody-token'));
		const leaked = claimedUp._tag === 'Success' ? claimedUp.success.value : [];
		expect(leaked, 'a payload role widened a session that does not hold it').toEqual([]);
		expect(claimedUp._tag === 'Failure' ? claimedUp.failure : undefined).toBeInstanceOf(
			AccessControl.AccessDenied
		);
	});

	// A credential from another tenant is a valid session and still not this workspace's reader.
	it('refuses a credential authenticated outside the invocation tenant', async () => {
		harness = await makeBoltTestRuntime(secretWorkspace);
		await seed(harness);
		// Placed in `admin` — the team that grants everything — so the refusal below can only be the
		// tenant mismatch and never an absence of authority.
		await seedSession(harness, {
			token: 'other-token',
			user: 'user-other',
			team: 'admin',
			tenantId: 'other-tenant',
			email: 'other@example.test'
		});

		const outcome = await outcomeOf(harness, query({}, 'other-token'));
		expect(outcome._tag === 'Success' ? outcome.success.value : []).toEqual([]);
		expect(outcome._tag).toBe('Failure');
	});
});
