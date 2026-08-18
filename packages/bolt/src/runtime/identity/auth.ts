import { betterAuth } from 'better-auth';
import { emailOTP } from 'better-auth/plugins';
import { makeAuthStore, type ExecuteQuery } from './auth-store.js';
import {
	boltAuthAccount,
	boltAuthConfig,
	boltAuthSession,
	boltAuthUser,
	boltAuthVerification,
	createTableSql
} from './auth-tables.js';

/**
 * Identity for the pod, owned by the pod.
 *
 * Better Auth runs *inside* the bundle. It reaches state only through `execute` and reaches people
 * only through `deliver`, both of which are host facilities — so the same bundle authenticates
 * against Colony's Neon branch and against a test's in-memory Postgres without knowing either
 * exists. Nothing here opens a connection, reads an environment variable, or mounts a route.
 *
 * The tables are prefixed. Better Auth's defaults are `user`, `session`, `account` and
 * `verification`, which are names a tenant's own workspace is entitled to use — a workspace with a
 * `user` collection would otherwise share a table with the auth system and corrupt both.
 */
export const AUTH_MODELS = {
	user: 'bolt_auth_user',
	session: 'bolt_auth_session',
	account: 'bolt_auth_account',
	verification: 'bolt_auth_verification'
} as const;

/**
 * The code development signs in with.
 *
 * Fixed and never delivered, so local work needs no mailer and the flow exercised locally is the
 * same flow that ships — request a code, enter a code — rather than a bypass that skips the step.
 */
export const DEVELOPMENT_SIGN_IN_CODE = '123456';

/**
 * How the pod asks its host to deliver a code. Never called in development, where nothing is sent.
 *
 * The purposes are Better Auth's own, taken from its type rather than restated: a narrower union
 * here would compile until the day a plugin sends a purpose this pod never listed, and then fail at
 * the point of delivery instead of at the point of change.
 */
export type CodePurpose = Parameters<
	NonNullable<Parameters<typeof emailOTP>[0]['sendVerificationOTP']>
>[0]['type'];

export type DeliverCode = (message: {
	readonly email: string;
	readonly code: string;
	readonly purpose: CodePurpose;
}) => Promise<void>;

export type AuthOptions = Readonly<{
	readonly execute: ExecuteQuery;
	readonly deliver: DeliverCode;
	/** Signs sessions. Supplied by the host; never read from the environment by the bundle. */
	readonly secret: string;
	readonly baseURL: string;
	/** Development neither delivers a code nor randomises one. */
	readonly production: boolean;
}>;

/**
 * The schema the pod's identity needs, in the same `create table if not exists` idiom as the rest
 * of the plan so `schema.migrate` applies it and re-applies it safely.
 *
 * Columns are quoted camelCase because that is the shape Better Auth reads and writes; aliasing
 * snake_case back on every query would put a translation layer between the library and its own
 * schema, and that layer is where a mismatch hides.
 *
 * The step ids are not decorative. The plan applies steps in sorted id order, so a child table has
 * to sort after the table it references — hence `bolt:auth-user-session` rather than
 * `bolt:auth-session`, which would have sorted before its own parent and failed on a fresh
 * database. Naming the parent in the child's id makes that ordering visible instead of incidental.
 */
export const AUTH_SCHEMA: ReadonlyArray<{ readonly id: string; readonly sql: string }> = [
	// The step ids are not decorative. The plan applies steps in sorted id order, so a child table has
	// to sort after the table it references — hence `bolt:auth-user-session` rather than
	// `bolt:auth-session`, which would have sorted before its own parent and failed on a fresh
	// database. Naming the parent in the child's id makes that ordering visible instead of incidental.
	{ id: 'bolt:auth-user', sql: createTableSql(boltAuthUser) },
	{ id: 'bolt:auth-user-session', sql: createTableSql(boltAuthSession) },
	{ id: 'bolt:auth-user-account', sql: createTableSql(boltAuthAccount) },
	{ id: 'bolt:auth-verification', sql: createTableSql(boltAuthVerification) },
	{ id: 'bolt:auth-config', sql: createTableSql(boltAuthConfig) },
	{
		// The lookup every code check performs. Without it, verification degrades to a sequential scan
		// over every code the workspace has ever issued. An index is not part of a table's definition,
		// so it is the one step still written out here.
		id: 'bolt:auth-verification-identifier',
		sql: `create index if not exists ${AUTH_MODELS.verification}_identifier_idx on ${AUTH_MODELS.verification} ("identifier")`
	}
];

/**
 * Builds the pod's auth instance.
 *
 * Email-and-password is off. A workspace signs in with a code to an address it controls, and
 * leaving a password path enabled would be a second way in that nobody configured and nobody
 * audits.
 */
export const makeAuth = (options: AuthOptions) =>
	betterAuth({
		database: makeAuthStore(options.execute),
		secret: options.secret,
		baseURL: options.baseURL,
		emailAndPassword: { enabled: false },
		user: { modelName: AUTH_MODELS.user },
		session: { modelName: AUTH_MODELS.session },
		account: { modelName: AUTH_MODELS.account },
		verification: { modelName: AUTH_MODELS.verification },
		plugins: [
			emailOTP({
				otpLength: 6,
				expiresIn: 600,
				// Three tries per code. Enough for a typo, few enough that guessing a six-digit code is
				// not a matter of patience.
				allowedAttempts: 3,
				generateOTP: () =>
					options.production
						? String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0')
						: DEVELOPMENT_SIGN_IN_CODE,
				sendVerificationOTP: async ({ email, otp, type }) => {
					// Development is deliberately silent: the code is already known, and a local stack has
					// no mailer to reach. Sending nothing is what makes that the same flow rather than a
					// special case with a different shape.
					if (!options.production) return;
					await options.deliver({ email, code: otp, purpose: type });
				}
			})
		]
	});
