import { readFileSync } from 'node:fs';
import { fixtureUserId, seedSession } from '../support/fixture-identity.js';
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
import { defineEnvironment } from '../../src/authoring/environment-schema.js';
import { AccessControl } from '../../src/runtime/access/access-control.js';
import { dispatchInvocation } from '../../src/runtime/dispatch.js';
import { Identity } from '../../src/runtime/identity/identity.js';
import { PersonalSecrets } from '../../src/runtime/secrets/personal-secrets.js';
import { Secrets } from '../../src/runtime/secrets/secrets.js';
import { makeBoltTestRuntime, type BoltTestRuntime } from '../support/bolt-test-layer.js';

/**
 * The personal vault, over real SQL and through the real dispatch boundary.
 *
 * The claim being tested is not "a per-user table exists" — it is that a personal secret has exactly
 * one reader and one writer, the person it belongs to, and that no route reaches somebody else's row:
 * not a second user, not an admin, not a payload that names a user id, and not work with nobody
 * behind it. Every one of those is a way the feature could be *present* and still wrong, so each gets
 * its own test rather than being implied by the happy path.
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
		id: InvocationId.make(`command-${name}-${credential}`),
		scope,
		deadlineEpochMs: Date.now() + 30_000,
		command: name,
		input: input as never,
		headers: { authorization: [`Bearer ${credential}`] }
	});

const task = (name: string, input: unknown = {}) =>
	Invocation.cases.Task.make({
		protocolVersion: PROTOCOL_VERSION,
		id: InvocationId.make(`task-${name}`),
		scope,
		deadlineEpochMs: Date.now() + 30_000,
		command: name,
		input: input as never,
		attempt: 0
	});

// The readable name is hashed the same way the fixture's SQL hashes it, because identity is keyed
// by `norbital_id uuid` and a subject has to name the row the session actually points at.
//
// `teamPath` is the team plus whatever it inherits, and these fixtures inherit nothing — so a single
// team name is the whole path. It names a team the workspace below declares, because a name the
// release does not declare holds no policies at all.
const subjectFor = (userId: string, team: string): Identity.Subject => ({
	userId: fixtureUserId(userId),
	tenantId: 'test-tenant',
	teamPath: [team], policies: []
});

const userA = subjectFor('user-a', 'employee');
const userB = subjectFor('user-b', 'employee');
const admin = subjectFor('user-admin', 'admin');

/** The server-side read, run as a specific person — the only way `PersonalSecrets` can be told who is asking. */
const readAs = (harnessed: BoltTestRuntime, subject: Identity.Subject, name: string) =>
	harnessed.runtime.runPromise(
		Effect.provideService(
			Effect.gen(function* () {
				return yield* (yield* PersonalSecrets.Service).read(
					harnessed.effectId(`read-${subject.userId}`),
					name
				);
			}),
			Identity.CurrentSubject,
			subject
		)
	);

const writeAs = (
	harnessed: BoltTestRuntime,
	subject: Identity.Subject,
	name: string,
	value: string
) =>
	harnessed.runtime.runPromise(
		Effect.provideService(
			Effect.gen(function* () {
				yield* (yield* PersonalSecrets.Service).write(
					harnessed.effectId(`write-${subject.userId}`),
					name,
					value
				);
			}),
			Identity.CurrentSubject,
			subject
		)
	);

const failureOf = async (harnessed: BoltTestRuntime, invocation: Invocation) => {
	const outcome = await harnessed.runtime.runPromise(
		dispatchInvocation(invocation).pipe(Effect.result)
	);
	if (outcome._tag !== 'Failure')
		throw new Error(`expected a refusal, got ${JSON.stringify(outcome)}`);
	return outcome.failure;
};

const SESSION_NAME = 'linkedin.session';

const vaultWorkspace = workspace({
	name: 'test-workspace',
	version: '1',
	collections: [collection({ name: 'people', fields: { name: field.string({ required: true }) } })],
	apps: [],
	policies: [
		policy({ name: 'admin', effect: 'allow', actions: ['*'], capabilities: { apps: ['*'] } }),
		policy({
			name: 'employee',
			effect: 'allow',
			grants: [{ collection: 'people', action: 'read' }]
		})
	],
	teams: {
		admin: ['admin', 'employee'],
		employee: ['employee']
	},
	automations: [],
	integrations: [],
	prompt: 'You are the test workspace agent.',
	tools: [],
	skills: [],
	envoys: [],
	requiredFacilities: [],
	environment: defineEnvironment({ GEOCODING_API_KEY: { label: 'Geocoding key' } })
});

