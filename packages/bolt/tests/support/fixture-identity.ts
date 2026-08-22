import { createHash } from 'node:crypto';
import { NORMAL_STATUS, type SubjectStatus } from '../../src/runtime/identity/identity.js';

/**
 * The `id` a fixture's readable user id becomes.
 *
 * Identity is an ordinary collection, so its key is `id uuid` — the type a workspace's own
 * `owner_id` references. Fixtures still name people `u1` or `user-admin-token`, because a test that
 * reads back a random uuid says nothing about who it is; the SQL casts that name through `md5()` to
 * a uuid, and this is the same derivation in TypeScript so an assertion can name the person too.
 */
export const fixtureUserId = (name: string): string => {
	const digest = createHash('md5').update(name).digest('hex');
	return [
		digest.slice(0, 8),
		digest.slice(8, 12),
		digest.slice(12, 16),
		digest.slice(16, 20),
		digest.slice(20)
	].join('-');
};

/**
 * The `id` a team's name becomes, derived rather than allocated — the same trade the user
 * ids above make, and for the same reason.
 *
 * A person belongs to one team by `team_id uuid`, so a fixture that wanted to place somebody used to
 * have to insert the team, read the generated key back, and thread it through every later statement.
 * Deriving it from the name means a session, an external subject and the team row itself can each be
 * written independently and still agree, and the name in the fixture is the name the workspace's
 * `+teams.ts` declares — so what a test is asserting stays readable as a team, not as a uuid.
 */
export const fixtureTeamId = (name: string): string => fixtureUserId(name);

/**
 * The harness surface these fixtures need, which is a database and nothing else.
 *
 * Structural on purpose: seeding identity is SQL against a provisioned schema, so binding it to
 * `BoltTestRuntime` would only make the helpers unusable from a suite that builds its database
 * another way, and would put an import cycle between the two support modules.
 */
type Seedable = Readonly<{
	readonly database: {
		readonly query: (
			sql: string,
			parameters?: ReadonlyArray<unknown>
		) => Promise<ReadonlyArray<Record<string, unknown>>>;
	};
}>;

/**
 * A team, by name.
 *
 * Idempotent, because `seedSession` and `seedExternalSubject` both mint the team a subject names —
 * a fixture that only wants somebody placed should not have to remember to create the team first,
 * and one that wants a hierarchy can declare the tree here and have the later calls agree with it
 * rather than fight it.
 *
 * A team row carries a name and a position and nothing about authority: which policies the name
 * holds is declared in the workspace and compiled into the release. So the name seeded here has to
 * be one the workspace under test declares in its `teams` map — a team the release does not name is
 * inert, holds nothing, and would make a test about access fail for a reason that is not the one it
 * was written to check.
 */
export const seedTeam = async (
	harness: Seedable,
	name: string,
	options: {
		/** The parent team, by name. Its row has to exist already — the hierarchy is inserted downward. */
		readonly parent?: string;
	} = {}
): Promise<void> => {
	await harness.database.query(
		`insert into bolt_team ("id", "name", "parent_id")
		 values ($1::uuid, $2, $3::uuid) on conflict do nothing`,
		[fixtureTeamId(name), name, options.parent === undefined ? null : fixtureTeamId(options.parent)]
	);
};

/**
 * A person in a tenant, and a live session naming them — the fixture nearly every command test opens
 * with, because a `Command` carries a bearer token and the runtime resolves it against real rows.
 *
 * `team` is one name or none, because `bolt_auth_user.team_id` is one team. It replaces the `roles`
 * array these fixtures used to write: authority is a team's, and a team's policies are declared in
 * the release rather than stored on the person, so a fixture that wants a subject holding the
 * `manager` policy names the team that declares it. Omitting it is a real state and often the honest
 * one — somebody nobody has placed holds no policies at all.
 *
 * `status` is the other half, and deliberately separate. Administration is a property of the person
 * rather than of any group, so it is a column with a `'normal'` default: a caller who says nothing
 * gets an ordinary member, and naming it is the only way to make an administrator.
 */
export const seedSession = async (
	harness: Seedable,
	options: {
		/** The bearer token the invocation will carry. */
		readonly token: string;
		/** The readable name of the person, hashed to their `id` by `fixtureUserId`. */
		readonly user: string;
		readonly team?: string;
		readonly tenantId?: string;
		readonly email?: string;
		readonly status?: SubjectStatus;
	}
): Promise<void> => {
	if (options.team !== undefined) await seedTeam(harness, options.team);
	await harness.database.query(
		`with person as (
			insert into bolt_auth_user ("id", "name", "email", "tenantId", "team_id", "status")
			values (md5($2::text)::uuid, $2, $4, $3, $5::uuid, $6)
			on conflict ("id") do update set
				"email" = excluded."email",
				"tenantId" = excluded."tenantId",
				"team_id" = excluded."team_id",
				"status" = excluded."status"
			returning "id" as id
		 )
		 insert into bolt_auth_session ("id", "token", "userId", "expiresAt")
		 select gen_random_uuid(), $1, person.id, now() + interval '1 hour' from person`,
		[
			options.token,
			options.user,
			options.tenantId ?? 'test-tenant',
			options.email ?? `${options.user}@example.test`,
			options.team === undefined ? null : fixtureTeamId(options.team),
			options.status ?? NORMAL_STATUS
		]
	);
};

/**
 * The identity a host resolves by provider and external id — a Colony operator's member, say — which
 * is not a session and carries no token.
 *
 * `user_id` is stored as given rather than hashed. The column is `text` and the value is the host's
 * own identifier for the person, so a fixture that pushed it through `fixtureUserId` would be
 * asserting on a uuid nothing outside the fixture could name.
 */
export const seedExternalSubject = async (
	harness: Seedable,
	options: {
		readonly externalId: string;
		readonly userId: string;
		readonly team?: string;
		readonly provider?: string;
		readonly tenantId?: string;
		readonly email?: string;
	}
): Promise<void> => {
	if (options.team !== undefined) await seedTeam(harness, options.team);
	await harness.database.query(
		`insert into bolt_external_subjects (provider, external_id, user_id, tenant_id, team_id, email)
		 values ($1, $2, $3, $4, $5::uuid, $6)`,
		[
			options.provider ?? 'colony',
			options.externalId,
			options.userId,
			options.tenantId ?? 'test-tenant',
			options.team === undefined ? null : fixtureTeamId(options.team),
			options.email ?? `${options.userId}@example.test`
		]
	);
};
