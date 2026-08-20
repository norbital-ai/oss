import { Effect, Option, Redacted } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';
import {
	EnvironmentName,
	Invocation,
	InvocationId,
	PROTOCOL_VERSION,
	ReleaseId,
	TenantId
} from '@norbital-ai/bolt-protocol';
import { collection, field, policy, workspace } from '../../src/authoring/workspace-schema.js';
import { ADMIN_STATUS } from '../../src/runtime/identity/identity.js';
import {
	GATEWAY_SECRET_VARIABLE,
	HostConfig,
	SYSTEM_SIGNATURE_HEADER,
	SYSTEM_TIMESTAMP_HEADER,
	systemSignature,
	systemSignaturePayload
} from '../../src/runtime/access/system-principal.js';
import { dispatchInvocation } from '../../src/runtime/dispatch.js';
import { makeBoltTestRuntime, type BoltTestRuntime } from '../support/bolt-test-layer.js';
import { seedSession } from '../support/fixture-identity.js';

/**
 * `identity.bootstrapFounder`: the one command that turns a host's proof into a person and a session.
 *
 * Colony proves that whoever is completing a signup controls an inbox. That proof is not an identity
 * and Colony has no way to make it one — this command is where the proven address becomes an
 * administrator row and a session credential, inside the workspace that owns them. So the claims
 * under test are the ones that keep that seam honest:
 *
 *   1. **Only the host may run it.** Not an administrator. It hands back a live credential for
 *      whatever address it is given, so `manage`/`identity` — which is what `admitFounder` and every
 *      `teams.*` command sit behind — would let any administrator sign in as anybody. The admission
 *      case sits beside the refusals, because a refusal suite with nothing that succeeds is
 *      satisfied by a handler that refuses everyone, including one that throws.
 *   2. **A claim is spendable once.** The same claim for a different address is a replay and is
 *      refused; the same claim for the same address is a retried network call and is answered.
 *   3. **The workspace comes from the invocation, not the payload.**
 */

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

const HOST_SECRET = 'a-test-gateway-secret';

const scope = {
	tenantId: TenantId.make('test-tenant'),
	environment: EnvironmentName.make('test'),
	releaseId: ReleaseId.make('local')
};

/**
 * A workspace whose only declared policy grants one narrow thing.
 *
 * The default test workspace declares an `admin` policy granting `*` on `*`, which confers `manage`
 * on `identity` — so a member of that team would pass a `MEMBERSHIP_COMMANDS`-style gate and the
 * refusal cases below would be testing nothing at all.
 */
const peopleWorkspace = workspace({
	name: 'test-workspace',
	version: '1',
	collections: [collection({ name: 'people', fields: { name: field.string({ required: true }) } })],
	apps: [],
	policies: [policy({ name: 'Employee', effect: 'allow', actions: ['read'], apps: ['people'] })],
	teams: { Employee: ['Employee'] },
	agents: [],
	automations: [],
	channels: [],
	integrations: [],
	requiredFacilities: []
});

let sequence = 0;

/**
 * The host, proving it is the host — built exactly as Colony builds it.
 *
 * `systemSignaturePayload` rather than a rendering written for the test: two descriptions of "what
 * gets signed" is how a signature check comes to pass on something nobody meant to authorize, and a
 * test carrying the second one would be the place that drift went unnoticed.
 */
const signed = (command: string, input: Record<string, unknown>, secret = HOST_SECRET) => {
	const timestamp = Date.now();
	const digest = systemSignature(
		secret,
		systemSignaturePayload({ timestamp, command, tenantId: String(scope.tenantId), input })
	);
	return Invocation.cases.Command.make({
		protocolVersion: PROTOCOL_VERSION,
		id: InvocationId.make(`command-${command}-${(sequence += 1)}`),
		scope,
		deadlineEpochMs: Date.now() + 30_000,
		command,
		input: input as never,
		headers: {
			[SYSTEM_SIGNATURE_HEADER]: [digest],
			[SYSTEM_TIMESTAMP_HEADER]: [String(timestamp)]
		}
	});
};

/** The same invocation with a bearer credential instead of a host signature. */
const asPerson = (command: string, credential: string, input: Record<string, unknown>) =>
	Invocation.cases.Command.make({
		protocolVersion: PROTOCOL_VERSION,
		id: InvocationId.make(`command-${command}-${(sequence += 1)}`),
		scope,
		deadlineEpochMs: Date.now() + 30_000,
		command,
		input: input as never,
		headers: { authorization: [`Bearer ${credential}`] }
	});

/**
 * The host's secret, injected rather than read from the machine this runs on.
 *
 * `verifySystemSignature` falls back to `hostConfigFromProcessEnv` when no `HostConfig` is bound,
 * so a suite that said nothing would depend on whether the developer happens to export
 * `COLONY_GATEWAY_SECRET` — and the fail-closed cases would pass for the wrong reason on a laptop
 * that did.
 */
