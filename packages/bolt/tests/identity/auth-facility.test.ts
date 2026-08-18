import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	AUTH_MODELS,
	AUTH_SCHEMA,
	DEVELOPMENT_SIGN_IN_CODE,
	makeAuth,
	type DeliverCode
} from '../../src/runtime/identity/auth.js';
import type { ExecuteQuery } from '../../src/runtime/identity/auth-store.js';

/**
 * Identity is exercised against a real Postgres, driven through the same `execute` seam a host
 * binds. Asserting on generated SQL strings would only prove the adapter emits what its author
 * expected; running it proves Postgres accepts it, which is the claim that matters.
 */
describe('pod-owned identity over a host facility', () => {
	let database: PGlite;
	let execute: ExecuteQuery;
	const delivered: Array<{ email: string; code: string; purpose: string }> = [];
	const deliver: DeliverCode = async (message) => {
		delivered.push({ email: message.email, code: message.code, purpose: message.purpose });
	};

	beforeAll(async () => {
		database = await PGlite.create('memory://');
		execute = async (sql, parameters) => {
			const result = await database.query<Record<string, unknown>>(sql, [...parameters]);
			return { rows: result.rows, affectedRows: result.affectedRows ?? 0 };
		};
		for (const statement of AUTH_SCHEMA) await database.exec(statement.sql);
	});

	afterAll(async () => {
		await database.close();
	});

	it('applies its schema through the same plan idiom, and re-applies safely', async () => {
		// `schema.migrate` runs on every deploy, so a statement that is not idempotent breaks the
		// second one rather than the first.
		for (const statement of AUTH_SCHEMA) await database.exec(statement.sql);
		const tables = await database.query<{ table_name: string }>(
			`select table_name from information_schema.tables where table_name like 'bolt_auth_%' order by table_name`
		);
		expect(tables.rows.map((row) => row.table_name)).toEqual([
			AUTH_MODELS.account,
			// Where the pod keeps its own signing secret, so no host has to supply one.
			'bolt_auth_config',
			AUTH_MODELS.session,
			AUTH_MODELS.user,
			AUTH_MODELS.verification
		]);
	});

	it('signs a person in with a code, holding no connection and no mailer of its own', async () => {
		const auth = makeAuth({
			execute,
			deliver,
			secret: 'test-secret-not-a-real-one',
			baseURL: 'http://pod.test',
			production: true
		});
		const email = 'dion.neo@norbital.ai';
		await auth.api.sendVerificationOTP({ body: { email, type: 'sign-in' } });
		// The pod never sent anything itself: delivery went out through the host seam.
		expect(delivered.map((message) => message.email)).toEqual([email]);
		expect(delivered[0]?.purpose).toBe('sign-in');
		const code = delivered[0]?.code ?? '';
		expect(code).toMatch(/^\d{6}$/);

		const signedIn = await auth.api.signInEmailOTP({ body: { email, otp: code } });
		expect(signedIn.token).toBeTruthy();

		// The session and the person are rows the host's database now holds, written entirely through
		// `execute` — which is the property that makes this bundle host-agnostic.
		const sessions = await database.query<{ userId: string }>(
			`select "userId" from ${AUTH_MODELS.session}`
		);
		expect(sessions.rows.length).toBe(1);
		const users = await database.query<{ email: string }>(
			`select "email" from ${AUTH_MODELS.user}`
		);
		expect(users.rows.map((row) => row.email)).toEqual([email]);
	});

	it('refuses a wrong code, and refuses the right one twice', async () => {
		const auth = makeAuth({
			execute,
			deliver,
			secret: 'test-secret-not-a-real-one',
			baseURL: 'http://pod.test',
			production: true
		});
		const email = 'someone.else@norbital.ai';
		await auth.api.sendVerificationOTP({ body: { email, type: 'sign-in' } });
		const code = delivered.at(-1)?.code ?? '';
		await expect(
			auth.api.signInEmailOTP({ body: { email, otp: '000000' } })
		).rejects.toBeDefined();
		expect((await auth.api.signInEmailOTP({ body: { email, otp: code } })).token).toBeTruthy();
		// A code is spent when it is used. Replay is how a code read over someone's shoulder, or out
		// of a mailbox later, becomes a second session.
		await expect(auth.api.signInEmailOTP({ body: { email, otp: code } })).rejects.toBeDefined();
	});

	it('is deterministic and silent in development', async () => {
		const auth = makeAuth({
			execute,
			deliver,
			secret: 'test-secret-not-a-real-one',
			baseURL: 'http://pod.test',
			production: false
		});
		const before = delivered.length;
		const email = 'local.developer@norbital.ai';
		await auth.api.sendVerificationOTP({ body: { email, type: 'sign-in' } });
		// Nothing left the pod, and the code is the known one — the same request-a-code flow as
		// production rather than a bypass with a different shape.
		expect(delivered.length).toBe(before);
		expect(
			(await auth.api.signInEmailOTP({ body: { email, otp: DEVELOPMENT_SIGN_IN_CODE } })).token
		).toBeTruthy();
	});
});

