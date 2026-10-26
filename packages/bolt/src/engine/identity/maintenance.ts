import { Effect, Schema } from 'effect';
import {
	answer,
	catalogOf,
	compile,
	read as decodeRead,
	schema,
	type Row,
	type store
} from '@norbital-ai/store';
import { catalog, tableOf } from '../../protocol/catalog.ts';
import { BoltError, fromStore } from '../../protocol/errors.ts';
import { splitModel } from '../../decl/model.ts';
import user from '../../system/data/model/sys_user/+model.ts';
import type { Rows } from '../contracts.ts';
import type { TenantDbShape } from '../db/tenant-db.ts';
import type { EngineManifest } from '../manifest.ts';

const declaration = schema({
	sys_user: {
		...tableOf(splitModel(user.name, user.spec).model),
		fields: user.spec.fields,
		computed: user.spec.computed,
		key: user.spec.table.primary
	}
});
const contacts = catalogOf(declaration);
type User = Row<typeof declaration, 'sys_user'>;
export type DirectoryPerson = Pick<User, 'email' | 'phone'>;
export type DirectoryMember = Pick<User, 'email' | 'phone' | 'team'> & { readonly user: string };
export type AdministeredMember = Pick<User, 'id' | 'name' | 'email' | 'active'>;
const Id: Schema.Codec<Pick<User, 'id'>> = Schema.Struct({ id: Schema.String });
const Person: Schema.Codec<DirectoryPerson> = Schema.Struct({
	email: Schema.NullOr(Schema.String),
	phone: Schema.NullOr(Schema.String)
});
const Member: Schema.Codec<Pick<User, 'id' | 'email' | 'phone' | 'team'>> = Schema.Struct({
	id: Schema.String,
	email: Schema.NullOr(Schema.String),
	phone: Schema.NullOr(Schema.String),
	team: Schema.NullOr(Schema.String)
});
const Administered: Schema.Codec<AdministeredMember> = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	email: Schema.NullOr(Schema.String),
	active: Schema.Boolean
});
type Query = Parameters<ReturnType<typeof store<typeof declaration>>['read']>[1];
const prepare = (query: Query) =>
	decodeRead(contacts, 'sys_user', { ...query }).pipe(
		Effect.flatMap((ir) =>
			compile(contacts, ir).pipe(Effect.map((compiled) => ({ ir, compiled })))
		),
		Effect.mapError(fromStore)
	);
const decode = <A>(
	schema: Schema.Decoder<A>,
	prepared: Effect.Success<ReturnType<typeof prepare>>,
	rows: Rows | undefined
) =>
	answer(prepared.ir, prepared.compiled, rows?.rows.map((row) => row['j'] ?? null) ?? []).pipe(
		Effect.mapError(fromStore),
		Effect.flatMap((page) =>
			Schema.decodeUnknownEffect(Schema.Struct({ rows: Schema.Array(schema) }))(page).pipe(
				Effect.mapError((cause) => BoltError.make('internal', 'decode', cause.message)),
				Effect.map((page) => page.rows)
			)
		)
	);