const withHostSecret = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	effect.pipe(
		Effect.provideService(HostConfig, {
			read: (key: string) =>
				Effect.succeed(
					key === GATEWAY_SECRET_VARIABLE
						? Option.some(Redacted.make(HOST_SECRET))
						: Option.none<Redacted.Redacted<string>>()
				)
		})
	);

const dispatch = (runtime: BoltTestRuntime, invocation: Invocation) =>
	runtime.runtime.runPromise(withHostSecret(dispatchInvocation(invocation)));

const refusalOf = async (runtime: BoltTestRuntime, invocation: Invocation) => {
	const outcome = await runtime.runtime.runPromise(
		withHostSecret(dispatchInvocation(invocation)).pipe(Effect.result)
	);
	if (outcome._tag !== 'Failure')
		throw new Error(`expected a refusal, got ${JSON.stringify(outcome)}`);
	return outcome.failure;
};

const read = (value: unknown, key: string): unknown =>
	value === null || typeof value !== 'object' ? undefined : Reflect.get(value, key);

const founderRow = (runtime: BoltTestRuntime, email: string) =>
	runtime.database
		.query(
			'select "norbital_id"::text as "id", "status", "tenantId" from bolt_auth_user where "email" = $1',
			[email]
		)
		.then((rows) => rows[0]);

const ledgerRows = (runtime: BoltTestRuntime) =>
	runtime.database.query(
		'select "identifier", "value" from bolt_auth_verification where "identifier" like $1 order by "identifier"',
		['founder-claim:%']
	);

const sessionCount = (runtime: BoltTestRuntime, userId: string) =>
	runtime.database
		.query('select count(*)::int as "count" from bolt_auth_session where "userId" = $1::uuid', [
			userId
		])
		.then((rows) => Number(read(rows[0], 'count') ?? 0));

describe('who may bootstrap a founder', () => {
	it('admits the host, and hands back a session for the address it proved', async () => {
		harness = await makeBoltTestRuntime(peopleWorkspace);
		const response = await dispatch(
			harness,
			signed('identity.bootstrapFounder', {
				email: 'founder@example.com',
				claimId: 'claim-1'
			})
		);
		expect(response.status).toBe(200);
		expect(read(response.value, 'admitted')).toBe(true);
		expect(read(response.value, 'admin')).toBe(true);
		const credential = read(response.value, 'credential');
		expect(typeof credential).toBe('string');
		expect(String(credential).length).toBeGreaterThan(0);
		// An administrator by status, in this workspace, on the address that was proved.
		const row = founderRow(harness, 'founder@example.com');
		expect(read(await row, 'status')).toBe(ADMIN_STATUS);
		expect(read(await row, 'tenantId')).toBe('test-tenant');
	});

	it('refuses an administrator of the workspace, whose authority is not the host authority', async () => {
		harness = await makeBoltTestRuntime(peopleWorkspace);
		await seedSession(harness, { token: 'admin-token', user: 'ada', status: ADMIN_STATUS });
		/**
		 * The hazard this gate exists for, stated as a case.
		 *
		 * On `MEMBERSHIP_COMMANDS` with `manage`/`identity` — the gate `identity.admitFounder` and
		 * every `teams.*` command use — this would succeed, and an administrator would hold a working
		 * session as an address they simply typed. `admitFounder` only writes a row; this hands back a
		 * credential, so it is gated on `subject.system` instead.
		 */
		const failure = await refusalOf(
			harness,
			asPerson('identity.bootstrapFounder', 'admin-token', {
				email: 'victim@example.com',
				claimId: 'claim-forged'
			})
		);
		expect(String(read(failure, '_tag'))).toContain('AccessDenied');
		// And nothing was written: a refusal that returned an error while still admitting the address
		// would pass a status-only assertion.
		expect(await founderRow(harness, 'victim@example.com')).toBeUndefined();
		expect(await ledgerRows(harness)).toEqual([]);
	});

	it('refuses an ordinary member, and refuses an unsigned invocation', async () => {
		harness = await makeBoltTestRuntime(peopleWorkspace);
		await seedSession(harness, { token: 'member-token', user: 'grace', team: 'Employee' });
		await refusalOf(
			harness,
			asPerson('identity.bootstrapFounder', 'member-token', {
				email: 'victim@example.com',
				claimId: 'claim-member'
			})
		);
		// A signature under the wrong secret is not a signature. The host is proved per invocation, so
		// there is no credential to steal and nothing to revoke — only a digest that does not match.
		await refusalOf(
			harness,
			signed(
				'identity.bootstrapFounder',
				{ email: 'victim@example.com', claimId: 'claim-wrong-secret' },
				'not-the-host-secret'
			)
		);
		expect(await founderRow(harness, 'victim@example.com')).toBeUndefined();
	});
});

