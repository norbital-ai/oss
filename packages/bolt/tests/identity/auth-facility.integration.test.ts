import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { vector } from '@electric-sql/pglite-pgvector';
import { Effect } from 'effect';
import { AUTH_MODELS } from '../../src/authoring/system-models.js';
import { workspace } from '../../src/authoring/workspace-schema.js';
import { buildSchemaPlan } from '../../src/compiler/schema-plan.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	DEVELOPMENT_SIGN_IN_CODE,
	makeAuth,
	type DeliverCode
} from '../../src/runtime/identity/auth.js';
import type { ExecuteQuery } from '../../src/runtime/identity/auth-store.js';

const schemaPlan = buildSchemaPlan(
	workspace({
		name: 'identity-facility-test',
		version: '1',
		collections: [],
		apps: [],
		policies: [],
		automations: [],
		envoys: [],
		integrations: [],
		prompt: '',
		tools: [],
		skills: [],
		requiredFacilities: []
	})
);

/**
 * Identity is exercised against a real Postgres, driven through the same `execute` seam a host
 * binds. Asserting on generated SQL strings would only prove the adapter emits what its author
 * expected; running it proves Postgres accepts it, which is the claim that matters.
 */
describe('bolt-owned identity over a host facility', () => {
	let database: PGlite;
	let execute: ExecuteQuery;
	const delivered: Array<{ email: string; code: string; purpose: string }> = [];
	const deliver: DeliverCode = (message) =>
		Effect.sync(() => {
			delivered.push({ email: message.email, code: message.code, purpose: message.purpose });
		});

	beforeAll(async () => {
		database = await PGlite.create('memory://', {
			extensions: { pg_trgm, btree_gist, vector }
		});
		execute = ({ sql, parameters }) =>
			Effect.promise(async () => {
				const result = await database.query<Record<string, unknown>>(sql, [...parameters]);
				return { rows: result.rows, affectedRows: result.affectedRows ?? 0 };
			});
		for (const statement of schemaPlan.steps) await database.exec(statement.sql);
	});

	afterAll(async () => {
		await database.close();
	});

	it('applies identity through the signed migration plan, and re-applies safely', async () => {
		// `schema.migrate` runs on every deploy, so a statement that is not idempotent breaks the
		// second one rather than the first.
		for (const statement of schemaPlan.steps) await database.exec(statement.sql);
		const tables = await database.query<{ table_name: string }>(
			`select table_name from information_schema.tables
			  where table_name in ('account', 'auth_config', 'session', 'team', 'user', 'verification')
			  order by table_name`
		);
		expect(tables.rows.map((row) => row.table_name)).toEqual([
			AUTH_MODELS.account,
			// Where bolt keeps its own signing secret, so no host has to supply one.
			'auth_config',
			AUTH_MODELS.session,
			'team',
			AUTH_MODELS.user,
			AUTH_MODELS.verification
		]);
	});

	it('signs a person in with a code, holding no connection and no mailer of its own', async () => {
		const auth = makeAuth({
			execute,
			deliver,
			secret: 'test-secret-not-a-real-one',
			baseURL: 'http://bolt.test',
			production: true
		});
		const email = 'dion.neo@norbital.ai';
		await auth.api.sendVerificationOTP({ body: { email, type: 'sign-in' } });
		// Bolt never sent anything itself: delivery went out through the host seam.
		expect(delivered.map((message) => message.email)).toEqual([email]);
		expect(delivered[0]?.purpose).toBe('sign-in');
		const code = delivered[0]?.code ?? '';
		expect(code).toMatch(/^\d{6}$/);

		const signedIn = await auth.api.signInEmailOTP({ body: { email, otp: code } });
		expect(signedIn.token).toBeTruthy();

		// The session and the person are rows the host's database now holds, written entirely through
		// `execute` — which is the property that makes this bundle host-agnostic.
		const sessions = await database.query<{ userId: string }>(
			`select "userId" from "${AUTH_MODELS.session}"`
		);
		expect(sessions.rows.length).toBe(1);
		const users = await database.query<{ email: string }>(
			`select "email" from "${AUTH_MODELS.user}"`
		);
		expect(users.rows.map((row) => row.email)).toEqual([email]);
	});

	it('refuses a wrong code, and refuses the right one twice', async () => {
		const auth = makeAuth({
			execute,
			deliver,
			secret: 'test-secret-not-a-real-one',
			baseURL: 'http://bolt.test',
			production: true
		});
		const email = 'someone.else@norbital.ai';
		await auth.api.sendVerificationOTP({ body: { email, type: 'sign-in' } });
		const code = delivered.at(-1)?.code ?? '';
		await expect(auth.api.signInEmailOTP({ body: { email, otp: '000000' } })).rejects.toBeDefined();
		expect((await auth.api.signInEmailOTP({ body: { email, otp: code } })).token).toBeTruthy();
		// A code is spent when it is used. Replay is how a code read over someone's shoulder, or out
		// of a mailbox later, becomes a second session.
		await expect(auth.api.signInEmailOTP({ body: { email, otp: code } })).rejects.toBeDefined();
	});

	/**
	 * The token a sign-in returns is the token `authenticate` has to find.
	 *
	 * `AUTHENTICATE_SQL` looks a credential up as `session.token`. Better Auth mints that
	 * row itself, so nothing in this repository guarantees the value it hands back is the value it
	 * stored — and no test joined the two halves: every other identity fixture mints its session
	 * through `startSession`, which inserts the row directly, so the whole suite could be green while
	 * the only path a person actually uses was broken.
	 */
	it('returns a token that names a live session row, which is what authenticate looks up', async () => {
		const auth = makeAuth({
			execute,
			deliver,
			secret: 'test-secret-not-a-real-one',
			baseURL: 'http://bolt.test',
			production: true
		});
		const email = 'round.trip@example.test';
		await auth.api.sendVerificationOTP({ body: { email, type: 'sign-in' } });
		const code = delivered.at(-1)?.code ?? DEVELOPMENT_SIGN_IN_CODE;
		const signedIn = await auth.api.signInEmailOTP({ body: { email, otp: code } });
		expect(signedIn.token).toBeTruthy();
		const found = await database.query<{ count: string }>(
			`select count(*)::text as count from "${AUTH_MODELS.session}" where "token" = $1 and "expiresAt" > now()`,
			[signedIn.token]
		);
		expect(found.rows[0]?.count).toBe('1');
	});

	it('is deterministic and silent in development', async () => {
		const auth = makeAuth({
			execute,
			deliver,
			secret: 'test-secret-not-a-real-one',
			baseURL: 'http://bolt.test',
			production: false
		});
		const before = delivered.length;
		const email = 'local.developer@norbital.ai';
		await auth.api.sendVerificationOTP({ body: { email, type: 'sign-in' } });
		// Nothing left bolt, and the code is the known one — the same request-a-code flow as
		// production rather than a bypass with a different shape.
		expect(delivered.length).toBe(before);
		expect(
			(await auth.api.signInEmailOTP({ body: { email, otp: DEVELOPMENT_SIGN_IN_CODE } })).token
		).toBeTruthy();
	});
});