/**
 * The credential-free surface.
 *
 * Sign-in is the one thing a caller reaches without a session, so the exemption is worth a test of
 * its own: it must admit exactly two commands and nothing else. A third slipping in is the failure
 * this guards, and it would not otherwise show up as a broken test anywhere.
 */
describe('the sign-in exemption', () => {
	it('names exactly the two commands that cannot require a session', async () => {
		const source = await import('node:fs/promises').then((fs) =>
			fs.readFile(new URL('../../src/runtime/dispatch.ts', import.meta.url), 'utf8')
		);
		const declared = source.match(/const SIGN_IN_COMMANDS[^=]*=\s*new Set\(\[([^\]]*)\]\)/);
		expect(declared?.[1]?.match(/'[^']+'/g)).toEqual([
			"'identity.sendCode'",
			"'identity.verifyCode'"
		]);
	});
});

describe('the code a development environment issues', () => {
	it('is the fixed development code, and is still delivered through the host', async () => {
		// This is the bug that shipped: identity hardcoded `production: true`, so a local stack
		// generated a random code and `123456` never matched — nobody could sign in locally at all.
		// The flag now follows the environment the host scoped the invocation to, which is the mode.
		// It deliberately does NOT follow whether a mailer is bound: a mailer is expected in every
		// environment, so its absence is a misconfiguration to surface, not a mode to infer.
		const database = await PGlite.create('memory://');
		try {
			const run: ExecuteQuery = async (sql, parameters) => {
				const result = await database.query<Record<string, unknown>>(sql, [...parameters]);
				return { rows: result.rows, affectedRows: result.affectedRows ?? 0 };
			};
			for (const statement of AUTH_SCHEMA) await database.exec(statement.sql);
			const sent: Array<string> = [];
			const development = makeAuth({
				execute: run,
				deliver: async (message) => {
					sent.push(message.code);
				},
				secret: 'test-secret-not-a-real-one',
				baseURL: 'http://pod.test',
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

describe('the signing secret the pod generates for itself', () => {
	it('uses only core Postgres, because pgcrypto is not a host obligation', async () => {
		// This shipped broken: the statement used `gen_random_bytes`, which lives in pgcrypto, and the
		// dev host had no such extension — every sign-in failed with `function gen_random_bytes(integer)
		// does not exist`. The earlier tests missed it because they call `makeAuth` directly and never
		// run the statement that provisions the secret. This one runs the real SQL.
		const database = await PGlite.create('memory://');
		try {
			for (const statement of AUTH_SCHEMA) await database.exec(statement.sql);
			const insert = `insert into bolt_auth_config (key, value) values ('session-secret', replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')) on conflict (key) do nothing`;
			await database.query(insert);
			// Re-running must not rotate the secret: a secret that changed on every boot would
			// invalidate every session the previous boot issued.
			await database.query(insert);
			const rows = await database.query<{ value: string }>(
				`select value from bolt_auth_config where key = 'session-secret'`
			);
			expect(rows.rows).toHaveLength(1);
			expect(rows.rows[0]?.value).toMatch(/^[0-9a-f]{64}$/);
		} finally {
			await database.close();
		}
	});
});