describe('personal secrets', () => {
	it('round-trips a value for the person who stored it, through the command surface', async () => {
		harness = await makeBoltTestRuntime(vaultWorkspace);
		await seedSession(harness, { token: 'a-token', user: 'user-a', team: 'employee' });

		const written = await harness.runtime.runPromise(
			dispatchInvocation(
				command('personal-secrets.write', 'a-token', { name: SESSION_NAME, value: 'li_at=AAA' })
			)
		);
		expect(written.value).toMatchObject({ saved: true, name: SESSION_NAME });

		expect(await readAs(harness, userA, SESSION_NAME)).toBe('li_at=AAA');

		const status = await harness.runtime.runPromise(
			dispatchInvocation(command('personal-secrets.status', 'a-token'))
		);
		expect(status.value).toEqual([
			expect.objectContaining({ name: SESSION_NAME, configured: true })
		]);
		// The whole point of there being no `personal-secrets.read`: nothing a browser can ask for carries
		// the value.
		expect(JSON.stringify(status.value)).not.toContain('li_at=AAA');
	});

	/**
	 * The load-bearing test.
	 *
	 * A second employee and an admin both come away with `null` and both leave user A's row exactly as
	 * it was. The admin case is the one that distinguishes this feature from `bolt_secrets`: `manage
	 * secrets` opens the workspace vault and must not open somebody's signed-in session, because that
	 * session is not workspace configuration.
	 */
	it('refuses another user and an admin alike — reading and overwriting', async () => {
		harness = await makeBoltTestRuntime(vaultWorkspace);
		await writeAs(harness, userA, SESSION_NAME, 'li_at=AAA');

		expect(
			await readAs(harness, userB, SESSION_NAME),
			'a second user read user A’s value'
		).toBeNull();
		expect(await readAs(harness, admin, SESSION_NAME), 'an admin read user A’s value').toBeNull();

		// A write under the same name is their own row, not an overwrite of user A's.
		await writeAs(harness, userB, SESSION_NAME, 'li_at=BBB');
		await writeAs(harness, admin, SESSION_NAME, 'li_at=ADMIN');

		expect(
			await readAs(harness, userA, SESSION_NAME),
			'user A’s value was overwritten by somebody else'
		).toBe('li_at=AAA');
		expect(await readAs(harness, userB, SESSION_NAME)).toBe('li_at=BBB');
		expect(await readAs(harness, admin, SESSION_NAME)).toBe('li_at=ADMIN');

		// Three rows, one per owner — asserted on the stored column rather than through the service, so a
		// service that answered correctly while writing to one shared row would still be caught. The
		// values are envelopes, so the check is that each row exists and that none of them contains any
		// of the three plaintexts.
		const rows = await harness.database.query(
			'select user_id, name, value from bolt_personal_secrets order by user_id'
		);
		// Compared as a set: the rows come back ordered by `user_id`, which is a uuid, so their order is
		// the hash's rather than the readable name's.
		expect(rows.map((row) => [row['user_id'], row['name']]).sort()).toEqual(
			[
				[fixtureUserId('user-a'), SESSION_NAME],
				[fixtureUserId('user-admin'), SESSION_NAME],
				[fixtureUserId('user-b'), SESSION_NAME]
			].sort()
		);
		for (const row of rows)
			for (const plaintext of ['li_at=AAA', 'li_at=BBB', 'li_at=ADMIN'])
				expect(
					String(row['value']),
					`${String(row['user_id'])} stores a credential in the clear`
				).not.toContain(plaintext);

		// Deleting is per-owner too: user B forgetting their entry must not clear user A's.
		await harness.runtime.runPromise(
			Effect.provideService(
				Effect.gen(function* () {
					yield* (yield* PersonalSecrets.Service).forget(
						harness!.effectId('forget-b'),
						SESSION_NAME
					);
				}),
				Identity.CurrentSubject,
				userB
			)
		);
		expect(await readAs(harness, userB, SESSION_NAME)).toBeNull();
		expect(
			await readAs(harness, userA, SESSION_NAME),
			'one user’s forget deleted another user’s row'
		).toBe('li_at=AAA');
	});

	/**
	 * A payload that names an owner is ignored, because no owner is ever read from a payload.
	 *
	 * `MINTED_IDENTITY` already overwrites `subject` and `userId` on a `Command`, so this is the
	 * consequence one hop further in: the input schemas below declare no owner at all, and the WHERE
	 * clause takes its user id from `Identity.CurrentSubject`. If either of those changed, user B's row
	 * would appear here.
	 */
	it('honours no user id a command names, only the credential holder', async () => {
		harness = await makeBoltTestRuntime(vaultWorkspace);
		await seedSession(harness, { token: 'a-token', user: 'user-a', team: 'employee' });
		await writeAs(harness, userB, SESSION_NAME, 'li_at=BBB');

		const written = await harness.runtime.runPromise(
			dispatchInvocation(
				command('personal-secrets.write', 'a-token', {
					name: SESSION_NAME,
					value: 'stolen',
					// Every shape somebody might expect to be honoured: the minted fields, and a plausible
					// owner field the boundary does not mint and so never overwrites.
					userId: 'user-b',
					owner: 'user-b',
					subject: { userId: 'user-b', tenantId: 'test-tenant', policies: [], teamPath: ['admin'],  }
				})
			)
		);
		expect(written.value).toMatchObject({ saved: true });

		// The write landed on the credential holder's row, not on the one the payload named. Read back
		// through the service because the column holds an envelope, and each read is bound to its own
		// owner — so `user-b` still reading `li_at=BBB` is the assertion that their row was untouched.
		expect(
			(
				await harness.database.query('select user_id from bolt_personal_secrets order by user_id')
			).map((row) => row['user_id'])
		).toEqual([fixtureUserId('user-a'), fixtureUserId('user-b')].sort());
		expect(await readAs(harness, userA, SESSION_NAME)).toBe('stolen');
		expect(await readAs(harness, userB, SESSION_NAME), 'a named user id reached the write').toBe(
			'li_at=BBB'
		);

		// And the same through `forget`, which is the destructive half of the same question.
		await harness.runtime.runPromise(
			dispatchInvocation(
				command('personal-secrets.forget', 'a-token', {
					name: SESSION_NAME,
					userId: 'user-b',
					owner: 'user-b'
				})
			)
		);
		expect(
			(await harness.database.query('select user_id from bolt_personal_secrets')).map(
				(row) => row['user_id']
			),
			'a named user id reached the delete'
		).toEqual([fixtureUserId('user-b')]);
		expect(await readAs(harness, userB, SESSION_NAME)).toBe('li_at=BBB');
	});

	/**
	 * Work with nobody behind it is refused, not answered emptily.
	 *
	 * A scheduled task has no person and therefore no personal secrets. Answering `[]` or `null` would
	 * be indistinguishable from "this person has not set one up", which sends somebody to re-enter a
	 * credential that is already stored — and, worse, invites a future caller to treat the absence as a
	 * reason to fall back to a shared one.
	 */
	it('refuses a task, at the dispatch gate and again in the service', async () => {
		harness = await makeBoltTestRuntime(vaultWorkspace);

		for (const name of [
			'personal-secrets.status',
			'personal-secrets.write',
			'personal-secrets.forget'
		]) {
			const failure = await failureOf(harness, task(name, { name: SESSION_NAME, value: 'x' }));
			expect(failure, name).toBeInstanceOf(AccessControl.AccessDenied);
		}

		// The service refuses on its own, without relying on the dispatch gate above: a server-side caller
		// running inside a task reaches it directly.
		// Matched rather than flipped, so a method that *answers* is reported as the answer it gave — a
		// bare `Effect.flip` turns "it returned null" into an unreadable defect, and "it returned null"
		// is precisely the wrong behaviour under test.
		const refusal = <A, E extends { readonly _tag: string }, R>(
			operation: Effect.Effect<A, E, R>
		) =>
			operation.pipe(
				Effect.match({
					onFailure: (error: E) => error._tag,
					onSuccess: (value: A) =>
						`answered ${JSON.stringify(value) ?? 'nothing'} instead of refusing`
				})
			);
		const outcomes = await harness.runtime.runPromise(
			Effect.all([
				refusal(
					Effect.gen(function* () {
						return yield* (yield* PersonalSecrets.Service).read(
							harness!.effectId('read-nobody'),
							SESSION_NAME
						);
					})
				),
				refusal(
					Effect.gen(function* () {
						yield* (yield* PersonalSecrets.Service).write(
							harness!.effectId('write-nobody'),
							SESSION_NAME,
							'x'
						);
					})
				),
				refusal(
					Effect.gen(function* () {
						return yield* (yield* PersonalSecrets.Service).status(
							harness!.effectId('status-nobody')
						);
					})
				),
				refusal(
					Effect.gen(function* () {
						yield* (yield* PersonalSecrets.Service).forget(
							harness!.effectId('forget-nobody'),
							SESSION_NAME
						);
					})
				)
			])
		);
		expect(outcomes).toEqual([
			'Bolt.PersonalSecrets.NoSubject',
			'Bolt.PersonalSecrets.NoSubject',
			'Bolt.PersonalSecrets.NoSubject',
			'Bolt.PersonalSecrets.NoSubject'
		]);
		// Nothing was written under a fabricated owner while the write was being refused.
		expect(await harness.database.query('select 1 from bolt_personal_secrets')).toHaveLength(0);
	});

	/**
	 * Two vaults, one name, no collision.
	 *
	 * Separate tables means the two key spaces are genuinely independent, so a workspace key and a
	 * personal key may share a name without either shadowing the other — and, in the other direction,
	 * clearing one leaves the other alone.
	 */
	it('keeps a personal entry and a workspace entry of the same name apart', async () => {
		harness = await makeBoltTestRuntime(vaultWorkspace);
		const { runtime, effectId } = harness;

		await runtime.runPromise(
			Effect.gen(function* () {
				yield* (yield* Secrets.Service).write(
					effectId('tenant-write'),
					'GEOCODING_API_KEY',
					'workspace-key',
					'user-admin'
				);
			})
		);
		await writeAs(harness, userA, 'GEOCODING_API_KEY', 'user-a-key');

		expect(
			await runtime.runPromise(
				Effect.gen(function* () {
					return yield* (yield* Secrets.Service).read(effectId('tenant-read'), 'GEOCODING_API_KEY');
				})
			)
		).toBe('workspace-key');
		expect(await readAs(harness, userA, 'GEOCODING_API_KEY')).toBe('user-a-key');
		// One workspace row, and it is not the workspace key: the two vaults stay apart *and* neither
		// stores its value in the clear.
		const workspaceRows = await harness.database.query('select value from bolt_secrets');
		expect(workspaceRows).toHaveLength(1);
		expect(String(workspaceRows[0]?.['value'])).not.toContain('workspace-key');

		// Clearing the personal one leaves the workspace one standing.
		await writeAs(harness, userA, 'GEOCODING_API_KEY', '');
		expect(await readAs(harness, userA, 'GEOCODING_API_KEY')).toBeNull();
		expect(
			await runtime.runPromise(
				Effect.gen(function* () {
					return yield* (yield* Secrets.Service).read(
						effectId('tenant-read-again'),
						'GEOCODING_API_KEY'
					);
				})
			)
		).toBe('workspace-key');
	});

	// A personal name needs no `+env.ts` declaration — the workspace cannot know which sites a person
	// signs in to — so the vault's `SecretNotDeclared` refusal must not apply here.
	it('stores a name no declaration mentions, and clears by deleting rather than storing emptiness', async () => {
		harness = await makeBoltTestRuntime(vaultWorkspace);
		await writeAs(harness, userA, 'github.cookie', 'ghc=1');
		expect(await readAs(harness, userA, 'github.cookie')).toBe('ghc=1');

		await writeAs(harness, userA, 'github.cookie', '');
		// `''` would be a value: every `?? fallback` and `!= null` downstream would treat the credential as
		// present while it is not.
		expect(await readAs(harness, userA, 'github.cookie')).toBeNull();
		expect(await harness.database.query('select 1 from bolt_personal_secrets')).toHaveLength(0);
	});

	it('exposes status, write and forget, and deliberately no read', () => {
		// Asserted on the dispatch source because the absence is the guarantee — a test that only
		// exercised the commands that exist could never notice one being added.
		const dispatch = readFileSync(
			new URL('../../src/runtime/dispatch.ts', import.meta.url),
			'utf8'
		);
		expect(dispatch).toContain("case 'personal-secrets.status'");
		expect(dispatch).toContain("case 'personal-secrets.write'");
		expect(dispatch).toContain("case 'personal-secrets.forget'");
		expect(dispatch).not.toContain("case 'personal-secrets.read'");
	});
});