describe('the code a development environment issues', () => {
	it('is the fixed development code, and is still delivered through the host', async () => {
		// This is the bug that shipped: identity hardcoded `production: true`, so a local stack
		// generated a random code and `123456` never matched — nobody could sign in locally at all.
		// The flag now follows the environment the host scoped the invocation to, which is the mode.
		// It deliberately does NOT follow whether a mailer is bound: a mailer is expected in every
		// environment, so its absence is a misconfiguration to surface, not a mode to infer.
		const database = await PGlite.create('memory://', {
			extensions: { pg_trgm, btree_gist, vector }
		});
		try {
			const run: ExecuteQuery = ({ sql, parameters }) =>
				Effect.promise(async () => {
					const result = await database.query<Record<string, unknown>>(sql, [...parameters]);
					return { rows: result.rows, affectedRows: result.affectedRows ?? 0 };
				});
			for (const statement of schemaPlan.steps) await database.exec(statement.sql);
			const sent: Array<string> = [];
			const development = makeAuth({
				execute: run,
				deliver: (message) => Effect.sync(() => void sent.push(message.code)),
				secret: 'test-secret-not-a-real-one',
				baseURL: 'http://bolt.test',
				production: false
			});
			const email = 'local.dev@norbital.ai';
			await development.api.sendVerificationOTP({ body: { email, type: 'sign-in' } });
			// Development does not send, so the mailer stays untouched even though it is bound.
			expect(sent).toEqual([]);
			const signedIn = await development.api.signInEmailOTP({
				body: { email, otp: DEVELOPMENT_SIGN_IN_CODE }
			});
			expect(signedIn.token).toBeTruthy();
		} finally {
			await database.close();
		}
	});
});

describe('the signing secret bolt generates for itself', () => {
	it('uses only core Postgres, because pgcrypto is not a host obligation', async () => {
		// This shipped broken: the statement used `gen_random_bytes`, which lives in pgcrypto, and the
		// dev host had no such extension — every sign-in failed with `function gen_random_bytes(integer)
		// does not exist`. The earlier tests missed it because they call `makeAuth` directly and never
		// run the statement that provisions the secret. This one runs the real SQL.
		const database = await PGlite.create('memory://', {
			extensions: { pg_trgm, btree_gist, vector }
		});
		try {
			for (const statement of schemaPlan.steps) await database.exec(statement.sql);
			const insert = `insert into "auth_config" ("key", "value") select 'session-secret', replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '') where not exists (select 1 from "auth_config" where "key" = 'session-secret')`;
			await database.query(insert);
			// Re-running must not rotate the secret: a secret that changed on every boot would
			// invalidate every session the previous boot issued.
			await database.query(insert);
			const rows = await database.query<{ value: string }>(
				`select value from "auth_config" where key = 'session-secret'`
			);
			expect(rows.rows).toHaveLength(1);
			expect(rows.rows[0]?.value).toMatch(/^[0-9a-f]{64}$/);
		} finally {
			await database.close();
		}
	});
});
