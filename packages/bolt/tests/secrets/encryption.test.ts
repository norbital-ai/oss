import { Effect } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';
import { collection, field, policy, workspace } from '../../src/authoring/workspace-schema.js';
import { defineEnvironment } from '../../src/authoring/environment-schema.js';
import { Identity } from '../../src/runtime/identity/identity.js';
import {
	PersonalSecrets,
	type Interface as PersonalSecretsInterface
} from '../../src/runtime/secrets/personal-secrets.js';
import { Secrets } from '../../src/runtime/secrets/secrets.js';
import { makeBoltTestRuntime, type BoltTestRuntime } from '../support/bolt-test-layer.js';

/**
 * Encryption at rest, for both vaults, over real SQL.
 *
 * The claim is not "the code calls a cipher" — that is visible by reading it. It is that each way the
 * feature could be *present and useless* actually fails:
 *
 * - a host with no key stores nothing at all, rather than quietly storing plaintext;
 * - the bytes in the column are not the credential, asserted on the column and not on a round trip,
 *   because a round trip passes identically whether or not anything was ever encrypted;
 * - an altered ciphertext refuses instead of decrypting to a different string a caller would then go
 *   and use as a cookie;
 * - an envelope moved between rows refuses, so database write access does not become the ability to
 *   assume somebody else's session;
 * - a pre-encryption plaintext row is reported as unreadable and named as such, rather than handed
 *   back as though it were fine.
 *
 * Every one of those is checked against `bolt_secrets` and `bolt_personal_secrets` alike: they share
 * one cipher module precisely so there is one fail-closed path, and a test on only one of them would
 * not notice the two drifting apart.
 */

let harness: BoltTestRuntime | undefined;
afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

const SECRET_NAME = 'GEOCODING_API_KEY';
const SESSION_NAME = 'linkedin.session';
const WORKSPACE_VALUE = 'sk-live-workspace-credential';
const PERSONAL_VALUE = 'li_at=AQEDATdotSecretCookie';

const vaultWorkspace = workspace({
	name: 'test-workspace',
	version: '1',
	collections: [collection({ name: 'people', fields: { name: field.string({ required: true }) } })],
	apps: [],
	policies: [
		policy({ name: 'admin', effect: 'allow', actions: ['*'], apps: ['*'] })
	],
	teams: {
		admin: ['admin']
	},
	agents: [],
	automations: [],
	channels: [],
	integrations: [],
	requiredFacilities: [],
	environment: defineEnvironment({ [SECRET_NAME]: { label: 'Geocoding key' } })
});

const userA: Identity.Subject = {
	userId: 'user-a',
	tenantId: 'test-tenant',
	teamPath: ['employee']
};
const userB: Identity.Subject = {
	userId: 'user-b',
	tenantId: 'test-tenant',
	teamPath: ['employee']
};

