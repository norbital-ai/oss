import { betterAuth } from 'better-auth';
import { emailOTP } from 'better-auth/plugins';
import { makeAuthStore, type ExecuteQuery } from './auth-store.js';

/**
 * Identity for bolt, owned by bolt.
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
 * How bolt asks its host to deliver a code. Never called in development, where nothing is sent.
 *
 * The purposes are Better Auth's own, taken from its type rather than restated: a narrower union
 * here would compile until the day a plugin sends a purpose this bolt never listed, and then fail at
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
 * Identity's tables are declared in `system-collections.ts`, as collections.
 *
 * There is no `AUTH_SCHEMA` here any more. It was a hand-written `create table` per model, rendered
 * beside a second declaration of the same columns — so the schema had two authors and a test between
 * them. The collections are the one declaration now: the schema plan creates them, `verify` checks
 * them, and `auth-tables.ts` maps Better Auth's field names onto the columns they produce.
 */

/**
 * Builds bolt's auth instance.
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
		/**
		 * Ids are UUIDs, because the workspace references them.
		 *
		 * Better Auth's own default is a random string of its choosing, which is fine for a library that
		 * owns its tables outright — but these are joined to from workspace collections whose keys are
		 * `uuid`, so the value has to be one. Generated here rather than defaulted in the column so the
		 * library still decides when a row exists and what it is called; only the shape is the
		 * platform's.
		 */
		advanced: { database: { generateId: () => globalThis.crypto.randomUUID() } },
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