/** Host identity reads compile from the system model's source declaration, including its indexed contact keys. */
export const directory = (db: TenantDbShape) => {
	const read = <A>(schema: Schema.Decoder<A>, query: Query) =>
		Effect.gen(function* () {
			const prepared = yield* prepare(query);
			const [answer] = yield* db.read([prepared.compiled.sql]);
			return yield* decode(schema, prepared, answer);
		});
	return {
		memberOf: (person: DirectoryPerson) =>
			Effect.gen(function* () {
				const email = person.email?.trim() ?? '';
				if (email !== '') {
					const rows = yield* read(Id, {
						where: { active: { eq: true }, email: { folded: email } },
						select: { id: true },
						limit: 1
					});
					if (rows[0] !== undefined) return rows[0].id;
				}
				const phone = person.phone?.replace(/\D/g, '') ?? '';
				if (phone === '') return null;
				const rows = yield* read(Id, {
					where: { active: { eq: true }, phone_key: { eq: phone } },
					select: { id: true },
					limit: 1
				});
				return rows[0]?.id ?? null;
			}),
		personOf: (id: string) =>
			read(Person, {
				where: { id: { eq: id } },
				select: { email: true, phone: true },
				limit: 1
			}).pipe(Effect.map((rows) => rows[0] ?? null)),
		members: read(Member, {
			where: {
				active: { eq: true },
				or: [{ email: { isNull: false } }, { phone: { isNull: false } }]
			},
			select: { id: true, email: true, phone: true, team: true },
			all: true
		}).pipe(
			Effect.map((rows): readonly DirectoryMember[] =>
				rows.map(({ id, ...person }) => ({ user: id, ...person }))
			)
		),
		administered: (email: string) =>
			Effect.gen(function* () {
				const gate = yield* prepare({
					where: { active: { eq: true }, admin: { eq: true }, email: { folded: email } },
					select: { id: true },
					limit: 1
				});
				const members = yield* prepare({
					select: { id: true, name: true, email: true, active: true },
					orderBy: ['name', 'id'],
					all: true
				});
				// Authorization and its projection share one read snapshot.
				const answers = yield* db.read([gate.compiled.sql, members.compiled.sql]);
				if ((yield* decode(Id, gate, answers[0])).length === 0) return null;
				return yield* decode(Administered, members, answers[1]);
			})
	};
};

/** A business restore carries the current identity state, including users without sessions and agent tags. */
export const captureIdentity = (db: TenantDbShape) =>
	db.value(Schema.String, {
		text: `SELECT jsonb_build_object('users', COALESCE((SELECT jsonb_agg(to_jsonb(u)) FROM sys_user u), '[]'::jsonb), 'sessions', COALESCE((SELECT jsonb_agg(to_jsonb(s)) FROM sys_session s), '[]'::jsonb))::text`,
		params: []
	});

const q = (name: string) => `"${name.replaceAll('"', '""')}"`;
export const restoreIdentity = (db: TenantDbShape, manifest: EngineManifest, snapshot: string) => {
	const models = catalog(manifest).models;
	const columns = (table: string) =>
		[...(models.get(table)?.fields.values() ?? [])]
			.filter((field) => field.computed !== true && field.derived !== true)
			.map((field) => field.column);
	const users = columns('sys_user'),
		sessions = columns('sys_session');
	const update = users
		.filter((name) => name !== 'id' && name !== 'revision' && name !== 'created_at')
		.map((name) => `${q(name)} = EXCLUDED.${q(name)}`);
	return db
		.transaction({
			statements: [
				{ text: 'DELETE FROM sys_session', params: [] },
				// Clear unique contacts before reassignment; target-only principals remain inactive for historical references.
				{
					text: 'UPDATE sys_user SET email = NULL, phone = NULL, active = false, admin = false, team = NULL, party = NULL, revision = revision + 1',
					params: []
				},
				{
					text: `INSERT INTO sys_user (${users.map(q).join(', ')}) SELECT ${users.map(q).join(', ')} FROM jsonb_populate_recordset(NULL::sys_user, $1::jsonb->'users') ON CONFLICT (id) DO UPDATE SET ${update.join(', ')}, revision = greatest(sys_user.revision, EXCLUDED.revision) + 1`,
					params: [snapshot]
				},
				{
					text: `INSERT INTO sys_session (${sessions.map(q).join(', ')}) SELECT ${sessions.map(q).join(', ')} FROM jsonb_populate_recordset(NULL::sys_session, $1::jsonb->'sessions')`,
					params: [snapshot]
				}
			]
		})
		.pipe(Effect.asVoid);
};

export const markAdmitted = (db: TenantDbShape) =>
	db
		.write({
			text: 'INSERT INTO bolt_run_admitted (at) SELECT now() WHERE NOT EXISTS (SELECT 1 FROM bolt_run_admitted)',
			params: []
		})
		.pipe(Effect.asVoid);
