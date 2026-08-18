import { is, SQL } from 'drizzle-orm';
import { boolean, getTableConfig, jsonb, PgDialect, pgTable, text, timestamp, type PgTable } from 'drizzle-orm/pg-core';

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

/**
 * Where the pod keeps the secret that signs its sessions.
 *
 * In the database, generated on first use, rather than injected by the host. That is what
 * "self-sustaining" has to mean for a secret: a host-supplied one makes the pod depend on the host
 * having configured something, and two hosts configuring it differently would invalidate each
 * other's sessions for the same workspace.
 */
export const boltAuthConfig = pgTable('bolt_auth_config', {
	key: text('key').primaryKey(),
	value: text('value').notNull(),
	createdAt: timestamp('createdAt', { withTimezone: true }).notNull().defaultNow()
});

/** The schema handed to Better Auth, keyed by the model names it asks for. */
export const authSchema = {
	bolt_auth_user: boltAuthUser,
	bolt_auth_session: boltAuthSession,
	bolt_auth_account: boltAuthAccount,
	bolt_auth_verification: boltAuthVerification
};

/**
 * `create table if not exists` for a Drizzle table.
 *
 * The DDL a host applies to a virgin database used to be written out by hand beside these
 * definitions — the same columns, in the same order, spelled twice, with only a test standing
 * between them and drift. Rendering it from the table removes the second copy rather than guarding
 * it: there is now one declaration, and the SQL is a projection of it.
 *
 * It renders what these tables actually use and nothing more. A general Postgres DDL emitter is
 * drizzle-kit's job, and pulling that into the runtime to serve four tables would be the larger
 * mistake; anything this does not understand — a composite primary key, a partial index — is not
 * silently dropped but has no expression here yet, and the tables are all `pgTable`s a reader can
 * check against the SQL below.
 */
export const createTableSql = (table: PgTable): string => {
	const config = getTableConfig(table);
	const dialect = new PgDialect();
	const columns = config.columns.map((column) => {
		const parts = [`"${column.name}"`, column.getSQLType()];
		if (column.primary) parts.push('primary key');
		if (column.notNull && !column.primary) parts.push('not null');
		if (column.isUnique) parts.push('unique');
		if (column.hasDefault && column.default !== undefined) {
			parts.push(`default ${renderDefault(column.default, column.getSQLType(), dialect)}`);
		}
		// `onDelete` is on the key, not on the reference it builds, so the two are read together.
		const foreignKey = config.foreignKeys.find((key) => {
			const entry = key.reference();
			return entry.columns.length === 1 && entry.columns[0]?.name === column.name;
		});
		if (foreignKey !== undefined) {
			const entry = foreignKey.reference();
			const target = entry.foreignColumns[0];
			if (target !== undefined) {
				const onDelete = foreignKey.onDelete === undefined ? '' : ` on delete ${foreignKey.onDelete}`;
				parts.push(`references ${getTableConfig(entry.foreignTable).name}(${target.name})${onDelete}`);
			}
		}
		return parts.join(' ');
	});
	return `create table if not exists ${config.name} (${columns.join(', ')})`;
};

/**
 * A column default as Postgres must read it.
 *
 * `now()` arrives as a Drizzle `SQL` fragment and is rendered through the dialect that produced it,
 * rather than matched as a string — the fragment is the authoritative form, and comparing text would
 * break the first time a default is written any other way. Everything else is a literal, and a jsonb
 * one has to be cast: `'[]'` alone is text, and Postgres will not take text for jsonb.
 */
const renderDefault = (value: unknown, sqlType: string, dialect: PgDialect): string => {
	if (is(value, SQL)) return dialect.sqlToQuery(value).sql;
	if (typeof value === 'boolean' || typeof value === 'number') return String(value);
	if (sqlType === 'jsonb') return `'${JSON.stringify(value)}'::jsonb`;
	return `'${String(value).replace(/'/g, "''")}'`;
};
