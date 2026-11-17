// What a host reads of a workspace branch without its release: the recovery storage contract. A host must know who
// belongs to a workspace, who administers it and whether it has links to reopen even while the release that owns the
// database cannot load (or is not worth booting), so these reads use the branch's durable storage through this one
// adapter. The contract is exactly these durable fields:
//
// - `bolt_schema`: one row; `slice -> 'tables' -> <table>` is the applied schema's store `TableSpec` of each table below.
// - `sys_user`, keyed `text`: `name` text; `email`, `phone` and `team` optional text; `active` and `admin` bool;
//   `phone_key` computed text, `phone`'s digits (`regex_replace(phone, '\D', '')`).
// - `sys_integration`, keyed `text`: `active` bool.
// - `bolt_credential`: `instance`, the `sys_integration` id each sealed credential belongs to (an engine table every
//   schema apply re-asserts with the `bolt_schema` row).
//
// Every read admits the branch first, in the same snapshot as its rows: the applied slice must declare these fields as
// written here. Another layout, a missing table or column, or no applied schema refuses `UnknownStorage`; nothing is
// guessed. A release that changes any of these fields changes `HOST_API_VERSION`.
import { Effect, Schema } from 'effect';
import type { DbError } from './errors.ts';
import type { RawDb, Rows, Sql } from './db.ts';

/** A `sys_user` row as a host reads it from a branch database, without entering the release. */
export const HostUser = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	email: Schema.NullOr(Schema.String),
	phone: Schema.NullOr(Schema.String),
	team: Schema.NullOr(Schema.String),
	active: Schema.Boolean
});
export type HostUser = typeof HostUser.Type;
/** The branch's storage is not the recovery contract's (another layout, or no applied schema). */
export class UnknownStorage extends Schema.TaggedError<UnknownStorage>()('UnknownStorage', {
	message: Schema.String
}) {}

const field = <K extends string>(kind: K) => Schema.Struct({ kind: Schema.Literal(kind) });
const optional = <K extends string>(kind: K) =>
	Schema.Struct({ kind: Schema.Literal(kind), optional: Schema.Literal(true) });
const Users = Schema.Struct({
	key: Schema.Literal('text'),
	fields: Schema.Struct({
		name: field('text'),
		email: optional('text'),
		phone: optional('text'),
		team: optional('text'),
		active: field('bool'),
		admin: field('bool')
	}),
	computed: Schema.Struct({
		phone_key: Schema.Struct({
			kind: Schema.Literal('text'),
			expr: Schema.Struct({
				regex_replace: Schema.Tuple([
					Schema.Struct({ field: Schema.Literal('phone') }),
					Schema.Literal('\\D'),
					Schema.Literal('')
				])
			})
		})
	})
});
const Instances = Schema.Struct({
	key: Schema.Literal('text'),
	fields: Schema.Struct({ active: field('bool') })
});
/** undefined_table, undefined_column: the layout is not the contract's. */
const UNDEFINED = new Set(['42P01', '42703']);
const USERS = 'SELECT id, name, email, phone, team, active FROM sys_user';

/** `statements`' answers, read in one snapshot after `table`'s applied layout is admitted. */
const admitted = (
	db: RawDb,
	table: string,
	layout: Schema.Decoder<unknown>,
	statements: readonly Sql[]
): Effect.Effect<readonly Rows[], DbError | UnknownStorage> =>
	db
		.read([
			{ text: "SELECT slice -> 'tables' -> $1::text AS layout FROM bolt_schema", params: [table] },
			...statements
		])
		.pipe(
			Effect.mapError((error): DbError | UnknownStorage =>
				UNDEFINED.has(error.sqlstate) ? new UnknownStorage({ message: error.message }) : error
			),
			Effect.flatMap(([applied, ...answers]) =>
				applied?.rows.length === 1 && Schema.is(layout)(applied.rows[0]?.['layout'])
					? Effect.succeed(answers)
					: Effect.fail(
							new UnknownStorage({
								message: `the applied schema does not declare ${table} as the recovery storage contract`
							})
						)
			)
		);
const decoded = <A>(row: Schema.Decoder<A>) => (answer: Rows | undefined) =>
	Schema.decodeUnknownEffect(Schema.Array(row))(answer?.rows ?? []).pipe(
		Effect.mapError((issue) => new UnknownStorage({ message: issue.message }))
	);

/** The recovery storage contract's reads of one branch database; each is one snapshot and one round trip. */
export const branch_storage = (db: RawDb) => {
	const users = (statements: readonly Sql[]) =>
		admitted(db, 'sys_user', Users, statements).pipe(Effect.flatMap(Effect.forEach(decoded(HostUser))));
	return {
		/** The active member `person` is: by email (any case), else by their number's digits; `null` for none. */
		member: (person: { readonly email: string | null; readonly phone: string | null }) =>
			users([
				{
					text: `${USERS} WHERE active AND (lower(email) = lower($1) OR phone_key = $2) ORDER BY lower(email) = lower($1) DESC NULLS LAST LIMIT 1`,
					params: [person.email?.trim() || null, person.phone?.replace(/\D/g, '') || null]
				}
			]).pipe(Effect.map(([found]) => found?.[0] ?? null)),
		/** The member `id`, active or not; `null` for none. */
		user: (id: string) =>
			users([{ text: `${USERS} WHERE id = $1`, params: [id] }]).pipe(
				Effect.map(([found]) => found?.[0] ?? null)
			),
		/** Every active member with an email or a number. */
		members: users([
			{ text: `${USERS} WHERE active AND (email IS NOT NULL OR phone IS NOT NULL)`, params: [] }
		]).pipe(Effect.map(([found]) => found ?? [])),
		/** Every member, when `email` is an active administrator's; else `null`. The gate and the list share a snapshot. */
		administered: (email: string) =>
			users([
				{ text: `${USERS} WHERE active AND admin AND lower(email) = lower($1) LIMIT 1`, params: [email] },
				{ text: `${USERS} ORDER BY name, id`, params: [] }
			]).pipe(Effect.map(([gate, all]) => ((gate ?? []).length === 0 ? null : (all ?? [])))),
		/** Whether an active instance holds credentials: the links a host reopens. */
		paired: admitted(db, 'sys_integration', Instances, [
			{
				text: 'SELECT EXISTS (SELECT 1 FROM sys_integration i WHERE i.active AND EXISTS (SELECT 1 FROM bolt_credential c WHERE c.instance = i.id)) AS paired',
				params: []
			}
		]).pipe(
			Effect.flatMap(([answer]) => decoded(Schema.Struct({ paired: Schema.Boolean }))(answer)),
			Effect.map(([row]) => row?.paired === true)
		)
	};
};
