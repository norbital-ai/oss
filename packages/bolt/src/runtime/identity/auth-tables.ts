import { boolean, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Better Auth's view of identity's tables.
 *
 * These are not a second declaration of the schema. `system-collections.ts` declares identity as
 * ordinary runtime-owned collections — that is what creates the tables, what `verify` checks, and
 * what a workspace relates to — and this maps Better Auth's field names onto the columns those
 * collections produce. Nothing here renders DDL; drizzle-kit and the schema plan own that, as they
 * do for every other collection.
 *
 * The mapping is the whole point. Better Auth requires a model with `id`, `createdAt` and
 * `updatedAt`; a Bolt collection is keyed by `norbital_id` and stamped with `norbital_created_at`
 * and `norbital_updated_at`. Drizzle names the property and the column separately, so one table
 * satisfies both contracts and there is no second `user` shadowing an auth table — which is the
 * arrangement identity was moved into bolt to remove.
 */

/** The columns every collection carries, under the names Better Auth expects to find them. */
const identityColumns = {
	id: uuid('norbital_id').primaryKey().defaultRandom(),
	createdAt: timestamp('norbital_created_at', { withTimezone: true }).notNull().defaultNow(),
	updatedAt: timestamp('norbital_updated_at', { withTimezone: true }).notNull().defaultNow()
};

export const boltAuthUser = pgTable('bolt_auth_user', {
	...identityColumns,
	name: text('name').notNull(),
	email: text('email'),
	emailVerified: boolean('emailVerified').notNull(),
	image: text('image'),
	/** A host provisioner is not a person; `service` with a null email says so rather than pretending. */
	kind: text('kind').notNull(),
	/**
	 * Whether this person administers the workspace — `normal` or `admin`. Bolt's concept, which
	 * Better Auth never reads, and mapped here for the same reason `kind`, `tenantId`, `roles` and
	 * `teams` are: this is Better Auth's view of the whole table, and a column the collection declares
	 * but the view omits is drift no type check can see.
	 */
	status: text('status').notNull(),
	/** The workspace this subject belongs to — Bolt's concept, which Better Auth never reads. */
	tenantId: text('tenantId'),
	roles: jsonb('roles').notNull(),
	teams: jsonb('teams').notNull()
});

export const boltAuthSession = pgTable('bolt_auth_session', {
	...identityColumns,
	expiresAt: timestamp('expiresAt', { withTimezone: true }).notNull(),
	token: text('token').notNull(),
	ipAddress: text('ipAddress'),
	userAgent: text('userAgent'),
	userId: uuid('userId').notNull()
});

export const boltAuthAccount = pgTable('bolt_auth_account', {
	...identityColumns,
	accountId: text('accountId').notNull(),
	providerId: text('providerId').notNull(),
	userId: uuid('userId').notNull(),
	accessToken: text('accessToken'),
	refreshToken: text('refreshToken'),
	idToken: text('idToken'),
	accessTokenExpiresAt: timestamp('accessTokenExpiresAt', { withTimezone: true }),
	refreshTokenExpiresAt: timestamp('refreshTokenExpiresAt', { withTimezone: true }),
	scope: text('scope'),
	password: text('password')
});

export const boltAuthVerification = pgTable('bolt_auth_verification', {
	...identityColumns,
	identifier: text('identifier').notNull(),
	value: text('value').notNull(),
	expiresAt: timestamp('expiresAt', { withTimezone: true }).notNull()
});

/** The schema handed to Better Auth, keyed by the model names it asks for. */
export const authSchema = {
	bolt_auth_user: boltAuthUser,
	bolt_auth_session: boltAuthSession,
	bolt_auth_account: boltAuthAccount,
	bolt_auth_verification: boltAuthVerification
};
