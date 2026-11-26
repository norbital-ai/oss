// The recovery storage contract on PGlite: a host finds members, an administrator's projection and paired links in a
// branch without its release, each in one snapshot, and refuses `UnknownStorage` for any other applied layout.
import { describe, expect, layer } from '@effect/vitest';
import { Effect } from 'effect';
import type { DbError } from '../src/errors.ts';
import { PgliteDb, Pristine } from '../src/node/db/pglite.ts';
import { branch_storage, type UnknownStorage } from '../src/storage.ts';

const USERS = {
	key: 'text',
	record_label: 'record.name',
	fields: {
		name: { kind: 'text' },
		email: { kind: 'text', format: 'email', optional: true },
		phone: { kind: 'text', optional: true },
		active: { kind: 'bool', default: true },
		admin: { kind: 'bool', default: false }
	},
	computed: {
		phone_key: { kind: 'text', expr: { regex_replace: [{ field: 'phone' }, '\\D', ''] } }
	}
};
const INSTANCES = { key: 'text', fields: { active: { kind: 'bool', default: true } } };
const slice = (users: object) => ({
	tables: { sys_user: users, sys_integration: INSTANCES },
	tz: 'UTC',
	currency: null
});
const STORAGE = `
	CREATE TABLE bolt_schema (one bool PRIMARY KEY DEFAULT true, fingerprint text NOT NULL, slice jsonb NOT NULL);
	CREATE TABLE sys_user (id text PRIMARY KEY, name text NOT NULL, email text, phone text,
		active boolean NOT NULL DEFAULT true, admin boolean NOT NULL DEFAULT false,
		phone_key text GENERATED ALWAYS AS (regexp_replace(phone, '\\D', '', 'g')) STORED);
	CREATE TABLE sys_integration (id text PRIMARY KEY, active boolean NOT NULL);
	CREATE TABLE bolt_credential (instance text NOT NULL, name text NOT NULL);
	INSERT INTO sys_user (id, name, email, phone, active, admin) VALUES
		('p-admin', 'Boss', 'Boss@people.test', NULL, true, true),
		('p-email', 'Email', 'Match@people.test', '+65 1111 2222', true, false),
		('p-phone', 'Phone', NULL, '+65 1234 5678', true, false),
		('p-inactive', 'Inactive', 'old@people.test', NULL, false, true);
	INSERT INTO sys_integration VALUES ('paired', true), ('paused', false);
	INSERT INTO bolt_credential VALUES ('paused', 'creds');
`;
/** A scoped PGlite branch holding the contract's storage, its applied slice declaring `users`. */
const branch = (users: object = USERS) =>
	Effect.gen(function* () {
		const pg = yield* PgliteDb.open();
		yield* Effect.promise(() => pg.exec(STORAGE));
		const db = PgliteDb.make(pg);
		yield* db.write({
			text: "INSERT INTO bolt_schema (fingerprint, slice) VALUES ('synthetic', $1::jsonb)",
			params: [JSON.stringify(slice(users))]
		});
		return db;
	});

layer(Pristine.layer)('recovery storage contract', (it) => {
	describe('members', () => {
		it.effect('finds a member by email first, then by their number, never an inactive one', () =>
			Effect.gen(function* () {
				const storage = branch_storage(yield* branch());
				expect(
					(yield* storage.member({ email: ' match@people.test ', phone: '65-12345678' }))?.id
				).toBe('p-email');
				expect(
					(yield* storage.member({ email: 'missing@people.test', phone: '65 1234 5678' }))?.id
				).toBe('p-phone');
				expect(yield* storage.member({ email: 'old@people.test', phone: null })).toBeNull();
				expect(yield* storage.user('p-phone')).toEqual({
					id: 'p-phone',
					name: 'Phone',
					email: null,
					phone: '+65 1234 5678',
					active: true
				});
				expect((yield* storage.members).map((member) => member.id).sort()).toEqual([
					'p-admin',
					'p-email',
					'p-phone'
				]);
			}).pipe(Effect.scoped)
		);
		it.effect('projects every member only for an active administrator', () =>
			Effect.gen(function* () {
				const storage = branch_storage(yield* branch());
				expect((yield* storage.administered('boss@people.test'))?.map((member) => member.id)).toEqual(
					['p-admin', 'p-email', 'p-inactive', 'p-phone']
				);
				expect(yield* storage.administered('match@people.test')).toBeNull();
				// an inactive administrator holds no recovery access
				expect(yield* storage.administered('old@people.test')).toBeNull();
			}).pipe(Effect.scoped)
		);
		it.effect('reopens links only for an active instance holding credentials', () =>
			Effect.gen(function* () {
				const db = yield* branch();
				const storage = branch_storage(db);
				expect(yield* storage.paired).toBe(false);
				yield* db.write({ text: "INSERT INTO bolt_credential VALUES ('paired', 'creds')", params: [] });
				expect(yield* storage.paired).toBe(true);
			}).pipe(Effect.scoped)
		);
	});
	describe('unknown storage', () => {
		it.effect('refuses a branch with no applied schema', () =>
			Effect.gen(function* () {
				const storage = branch_storage(PgliteDb.make(yield* PgliteDb.open()));
				const reads: readonly Effect.Effect<unknown, DbError | UnknownStorage>[] = [
					storage.members,
					storage.paired,
					storage.administered('boss@people.test')
				];
				for (const read of reads)
					expect(yield* Effect.flip(read)).toMatchObject({ _tag: 'UnknownStorage' });
			}).pipe(Effect.scoped)
		);
		it.effect('refuses an applied layout that is not the contract, guessing nothing', () =>
			Effect.gen(function* () {
				const { admin: _admin, ...withoutAdmin } = USERS.fields;
				for (const users of [
					{ ...USERS, fields: withoutAdmin },
					{ ...USERS, key: 'uuid' },
					{ ...USERS, fields: { ...USERS.fields, email: { kind: 'text' } } },
					{
						...USERS,
						computed: { phone_key: { kind: 'text', expr: { lower: { field: 'phone' } } } }
					}
				]) {
					const storage = branch_storage(yield* branch(users));
					expect(yield* Effect.flip(storage.administered('boss@people.test'))).toMatchObject({
						_tag: 'UnknownStorage'
					});
					expect(yield* Effect.flip(storage.member({ email: 'boss@people.test', phone: null }))).toMatchObject({
						_tag: 'UnknownStorage'
					});
				}
			}).pipe(Effect.scoped)
		);
	});
});
