import { boolean, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Identity's tables, declared the way every other table in a workspace is declared.
 *
 * Collections are Drizzle tables, so the tables the platform owns are Drizzle tables too. They were
 * hand-written DDL strings, which meant the one part of the schema nobody authored was also the one
 * part no schema tool could see: the column list lived in a template literal, the ordering between a
 * child table and its parent was maintained by hand through step-id sorting, and Better Auth read
 * those columns through an adapter that restated them a third time.
 *
 * The prefix is deliberate. Better Auth's defaults are `user`, `session`, `account` and
 * `verification` — names a tenant's own workspace is entitled to use, and a workspace with a `user`
 * collection would otherwise share a table with the auth system and corrupt both.
 *
 * Column names are quoted camelCase because that is the shape Better Auth reads and writes. Aliasing
 * snake_case back on every query would put a translation layer between the library and its own
 * schema, and that layer is where a mismatch hides.
 */
export const boltAuthUser = pgTable('bolt_auth_user', {
	id: text('id').primaryKey(),
	name: text('name').notNull(),
	email: text('email').unique(),
	emailVerified: boolean('emailVerified').notNull().default(false),
	image: text('image'),
	/**
	 * What kind of subject this is.
	 *
	 * A host provisioner is not a person, and the design this replaced gave it one: a row called
	 * `admin-1` carrying a real employee's address. `service` with a null email says what it is
	 * instead of impersonating somebody.
	 */
	kind: text('kind').notNull().default('person'),
	/**
	 * The workspace this subject belongs to — Bolt's concept, not Better Auth's.
	 *
	 * It sits on this row rather than in a second table because the alternative is the arrangement
	 * being removed: two stores that must agree about who someone is, and eventually do not. Better
	 * Auth manages only the fields it declared, so the two coexist without either owning the other's
	 * meaning.
	 */
	tenantId: text('tenantId'),
	roles: jsonb('roles').notNull().default([]),
	teams: jsonb('teams').notNull().default([]),
	createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
	updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow()
});

export const boltAuthSession = pgTable('bolt_auth_session', {
	id: text('id').primaryKey(),
	expiresAt: timestamp('expiresAt', { withTimezone: true }).notNull(),
	token: text('token').notNull().unique(),
	createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
	updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow(),
	ipAddress: text('ipAddress'),
	userAgent: text('userAgent'),
	userId: text('userId')
		.notNull()
		.references(() => boltAuthUser.id, { onDelete: 'cascade' })
});

export const boltAuthAccount = pgTable('bolt_auth_account', {
	id: text('id').primaryKey(),
	accountId: text('accountId').notNull(),
	providerId: text('providerId').notNull(),
	userId: text('userId')
		.notNull()
		.references(() => boltAuthUser.id, { onDelete: 'cascade' }),
	accessToken: text('accessToken'),
	refreshToken: text('refreshToken'),
	idToken: text('idToken'),
	accessTokenExpiresAt: timestamp('accessTokenExpiresAt', { withTimezone: true }),
	refreshTokenExpiresAt: timestamp('refreshTokenExpiresAt', { withTimezone: true }),
	scope: text('scope'),
	password: text('password'),
	createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
	updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow()
});

export const boltAuthVerification = pgTable('bolt_auth_verification', {
	id: text('id').primaryKey(),
	identifier: text('identifier').notNull(),
	value: text('value').notNull(),
	expiresAt: timestamp('expiresAt', { withTimezone: true }).notNull(),
	createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow(),
	updatedAt: timestamp('updatedAt', { withTimezone: true }).notNull().defaultNow()
});

/** The schema handed to Better Auth, keyed by the model names it asks for. */
export const authSchema = {
	bolt_auth_user: boltAuthUser,
	bolt_auth_session: boltAuthSession,
	bolt_auth_account: boltAuthAccount,
	bolt_auth_verification: boltAuthVerification
};
