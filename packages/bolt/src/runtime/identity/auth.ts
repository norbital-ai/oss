import { betterAuth } from 'better-auth';
import { emailOTP } from 'better-auth/plugins';
import { makeAuthStore, type ExecuteQuery } from './auth-store.js';

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
	{
		/**
		 * Better Auth's own columns, plus the three the workspace authorizes with.
		 *
		 * `tenantId`, `roles` and `teams` are Bolt's concepts, not Better Auth's, and they sit here
		 * rather than in a second table because the alternative is the arrangement being removed: two
		 * stores that must agree about who someone is, and eventually do not. Better Auth never reads
		 * or writes them — it manages only the fields it declared — so the two coexist without either
		 * owning the other's meaning.
		 *
		 * `email` is nullable and `kind` exists so a non-person subject can be represented honestly. A
		 * host provisioner is not a person, and the previous design gave it one: a row called
		 * `admin-1` carrying a real employee's address. A service row with no email and `kind` of
		 * `service` says what it is instead of impersonating somebody.
		 */
		id: 'bolt:auth-user',
		sql: `create table if not exists ${AUTH_MODELS.user} (id text primary key, "name" text not null, "email" text unique, "emailVerified" boolean not null default false, "image" text, "kind" text not null default 'person', "tenantId" text, "roles" jsonb not null default '[]'::jsonb, "teams" jsonb not null default '[]'::jsonb, "createdAt" timestamptz not null default now(), "updatedAt" timestamptz not null default now())`
	},
	{
		id: 'bolt:auth-user-session',
		sql: `create table if not exists ${AUTH_MODELS.session} (id text primary key, "expiresAt" timestamptz not null, "token" text not null unique, "createdAt" timestamptz not null default now(), "updatedAt" timestamptz not null default now(), "ipAddress" text, "userAgent" text, "userId" text not null references ${AUTH_MODELS.user}(id) on delete cascade)`
	},
	{
		id: 'bolt:auth-user-account',
		sql: `create table if not exists ${AUTH_MODELS.account} (id text primary key, "accountId" text not null, "providerId" text not null, "userId" text not null references ${AUTH_MODELS.user}(id) on delete cascade, "accessToken" text, "refreshToken" text, "idToken" text, "accessTokenExpiresAt" timestamptz, "refreshTokenExpiresAt" timestamptz, "scope" text, "password" text, "createdAt" timestamptz not null default now(), "updatedAt" timestamptz not null default now())`
	},
	{
		id: 'bolt:auth-verification',
		sql: `create table if not exists ${AUTH_MODELS.verification} (id text primary key, "identifier" text not null, "value" text not null, "expiresAt" timestamptz not null, "createdAt" timestamptz not null default now(), "updatedAt" timestamptz not null default now())`
	},
	{
		/**
		 * Where the pod keeps the secret that signs its sessions.
		 *
		 * In the database, generated on first use, rather than injected by the host. That is what
		 * "self-sustaining" has to mean for a secret: a host-supplied one makes the pod depend on the
		 * host having configured something, and two hosts configuring it differently would invalidate
		 * each other's sessions for the same workspace.
		 */
		id: 'bolt:auth-config',
		sql: `create table if not exists bolt_auth_config (key text primary key, value text not null, "createdAt" timestamptz not null default now())`
	},
	{
		// The lookup every code check performs. Without it, verification degrades to a sequential scan
		// over every code the workspace has ever issued.
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