describe('spending a founder claim', () => {
	it('refuses the same claim presented for a different address', async () => {
		harness = await makeBoltTestRuntime(peopleWorkspace);
		await dispatch(
			harness,
			signed('identity.bootstrapFounder', { email: 'founder@example.com', claimId: 'claim-1' })
		);
		const failure = await refusalOf(
			harness,
			signed('identity.bootstrapFounder', { email: 'attacker@evil.example', claimId: 'claim-1' })
		);
		expect(String(read(failure, '_tag'))).toContain('AccessDenied');
		// The replay bought nothing: no row for the address it named, and the ledger still remembers
		// the founder it was actually spent on.
		expect(await founderRow(harness, 'attacker@evil.example')).toBeUndefined();
		const ledger = await ledgerRows(harness);
		expect(ledger).toHaveLength(1);
		expect(String(read(ledger[0], 'value'))).toContain('founder@example.com');
	});

	it('answers a retry of the same exchange without admitting anybody twice', async () => {
		harness = await makeBoltTestRuntime(peopleWorkspace);
		const first = await dispatch(
			harness,
			signed('identity.bootstrapFounder', { email: 'founder@example.com', claimId: 'claim-1' })
		);
		const retry = await dispatch(
			harness,
			signed('identity.bootstrapFounder', { email: 'founder@example.com', claimId: 'claim-1' })
		);
		expect(retry.status).toBe(200);
		// The same person, found on the ledger rather than admitted again.
		expect(read(retry.value, 'userId')).toBe(read(first.value, 'userId'));
		expect(await ledgerRows(harness)).toHaveLength(1);
		/**
		 * A fresh session, not the stored one — because the credential is never stored.
		 *
		 * The ledger holds `claimId -> userId`, deliberately: a live session token at rest in a table
		 * of short-lived verification artifacts is a secret outliving the flow that made it, and that
		 * table is swept. The cost is the assertion below — a retry can leave a second live session
		 * for the same founder. Same person, same tenant, same status, and sessions expire.
		 */
		expect(read(retry.value, 'credential')).not.toBe(read(first.value, 'credential'));
		expect(await sessionCount(harness, String(read(first.value, 'userId')))).toBe(2);
	});

	it('files the claim under an identifier that cannot collide with a sign-in code', async () => {
		harness = await makeBoltTestRuntime(peopleWorkspace);
		await dispatch(
			harness,
			signed('identity.bootstrapFounder', { email: 'founder@example.com', claimId: 'claim-1' })
		);
		const ledger = await ledgerRows(harness);
		expect(String(read(ledger[0], 'identifier'))).toBe('founder-claim:claim-1');
		// `bolt_auth_verification` is Better Auth's table and it keeps one-time codes keyed by address.
		// The prefix is what keeps a claim out of that namespace.
		expect(String(read(ledger[0], 'identifier'))).not.toBe('founder@example.com');
		// And what is stored is the founder's id and address — never the credential that was minted.
		const value = String(read(ledger[0], 'value'));
		expect(value).toContain('founder@example.com');
		expect(value.split(' ')[0]).toBe(String(read(await founderRow(harness, 'founder@example.com'), 'id')));
	});
});

describe('which workspace a founder lands in', () => {
	it('comes from the invocation scope, and a payload naming another is overwritten', async () => {
		harness = await makeBoltTestRuntime(peopleWorkspace);
		/**
		 * A payload naming another workspace, and what actually happens to it.
		 *
		 * `tenantId` is a *minted* field on the system branch: it is stamped from `invocation.scope`
		 * over whatever the payload said, rather than refused. So the hostile value below is not an
		 * error — it is simply not read, which is the same guarantee reached by a quieter route. The
		 * assertion is therefore on the row: the founder lands in the workspace the invocation was
		 * scoped to, and nothing exists in the one the payload asked for.
		 *
		 * The signature covers the input as well, so a digest captured for one tenant cannot be
		 * replayed against another either — this is the second of the two locks, not the only one.
		 */
		const response = await dispatch(
			harness,
			signed('identity.bootstrapFounder', {
				email: 'founder@example.com',
				claimId: 'claim-1',
				tenantId: 'somebody-elses-tenant'
			})
		);
		expect(response.status).toBe(200);
		const row = await founderRow(harness, 'founder@example.com');
		expect(read(row, 'tenantId')).toBe('test-tenant');
		expect(read(row, 'tenantId')).not.toBe('somebody-elses-tenant');
	});

	it('refuses a payload that tries to name its own subject', async () => {
		harness = await makeBoltTestRuntime(peopleWorkspace);
		/**
		 * `subject` is the field the whole gate rests on, so a payload claiming one must not be able
		 * to walk in holding it. Unlike `tenantId` it is refused rather than overwritten on the
		 * credential-free paths, and overwritten on the signed one — either way there is no route from
		 * a payload to `subject.system`, which is what `authorizeSystemCommand` reads.
		 */
		const failure = await refusalOf(
			harness,
			asPerson('identity.bootstrapFounder', 'no-such-token', {
				email: 'victim@example.com',
				claimId: 'claim-x',
				subject: { userId: 'colony-system', tenantId: 'test-tenant', system: true, teamPath: [] }
			})
		);
		expect(read(failure, 'code') ?? read(failure, '_tag')).toBeTruthy();
		expect(await founderRow(harness, 'victim@example.com')).toBeUndefined();
	});
});
