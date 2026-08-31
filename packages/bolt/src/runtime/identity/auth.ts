import { betterAuth } from 'better-auth/minimal';
import { emailOTP } from 'better-auth/plugins/email-otp';
import { Effect } from 'effect';
import { AUTH_MODELS } from '#lib/authoring/system-models.js';
import { makeAuthStore, type ExecuteQuery } from '#lib/runtime/identity/auth-store.js';

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
const PLATFORM_TIMESTAMP_FIELDS = {
	createdAt: 'created_at',
	updatedAt: 'updated_at'
} as const;

/**
 * The code development signs in with.
 *
 * Fixed and never delivered, so local work needs no mailer and the flow exercised locally is the
 * same flow that ships — request a code, enter a code — rather than a bypass that skips the step.
 */
export const DEVELOPMENT_SIGN_IN_CODE = '123456';

/**
 * How long a sign-in code is redeemable.
 *
 * Exported because the durable delivery task must stop attempting once the challenge it carries can
 * no longer be redeemed. Keeping the lifetime beside Better Auth's configuration prevents the
 * persisted challenge and its courier from drifting to different clocks.
 */
export const SIGN_IN_CODE_EXPIRES_SECONDS = 600;

/**
 * What Bolt does with a code after Better Auth persists it. In the runtime this calls the host's
 * communication facility directly; the provider owns accepted-message delivery. Never called in
 * development.
 *
 * The purposes are Better Auth's own, taken from its type rather than restated: a narrower union
 * here would compile until the day a plugin sends a purpose this bolt never listed, and then fail at
 * the point of delivery instead of at the point of change.
 */
type CodePurpose = Parameters<
	NonNullable<Parameters<typeof emailOTP>[0]['sendVerificationOTP']>
>[0]['type'];

export type DeliverCode = (message: {
	readonly email: string;
	readonly code: string;
	readonly purpose: CodePurpose;
}) => Effect.Effect<void, unknown>;

type AuthOptions = Readonly<{
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
 * them, and the common model compiler derives Better Auth's Drizzle tables from those models.
 */

/**
 * Builds bolt's auth instance.
 *
 * Email-and-password is off. A workspace signs in with a code to an address it controls, and
 * leaving a password path enabled would be a second way in that nobody configured and nobody
 * audits.
 *
 * The two randomness sources are parameters rather than reads of ambient globals, so a host that
 * pins its id or code sequence can pass its own; the defaults are the platform primitives a bare
 * invocation would use anyway.
 */
export const makeAuth = (
	options: AuthOptions,
	/** Uniform source the six-digit production code is cut from; the platform RNG unless a host injects one. */
	random: () => number = Math.random,
	/** Minted when Better Auth creates one of its rows; the platform RNG unless a host injects one. */
	randomId: () => string = () => globalThis.crypto.randomUUID()
) =>
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
		advanced: { database: { generateId: randomId } },
		user: { modelName: AUTH_MODELS.user, fields: PLATFORM_TIMESTAMP_FIELDS },
		session: { modelName: AUTH_MODELS.session, fields: PLATFORM_TIMESTAMP_FIELDS },
		account: { modelName: AUTH_MODELS.account, fields: PLATFORM_TIMESTAMP_FIELDS },
		verification: { modelName: AUTH_MODELS.verification, fields: PLATFORM_TIMESTAMP_FIELDS },
		plugins: [
			emailOTP({
				otpLength: 6,
				expiresIn: SIGN_IN_CODE_EXPIRES_SECONDS,
				// Three tries per code. Enough for a typo, few enough that guessing a six-digit code is
				// not a matter of patience.
				allowedAttempts: 3,
				generateOTP: () =>
					options.production
						? String(Math.floor(random() * 1_000_000)).padStart(6, '0')
						: DEVELOPMENT_SIGN_IN_CODE,
				sendVerificationOTP: ({ email, otp, type }) => {
					// Development is deliberately silent: the code is already known, and a local stack has
					// no mailer to reach. Sending nothing is what makes that the same flow rather than a
					// special case with a different shape.
					return Effect.runPromise(
						options.production ? options.deliver({ email, code: otp, purpose: type }) : Effect.void
					);
				}
			})
		]
	});
