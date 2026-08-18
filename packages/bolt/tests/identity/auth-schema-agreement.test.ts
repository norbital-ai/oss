import { describe, expect, it } from 'vitest';
import { AUTH_MODELS, AUTH_SCHEMA } from '../../src/runtime/identity/auth.js';
import {
	authSchema,
	boltAuthConfig,
	createTableSql
} from '../../src/runtime/identity/auth-tables.js';

/**
 * What the renderer emits, pinned.
 *
 * The DDL and the Drizzle tables used to be two hand-written descriptions of one schema, and the
 * test here compared them for drift. They are one description now — the SQL is rendered from the
 * tables — so drift between them is not a thing that can happen and there is nothing left to
 * compare. What replaces it is the risk that moved: a change to `createTableSql` silently altering
 * the schema every host applies, which nothing else would catch until a column was missing on a
 * database somebody had already provisioned.
 *
 * So these assert the emitted text. A deliberate schema change updates them in the same commit, and
 * that diff is the point — it is the one place a reviewer sees the DDL actually change.
 */
describe('identity schema', () => {
	it('renders the user table', () => {
		expect(createTableSql(authSchema.bolt_auth_user)).toBe(
			'create table if not exists bolt_auth_user ("id" text primary key, "name" text not null, ' +
				'"email" text unique, "emailVerified" boolean not null default false, "image" text, ' +
				`"kind" text not null default 'person', "tenantId" text, ` +
				`"roles" jsonb not null default '[]'::jsonb, "teams" jsonb not null default '[]'::jsonb, ` +
				'"createdAt" timestamp with time zone not null default now(), ' +
				'"updatedAt" timestamp with time zone not null default now())'
		);
	});

	it('renders the session table, with the cascade to its user', () => {
		expect(createTableSql(authSchema.bolt_auth_session)).toBe(
			'create table if not exists bolt_auth_session ("id" text primary key, ' +
				'"expiresAt" timestamp with time zone not null, "token" text not null unique, ' +
				'"createdAt" timestamp with time zone not null default now(), ' +
				'"updatedAt" timestamp with time zone not null default now(), "ipAddress" text, ' +
				'"userAgent" text, "userId" text not null references bolt_auth_user(id) on delete cascade)'
		);
	});

	it('renders the verification table', () => {
		expect(createTableSql(authSchema.bolt_auth_verification)).toBe(
			'create table if not exists bolt_auth_verification ("id" text primary key, ' +
				'"identifier" text not null, "value" text not null, ' +
				'"expiresAt" timestamp with time zone not null, ' +
				'"createdAt" timestamp with time zone not null default now(), ' +
				'"updatedAt" timestamp with time zone not null default now())'
		);
	});

	it('renders the config table', () => {
		expect(createTableSql(boltAuthConfig)).toBe(
			'create table if not exists bolt_auth_config ("key" text primary key, ' +
				'"value" text not null, "createdAt" timestamp with time zone not null default now())'
		);
	});

	/**
	 * A child table must sort after the table it references.
	 *
	 * The plan applies steps in sorted id order, so `bolt:auth-session` would have run before
	 * `bolt:auth-user` and failed on a fresh database — which is why the child's id names its parent.
	 */
	it('orders every step after the table it references', () => {
		// Sorted, because that is the order the plan applies them in — not the order they are written
		// here, which is only how a reader meets them.
		const applied = AUTH_SCHEMA.map((step) => step.id).sort();
		const at = (id: string) => applied.indexOf(id);
		expect(at('bolt:auth-user')).toBeLessThan(at('bolt:auth-user-session'));
		expect(at('bolt:auth-user')).toBeLessThan(at('bolt:auth-user-account'));
		expect(at('bolt:auth-verification')).toBeLessThan(at('bolt:auth-verification-identifier'));
	});

	it('creates every table identity authenticates through', () => {
		for (const name of Object.values(AUTH_MODELS)) {
			expect(
				AUTH_SCHEMA.some((step) => step.sql.startsWith(`create table if not exists ${name} (`)),
				`no create-table step for ${name}`
			).toBe(true);
		}
	});
});