const writePersonal = (
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

const readPersonal = (harnessed: BoltTestRuntime, subject: Identity.Subject, name: string) =>
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

/**
 * What an operation did, matched rather than flipped.
 *
 * A bare `Effect.flip` turns "it answered with the credential" into an unreadable defect, and
 * answering is precisely the wrong behaviour every test below is looking for.
 */
const outcomeOf = <A, E extends { readonly _tag: string }, R>(
	operation: Effect.Effect<A, E, R>
): Effect.Effect<{ readonly tag: string; readonly message: string }, never, R> =>
	operation.pipe(
		Effect.match({
			onFailure: (error: E) => ({
				tag: error._tag,
				message: error instanceof Error ? error.message : ''
			}),
			onSuccess: (value: A) => ({
				tag: `answered ${JSON.stringify(value)} instead of refusing`,
				message: ''
			})
		})
	);

/** The same, for an operation that has to be run as a specific person. */
const outcomeAsPerson = (
	harnessed: BoltTestRuntime,
	subject: Identity.Subject,
	operation: (
		secrets: PersonalSecretsInterface
	) => Effect.Effect<unknown, { readonly _tag: string }>
) =>
	harnessed.runtime.runPromise(
		outcomeOf(
			Effect.provideService(
				Effect.gen(function* () {
					return yield* operation(yield* PersonalSecrets.Service);
				}),
				Identity.CurrentSubject,
				subject
			)
		)
	);

const writeWorkspace = (harnessed: BoltTestRuntime, value: string) =>
	harnessed.runtime.runPromise(
		Effect.gen(function* () {
			yield* (yield* Secrets.Service).write(
				harnessed.effectId('write'),
				SECRET_NAME,
				value,
				'admin-1'
			);
		})
	);

const readWorkspace = (harnessed: BoltTestRuntime) =>
	harnessed.runtime.runPromise(
		Effect.gen(function* () {
			return yield* (yield* Secrets.Service).read(harnessed.effectId('read'), SECRET_NAME);
		})
	);

const storedWorkspace = async (harnessed: BoltTestRuntime): Promise<string> => {
	const [row] = await harnessed.database.query('select value from bolt_secrets where name = $1', [
		SECRET_NAME
	]);
	return String(row?.['value'] ?? '');
};

const storedPersonal = async (harnessed: BoltTestRuntime, userId: string): Promise<string> => {
	const [row] = await harnessed.database.query(
		'select value from bolt_personal_secrets where user_id = $1 and name = $2',
		[userId, SESSION_NAME]
	);
	return String(row?.['value'] ?? '');
};

describe('secrets at rest', () => {
	/**
	 * The load-bearing test, and the one property nothing else can stand in for.
	 *
	 * A vault that falls back to plaintext when it cannot encrypt is indistinguishable at the call site
	 * from one that encrypted: `write` returns the same `void` either way, and the caller goes on
	 * believing the credential is protected. So the refusal is asserted *and* the table is asserted
	 * empty — refusing loudly while having already written the row would pass the first half alone.
	 */
	it('refuses to write either vault when the host configured no key, and stores nothing', async () => {
		harness = await makeBoltTestRuntime(vaultWorkspace, { secretKey: null });

		const workspaceOutcome = await harness.runtime.runPromise(
			outcomeOf(
				Effect.gen(function* () {
					yield* (yield* Secrets.Service).write(
						harness!.effectId('write'),
						SECRET_NAME,
						WORKSPACE_VALUE,
						'admin-1'
					);
				})
			)
		);
		const personalOutcome = await outcomeAsPerson(harness, userA, (secrets) =>
			secrets.write(harness!.effectId('write'), SESSION_NAME, PERSONAL_VALUE)
		);

		expect(workspaceOutcome.tag).toBe('Bolt.Secrets.KeyUnavailable');
		expect(personalOutcome.tag).toBe('Bolt.Secrets.KeyUnavailable');
		// The reason has to name what to set, or an operator meets a refusal with nothing to act on.
		expect(workspaceOutcome.message).toContain('BOLT_SECRETS_KEY is not set');
		expect(personalOutcome.message).toContain('BOLT_SECRETS_KEY is not set');

		expect(
			await harness.database.query('select 1 from bolt_secrets'),
			'a secret was stored despite the refusal'
		).toHaveLength(0);
		expect(
			await harness.database.query('select 1 from bolt_personal_secrets'),
			'a personal secret was stored despite the refusal'
		).toHaveLength(0);
	});

	/** A key that is present but unusable is the same refusal, with a reason that says which mistake it is. */
	it('refuses a key that is not 32 bytes rather than encrypting under a weaker one', async () => {
		harness = await makeBoltTestRuntime(vaultWorkspace, { secretKey: 'dG9vLXNob3J0' });
		const outcome = await harness.runtime.runPromise(
			outcomeOf(
				Effect.gen(function* () {
					yield* (yield* Secrets.Service).write(
						harness!.effectId('write'),
						SECRET_NAME,
						WORKSPACE_VALUE,
						'admin-1'
					);
				})
			)
		);
		expect(outcome.tag).toBe('Bolt.Secrets.KeyUnavailable');
		expect(outcome.message).toContain('is not 32 bytes of base64');
		expect(await harness.database.query('select 1 from bolt_secrets')).toHaveLength(0);
	});

	/**
	 * Asserted on the column, not on a round trip.
	 *
	 * A round trip returns the value whether or not anything was encrypted, so it can only ever prove
	 * that read and write agree. What matters is what a backup, a replica or a psql session sees.
	 */
	it('stores an envelope and not the credential, in both tables', async () => {
		harness = await makeBoltTestRuntime(vaultWorkspace);
		await writeWorkspace(harness, WORKSPACE_VALUE);
		await writePersonal(harness, userA, SESSION_NAME, PERSONAL_VALUE);

		const workspaceStored = await storedWorkspace(harness);
		const personalStored = await storedPersonal(harness, 'user-a');

		expect(workspaceStored, 'the workspace vault stored the credential in the clear').not.toContain(
			WORKSPACE_VALUE
		);
		expect(personalStored, 'the personal vault stored the session in the clear').not.toContain(
			PERSONAL_VALUE
		);
		// Not merely "different from the plaintext" — a substring of it, or a reversal, would also be
		// different. `v1.<nonce>.<ciphertext>.<tag>`, four parts, is the encoding this vault claims.
		for (const stored of [workspaceStored, personalStored]) {
			expect(stored).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
			expect(stored.split('.')).toHaveLength(4);
		}
		// A fresh nonce per write, so the same value written twice does not produce the same row — equal
		// ciphertexts would leak "these two people use the same credential" to anyone reading the table.
		await writePersonal(harness, userB, SESSION_NAME, PERSONAL_VALUE);
		expect(await storedPersonal(harness, 'user-b')).not.toBe(personalStored);

		// And it still round-trips, so the encoding is not merely opaque but correct.
		expect(await readWorkspace(harness)).toBe(WORKSPACE_VALUE);
		expect(await readPersonal(harness, userA, SESSION_NAME)).toBe(PERSONAL_VALUE);
		expect(await readPersonal(harness, userB, SESSION_NAME)).toBe(PERSONAL_VALUE);
	});

	/**
	 * A tampered value fails, rather than decrypting to something else.
	 *
	 * This is the reason the mode is GCM. Without the authentication tag a flipped byte in the
	 * ciphertext produces a different string, `read` hands it back, and the caller sends it to a third
	 * party as a credential — a silent corruption that looks exactly like a wrong password.
	 */
	it('refuses an altered ciphertext instead of answering with different bytes', async () => {
		harness = await makeBoltTestRuntime(vaultWorkspace);
		await writeWorkspace(harness, WORKSPACE_VALUE);
		await writePersonal(harness, userA, SESSION_NAME, PERSONAL_VALUE);

		/** Flips one character of the ciphertext part, leaving the envelope otherwise well-formed. */
		const tamper = (stored: string): string => {
			const [version, nonce, ciphertext, tag] = stored.split('.');
			const body = String(ciphertext);
			const flipped = `${body[0] === 'A' ? 'B' : 'A'}${body.slice(1)}`;
			return [version, nonce, flipped, tag].join('.');
		};

		await harness.database.query('update bolt_secrets set value = $1 where name = $2', [
			tamper(await storedWorkspace(harness)),
			SECRET_NAME
		]);
		await harness.database.query('update bolt_personal_secrets set value = $1 where user_id = $2', [
			tamper(await storedPersonal(harness, 'user-a')),
			'user-a'
		]);

		const workspaceOutcome = await harness.runtime.runPromise(
			outcomeOf(
				Effect.gen(function* () {
					return yield* (yield* Secrets.Service).read(harness!.effectId('read'), SECRET_NAME);
				})
			)
		);
		const personalOutcome = await outcomeAsPerson(harness, userA, (secrets) =>
			secrets.read(harness!.effectId('read'), SESSION_NAME)
		);

		expect(workspaceOutcome.tag).toBe('Bolt.Secrets.Unreadable');
		expect(personalOutcome.tag).toBe('Bolt.Secrets.Unreadable');
		expect(workspaceOutcome.message).toContain('failed its authentication tag');
		expect(personalOutcome.message).toContain('failed its authentication tag');
	});

	/**
	 * An envelope is bound to the row it was written for.
	 *
	 * Encryption alone does not stop somebody with database write access from copying user A's
	 * ciphertext into user B's row: no plaintext moves, so nothing about the bytes is wrong. Binding
	 * the row's identity into the authentication makes that copy fail, which is why `personalBinding`
	 * carries the whole primary key.
	 */
	it('refuses an envelope lifted from another owner’s row', async () => {
		harness = await makeBoltTestRuntime(vaultWorkspace);
		await writePersonal(harness, userA, SESSION_NAME, PERSONAL_VALUE);
		await writePersonal(harness, userB, SESSION_NAME, 'li_at=user-b-own-session');

		await harness.database.query('update bolt_personal_secrets set value = $1 where user_id = $2', [
			await storedPersonal(harness, 'user-a'),
			'user-b'
		]);

		const outcome = await outcomeAsPerson(harness, userB, (secrets) =>
			secrets.read(harness!.effectId('read'), SESSION_NAME)
		);
		expect(outcome.tag, 'user A’s session was readable as user B by moving the row').toBe(
			'Bolt.Secrets.Unreadable'
		);
		// User A's own row is untouched and still opens, so the binding refuses the copy rather than the
		// value.
		expect(await readPersonal(harness, userA, SESSION_NAME)).toBe(PERSONAL_VALUE);
	});

	/**
	 * A row written before this vault encrypted anything is reported as unreadable, and named as that.
	 *
	 * The alternative — accepting a bare value as plaintext — is a compatibility path that never
	 * expires: every future reader has to keep it, and it doubles as an oracle for anyone who can write
	 * the column, since storing a plaintext value would then be a way to have it read straight back.
	 */
	it('reports a pre-encryption plaintext row as unreadable rather than handing it back', async () => {
		harness = await makeBoltTestRuntime(vaultWorkspace);
		await harness.database.query(
			"insert into bolt_secrets (tenant_id, name, value, updated_by) values ('', $1, $2, 'legacy')",
			[SECRET_NAME, WORKSPACE_VALUE]
		);
		await harness.database.query(
			'insert into bolt_personal_secrets (tenant_id, user_id, name, value) values ($1, $2, $3, $4)',
			['test-tenant', 'user-a', SESSION_NAME, PERSONAL_VALUE]
		);

		const workspaceOutcome = await harness.runtime.runPromise(
			outcomeOf(
				Effect.gen(function* () {
					return yield* (yield* Secrets.Service).read(harness!.effectId('read'), SECRET_NAME);
				})
			)
		);
		const personalOutcome = await outcomeAsPerson(harness, userA, (secrets) =>
			secrets.read(harness!.effectId('read'), SESSION_NAME)
		);

		expect(workspaceOutcome.tag).toBe('Bolt.Secrets.Unreadable');
		expect(personalOutcome.tag).toBe('Bolt.Secrets.Unreadable');
		for (const outcome of [workspaceOutcome, personalOutcome]) {
			expect(outcome.message).toContain('predates the key');
			// It has to say what to do about it, since nothing can recover the value.
			expect(outcome.message).toContain('set again');
		}
	});

	/**
	 * `status` is the surface a person uses to find out something is wrong, so it must not need the
	 * thing that is wrong. Both vaults answer from `name`/`updated_at`/`length(value)` and never touch
	 * a ciphertext — checked with the key removed, which is the only way to prove no decryption
	 * happens rather than merely that it succeeded.
	 */
	it('answers status without a key and without decrypting', async () => {
		harness = await makeBoltTestRuntime(vaultWorkspace);
		await writeWorkspace(harness, WORKSPACE_VALUE);
		await writePersonal(harness, userA, SESSION_NAME, PERSONAL_VALUE);
		const rows = {
			workspace: await storedWorkspace(harness),
			personal: await storedPersonal(harness, 'user-a')
		};
		await harness.dispose();

		// The same rows, under a runtime the host gave no key. Re-seeded directly because the envelopes
		// were written under the key the previous runtime had.
		harness = await makeBoltTestRuntime(vaultWorkspace, { secretKey: null });
		await harness.database.query(
			"insert into bolt_secrets (tenant_id, name, value, updated_by) values ('', $1, $2, 'admin-1')",
			[SECRET_NAME, rows.workspace]
		);
		await harness.database.query(
			'insert into bolt_personal_secrets (tenant_id, user_id, name, value) values ($1, $2, $3, $4)',
			['test-tenant', 'user-a', SESSION_NAME, rows.personal]
		);

		const workspaceStatus = await harness.runtime.runPromise(
			Effect.gen(function* () {
				return yield* (yield* Secrets.Service).status(harness!.effectId('status'));
			})
		);
		const personalStatus = await harness.runtime.runPromise(
			Effect.provideService(
				Effect.gen(function* () {
					return yield* (yield* PersonalSecrets.Service).status(harness!.effectId('status'));
				}),
				Identity.CurrentSubject,
				userA
			)
		);

		expect(
			new Map(workspaceStatus.map((entry) => [entry.name, entry.configured])).get(SECRET_NAME)
		).toBe(true);
		expect(personalStatus).toEqual([
			expect.objectContaining({ name: SESSION_NAME, configured: true })
		]);
		// And neither payload carries a value or an envelope — the point of `status` is that it is safe
		// to send to a browser.
		for (const payload of [JSON.stringify(workspaceStatus), JSON.stringify(personalStatus)]) {
			expect(payload).not.toContain(WORKSPACE_VALUE);
			expect(payload).not.toContain(PERSONAL_VALUE);
			expect(payload).not.toContain('v1.');
		}
	});
});
