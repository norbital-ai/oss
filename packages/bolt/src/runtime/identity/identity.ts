import { Context, Effect, Layer, Schema } from 'effect';
import { EffectId } from '@norbital-ai/bolt-protocol';
import { Communication, IdentityHooks } from '../facilities/services.js';
import { Database } from '../facilities/database.js';
import { AUTH_MODELS, makeAuth } from './auth.js';
import { identitiesOf, identityMatches } from '../channels/transport-identity.js';

export const Subject = Schema.Struct({
	userId: Schema.NonEmptyString,
	tenantId: Schema.NonEmptyString,
	/**
	 * The one team this subject belongs to, by name, or absent when nobody has placed them.
	 *
	 * This is what an approval step matches: `step.approvers` names teams, and a subject is eligible
	 * when its team is among them. One team, not a set — every combination of authority anybody
	 * actually holds is a named team in `+teams.ts` rather than an emergent union nobody wrote down.
	 */
	team: Schema.optionalKey(Schema.NonEmptyString),
	/**
	 * The team names whose declared policies this subject holds: its own team first, then the teams
	 * beneath it in the hierarchy.
	 *
	 * Names, not policies. The mapping from a team name to the policies it holds is authored — it
	 * lives in the compiled release, not in a row — so only `AccessControl` resolves it, and identity
	 * stays ignorant of what any policy grants.
	 */
	teamPath: Schema.Array(Schema.NonEmptyString),
	/**
	 * Whether this is the host acting under a verified gateway signature rather than a person.
	 *
	 * Minted by `SystemPrincipal.systemSubject` and by nothing else. It is a `MINTED_IDENTITY` field,
	 * so a payload claiming it is refused rather than honoured, and no database column produces it.
	 */
	system: Schema.optionalKey(Schema.Boolean),
	email: Schema.optionalKey(Schema.NonEmptyString),
	/**
	 * Whether this subject administers the workspace, from `bolt_auth_user.status`.
	 *
	 * Optional, and absent means `normal`. That polarity is the whole point: every construction of a
	 * subject that predates this field — an external subject, a test fixture, a machine invocation —
	 * reads as an ordinary user rather than as an administrator, so the failure mode of forgetting to
	 * set it is a refusal rather than a grant.
	 */
	admin: Schema.optionalKey(Schema.Boolean),
	impersonatedBy: Schema.optionalKey(Schema.NonEmptyString)
});
export interface Subject extends Schema.Schema.Type<typeof Subject> {}

/** Reads the loosely-typed values a SQL row hands back without scattering guards through the projection. */
const IdentityRows = {
	text: (row: unknown, field: string): string | undefined => {
		const value = row === null || typeof row !== 'object' ? undefined : Reflect.get(row, field);
		return typeof value === 'string' && value.length > 0 ? value : undefined;
	},
	strings: (row: unknown, field: string): ReadonlyArray<string> => {
		const value = row === null || typeof row !== 'object' ? undefined : Reflect.get(row, field);
		return Array.isArray(value)
			? value.filter((entry): entry is string => typeof entry === 'string')
			: [];
	}
};

/**
 * Whether a string is shaped like the `norbital_id` an identity row is keyed by.
 *
 * Checked before the value reaches a statement, because `$1::uuid` on anything else is a *database*
 * error — a 500 with a Postgres sentence in it — where the honest answer to "delete the team called
 * `nonsense`" is that there is no such team. A caller naming a malformed id gets the same refusal
 * as one naming an id that is merely absent, which is the same thing from where they stand.
 */
const RECORD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isRecordId = (value: string): boolean => RECORD_ID_PATTERN.test(value);

/** Every column a team is read back as, spelled once so the four writes cannot project it differently. */
const TEAM_COLUMNS = `"norbital_id"::text as "id", "name", "parent_id"::text as "parentId", "description"`;

/**
 * The subtree under one team, bounded exactly as `TEAM_TREE_SQL` is and for the same reason.
 *
 * Used to refuse a re-parent that would put a team inside its own subtree. The bound is not
 * redundant with that refusal: these commands are what stops a *new* cycle being made, and a row
 * written before they existed can already be in one — so the walk that detects it must terminate on
 * a graph that is already cyclic.
 */
const TEAM_SUBTREE_SQL = `with recursive tree as (
	select "norbital_id" as id, 1 as depth from bolt_team where "norbital_id" = $1::uuid
	union all
	select c."norbital_id", p.depth + 1 from bolt_team c join tree p on c."parent_id" = p.id
	 where p.depth < 8
)
select 1 from tree where id = $2::uuid limit 1`;

/**
 * The two values `bolt_auth_user.status` may hold, named once so no call site spells them.
 *
 * `admit` writes one of them, `subjectFromRow` compares against one of them, and the collection
 * declares the default; three string literals in three files is how the third one drifts.
 */
export const ADMIN_STATUS = 'admin';
export const NORMAL_STATUS = 'normal';
export type SubjectStatus = typeof ADMIN_STATUS | typeof NORMAL_STATUS;

/**
 * Projects a subject row into the shape `Subject` describes.
 *
 * `email` is nullable in both subject tables and `startSession` writes no email at all, so the
 * column comes back as an explicit null — which an optional key rejects, and every session the
 * service itself started failed to authenticate as `malformed`. An unknown email is an *absent*
 * key, not a null one, which is already how `workspaceAccess` reads the same column; widening
 * `Subject` instead would push null-handling onto every consumer of an authenticated subject.
 *
 * The team name and the resolved path come from the join in the query above, so a row that belongs
 * to nobody projects an empty path — which holds no policy, which is the correct answer.
 *
 * A row missing `userId` or `tenantId` still fails to decode — those stay `NonEmptyString`, so a
 * genuinely malformed row is still refused rather than admitted as an anonymous subject.
 */
const subjectFromRow = (row: unknown): Record<string, unknown> => {
	const email = IdentityRows.text(row, 'email');
	const impersonatedBy = IdentityRows.text(row, 'impersonatedBy');
	const team = IdentityRows.text(row, 'team');
	const teamPath = IdentityRows.strings(row, 'teamPath');
	return {
		userId: IdentityRows.text(row, 'userId'),
		tenantId: IdentityRows.text(row, 'tenantId'),
		teamPath,
		...(team === undefined ? {} : { team }),
		// Exactly one spelling counts. A column that is null, absent, misspelled or holding anything
		// else at all is an ordinary user, so a projection that forgets to select `status` cannot
		// promote everybody it returns.
		admin: IdentityRows.text(row, 'status') === ADMIN_STATUS,
		...(email === undefined ? {} : { email }),
		...(impersonatedBy === undefined ? {} : { impersonatedBy })
	};
};

/**
 * The team hierarchy, walked in the same round trip that authenticates.
 *
 * A subject's authority is its team's declared policies plus the policies of every team beneath it.
 * Resolving that with a second query would put another round trip on the authentication path, and a
 * round trip out of a guest isolate is the most expensive thing this runtime does: writing 89 rows
 * through one that made one per row cost 18 seconds.
 *
 * **Descent is unconditional, and a `bolt_team.inherits` flag used to gate it.** The flag defaulted
 * to off, on the reasoning that `rowPredicate` unions grants so composition can only ever widen —
 * one unconditional grant anywhere beneath a team collapsed a narrowing declared above it, with no
 * diff to look at. That reasoning still describes what happens; what changed is that it is now the
 * intent rather than a hazard. Somebody above sees what somebody below can see — that is what being
 * above means, and a per-team opt-in made it a property each row remembered to have rather than a
 * property of the hierarchy.
 *
 * Note what this does *not* do, because it is the thing most likely to be misread: inheriting a
 * policy is not inheriting its rows. A grant scoped `${requestor.norbital_id}` re-evaluates against
 * whoever is asking, so a manager holding a report's self-scoped policy sees their *own* records.
 * Reaching a report's rows is a predicate written against the team subtree — see
 * `requestor.team_scope_users` in `access-control.ts` — not a consequence of descending here.
 *
 * The depth bound is not defensive dressing. `parent_id` is a graph an operator edits from a
 * dashboard, so it can be made cyclic, and a recursive CTE over a cycle does not fail — it runs
 * until something else stops it. Eight levels is far above any real hierarchy, the same bound and
 * the same reasoning as `HOOK_NESTING_LIMIT`.
 */
const TEAM_TREE_SQL = `, tree as (
	select t."norbital_id" as id, t."name" as name, 1 as depth
	  from bolt_team t join subject on t."norbital_id" = subject."team_id"
	union all
	select c."norbital_id", c."name", p.depth + 1
	  from bolt_team c join tree p on c."parent_id" = p.id
	 where p.depth < 8
)`;

/**
 * The projection every subject read ends in: the row, its team's name, and the resolved path.
 *
 * `teamPath` is ordered by depth so the subject's own team is first — the order a diagnostic reads
 * best in, and the order `AccessControl` reports when it explains why something was allowed.
 */
const SUBJECT_TAIL_SQL = `select subject.*,
	(select tree.name from tree where tree.depth = 1) as "team",
	coalesce((select json_agg(tree.name order by tree.depth) from tree), '[]'::json) as "teamPath"
	from subject`;

const EXTERNAL_SUBJECT_SQL = `with recursive subject as (
	select user_id as "userId", tenant_id as "tenantId", email, team_id as "team_id", null as "status"
	  from bolt_external_subjects
	 where provider = $1 and external_id = $2
)${TEAM_TREE_SQL} ${SUBJECT_TAIL_SQL}`;

const AUTHENTICATE_SQL = `with recursive subject as (
	select u."norbital_id" as "userId", u."tenantId" as "tenantId",
	       u."email" as "email", u."status" as "status", u."team_id" as "team_id"
	  from ${AUTH_MODELS.session} s
	  join ${AUTH_MODELS.user} u on u."norbital_id" = s."userId"
	 where s."token" = $1 and s."expiresAt" > now()
)${TEAM_TREE_SQL} ${SUBJECT_TAIL_SQL}`;

/**
 * One account by address, through the same team join a session goes through.
 *
 * It exists for channel principals, which are rows identified by an undeliverable address rather
 * than by a credential — there is no session to authenticate and no external provider to resolve,
 * so neither query above reaches them. Everything downstream of the projection is identical, which
 * is the point: a principal's `teamPath` is resolved by the same recursive walk as a person's, so
 * `AccessControl` cannot tell the two apart and a channel is held to the same policy resolution
 * every request is.
 *
 * **No credential is checked, because there is none.** This is a lookup, not an authentication, and
 * it is not reachable from a command: it has no case in `dispatch.ts` and is called only by
 * `Channels.receive`, which reaches it with a name the *release* supplied — a channel's own
 * principal address — never with anything from a message. An address from a payload must never
 * arrive here; that would be a way to become anybody by naming them.
 */
const SUBJECT_BY_EMAIL_SQL = `with recursive subject as (
	select u."norbital_id" as "userId", u."tenantId" as "tenantId",
	       u."email" as "email", u."status" as "status", u."team_id" as "team_id"
	  from ${AUTH_MODELS.user} u
	 where u."email" = $1 and u."status" <> 'disabled'
)${TEAM_TREE_SQL} ${SUBJECT_TAIL_SQL}`;

/** Carries authentication error through the typed identity failure channel without losing diagnostic context. */
export class AuthenticationError extends Schema.TaggedError<AuthenticationError>()(
	'Bolt.Identity.AuthenticationError',
	{
		reason: Schema.Literals(['invalid', 'expired', 'revoked', 'malformed'])
	}
) {
	readonly category = 'authentication' as const;
}

/**
 * A team as an operator sees it: a name, a position in the tree, and nothing about authority.
 *
 * There is deliberately no policy field and no way to add one. Which policies a team holds is
 * declared in the workspace's `+teams.ts` and compiled into the release, so it can only change by
 * deploying one — a row that granted a policy would be a privilege escalation performed with an
 * `update` statement, in a place no diff, no review and no type check can see.
 */
export type TeamRecord = Readonly<{
	readonly id: string;
	readonly name: string;
	readonly parentId?: string;
	readonly description?: string;
}>;

/** The fields a new team is created with. Everything but the name is optional and defaults to none. */
export type TeamDraft = Readonly<{
	readonly name: string;
	readonly parentId?: string | null;
	readonly description?: string | null;
}>;

/**
 * What an edit changes, where an absent key means "leave it alone" and an explicit `null` clears it.
 *
 * The two have to be distinguishable: renaming a team must not silently unparent it, and moving a
 * team to the root must be expressible. An optional key that can also hold `null` is the only shape
 * that says both.
 */
export type TeamChanges = Readonly<{
	readonly name?: string;
	readonly parentId?: string | null;
	readonly description?: string | null;
}>;

/**
 * What a team write answers.
 *
 * A refusal is a *value* rather than a typed failure because every one of them is the caller naming
 * a state that is not there — a team that does not exist, a name somebody else already holds, a
 * team that still has people in it. The boundary turns it into the `invalid_input` it already has,
 * which is the 400 those answers deserve; a new error class would mean a new arm in `app.ts`'s
 * error match for a class of answer the runtime already knows how to report.
 */
export type TeamOutcome =
	| Readonly<{ readonly _tag: 'Team'; readonly team: TeamRecord }>
	| Readonly<{ readonly _tag: 'Refused'; readonly reason: string }>;

/** The same, for moving a person: `team` is absent when they were taken out of every team. */
export type TeamAssignment =
	| Readonly<{ readonly _tag: 'Assigned'; readonly memberId: string; readonly team?: TeamRecord }>
	| Readonly<{ readonly _tag: 'Refused'; readonly reason: string }>;

export type Interface = Readonly<{
	readonly authenticate: (
		effectId: EffectId,
		credential: string
	) => Effect.Effect<Subject, AuthenticationError | Database.FacilityError>;
	readonly resolveSubject: (
		effectId: EffectId,
		provider: string,
		externalId: string
	) => Effect.Effect<Subject, AuthenticationError | Database.FacilityError>;
	/**
	 * One account by address, for a subject that has no credential to present — a channel principal.
	 *
	 * The address must come from the release, never from a payload. See `SUBJECT_BY_EMAIL_SQL`.
	 */
	readonly subjectByEmail: (
		effectId: EffectId,
		email: string
	) => Effect.Effect<Subject, AuthenticationError | Database.FacilityError>;
	/**
	 * The account that has proven ownership of this address on this transport, or nothing.
	 *
	 * Answers `userId` and `email` and deliberately not a `Subject`. A subject carries a `teamPath`,
	 * and this person's team is exactly what an inbound channel message must *not* inherit: their
	 * authority on a channel is the channel's declared policy, held through the channel's own
	 * principal, whatever they hold in the web app. Returning half an identity is what makes that
	 * impossible to get wrong by accident downstream.
	 *
	 * Nothing, rather than a failure, when no account matches: an unrecognised sender is an ordinary
	 * and expected state on a channel anyone can message, not a fault.
	 */
	readonly accountByTransportIdentity: (
		effectId: EffectId,
		transport: string,
		senderAddress: string
	) => Effect.Effect<
		Readonly<{ readonly userId: string; readonly email?: string }> | undefined,
		Database.FacilityError
	>;
	readonly admit: (
		effectId: EffectId,
		tenantId: string,
		email: string,
		/** The team to place them in, or `null` for nobody — see `admitFounder`. */
		teamId: string | null,
		status: SubjectStatus
	) => Effect.Effect<string, Database.FacilityError>;
	readonly invite: (
		effectId: EffectId,
		tenantId: string,
		email: string,
		invitedBy: string
	) => Effect.Effect<string, Database.FacilityError | Database.FacilityError>;
	readonly acceptInvitation: (
		effectId: EffectId,
		invitationId: string,
		userId: string
	) => Effect.Effect<void, AuthenticationError | Database.FacilityError>;
	/** Sends a sign-in code to an address. Bolt issues it; the host only carries it. */
	readonly sendCode: (
		effectId: EffectId,
		email: string
	) => Effect.Effect<void, Database.FacilityError>;
	/** Exchanges a code for a session credential, or refuses it. */
	readonly verifyCode: (
		effectId: EffectId,
		email: string,
		code: string,
		tenantId: string
	) => Effect.Effect<string, AuthenticationError | Database.FacilityError>;
	/** Refuses an unknown subject, so the failure channel carries `AuthenticationError` too. */
	readonly startSession: (
		effectId: EffectId,
		userId: string,
		tenantId: string
	) => Effect.Effect<string, AuthenticationError | Database.FacilityError>;
	readonly endSession: (
		effectId: EffectId,
		credential: string
	) => Effect.Effect<void, Database.FacilityError>;
	readonly workspaceSettings: (
		effectId: EffectId,
		tenantId: string
	) => Effect.Effect<Schema.Json, Database.FacilityError>;
	/** Who belongs to the workspace, what is outstanding, and what has changed. */
	readonly workspaceAccess: (
		effectId: EffectId,
		tenantId: string
	) => Effect.Effect<WorkspaceAccess, Database.FacilityError>;
	/**
	 * The four writes an operator makes against `bolt_team`, and the whole of what they can change.
	 *
	 * Between them they shape the tree and decide who is in it, and that is the entire surface: no
	 * argument here names a policy, because what a team may *do* lives in the compiled release. Each
	 * takes the acting subject's id so the `bolt_audit` row it writes names a person — the same
	 * ledger `impersonateTeam` writes to, and the one `workspaceAccess` reads back as `events`.
	 */
	readonly createTeam: (
		effectId: EffectId,
		tenantId: string,
		actorId: string,
		draft: TeamDraft
	) => Effect.Effect<TeamOutcome, Database.FacilityError>;
	readonly updateTeam: (
		effectId: EffectId,
		tenantId: string,
		actorId: string,
		teamId: string,
		changes: TeamChanges
	) => Effect.Effect<TeamOutcome, Database.FacilityError>;
	readonly deleteTeam: (
		effectId: EffectId,
		tenantId: string,
		actorId: string,
		teamId: string
	) => Effect.Effect<TeamOutcome, Database.FacilityError>;
	/** Moves one person between teams, or out of every team when `teamId` is `null`. */
	readonly assignTeam: (
		effectId: EffectId,
		tenantId: string,
		actorId: string,
		memberId: string,
		teamId: string | null
	) => Effect.Effect<TeamAssignment, Database.FacilityError>;
}>;

/** The workspace-access projection the settings surfaces render. */
export type WorkspaceAccess = Readonly<{
	readonly members: ReadonlyArray<
		Readonly<{
			id: string;
			email: string;
			name: string;
			role: string;
			status: string;
			/** The one team they belong to, absent for nobody. */
			team?: string;
		}>
	>;
	readonly invitations: ReadonlyArray<
		Readonly<{
			id: string;
			email: string;
			role: string;
			status: string;
			invitedBy?: string;
			expiresAt?: string;
		}>
	>;
	/**
	 * Every team in the workspace, read from `bolt_team` rather than derived from who is in one.
	 *
	 * Derived would mean an empty team does not exist — and an empty team is precisely what an
	 * operator has to be able to see: it is what a freshly declared `approvers` name reconciles into,
	 * and putting somebody in it is the fix.
	 */
	readonly teams: ReadonlyArray<
		Readonly<{ id: string; name: string; parentId?: string; description?: string }>
	>;
	readonly events: ReadonlyArray<
		Readonly<{ id: string; action: string; actor: string; subject?: string; at: string }>
	>;
}>;

/** Identifies the identity service in Effect's context so dependency wiring remains explicit and type checked. */
/**
 * The subject this invocation authenticated as, for anything downstream that must act *for* them.
 *
 * Provided by dispatch after `authenticate` succeeds, so it cannot be asserted by a caller — which
 * is the distinction that matters. `secrets.write` and `secrets.status` once read the subject out of
 * their own request body, so naming another user was enough to reach their data; a subject that only
 * exists once a credential has been checked cannot be spoofed that way.
 *
 * Absent for invocations that have no person behind them — scheduled tasks, activations, the health
 * probe. A facility that needs one must refuse those rather than invent a default.
 */
export const CurrentSubject = Context.Service<Subject>('@norbital-ai/bolt/CurrentSubject');

/** The authenticated subject, or `None` for machine-run work. */
export const currentSubject = Effect.serviceOption(CurrentSubject);

export const Service = Context.Service<Interface>('@norbital-ai/bolt/Identity');

/**
 * Identity, told whether its host can deliver a message.
 *
 * Bolt cannot read an environment variable to learn it is running locally, and should not: it is
 * the same bundle everywhere. What differs is the capability the host binds. A host that binds no
 * communication facility cannot deliver a code, so a random one would be unusable and nobody could
 * sign in at all — there, the fixed development code is the only value that makes the flow work.
 *
 * Stated as "can this host deliver" rather than "is this development", because that is the fact
 * being acted on, and it stays true for any host rather than for one deployment's idea of a mode.
 */
export const layerWith = (canDeliver: boolean) =>
	Layer.effect(
		Service,
		Effect.gen(function* () {
			const database = yield* Database.Service;
			const communication = yield* Communication.Service;
			const identityHooks = yield* IdentityHooks.Service;
			const readSubject = Effect.fn('Identity.readSubject')(function* (
				effectId: EffectId,
				sql: string,
				parameters: ReadonlyArray<Schema.Json>
			) {
				const result = yield* database.execute(effectId, { _tag: 'Query', sql, parameters });
				const first = result.rows[0];
				if (first === undefined) return yield* new AuthenticationError({ reason: 'invalid' });
				return yield* Schema.decodeUnknownEffect(Subject)(subjectFromRow(first)).pipe(
					Effect.mapError(() => new AuthenticationError({ reason: 'malformed' }))
				);
			});
			/**
			 * Runs Better Auth for one invocation.
			 *
			 * Built per call rather than once, because `execute` has to carry this invocation's effect id
			 * — that is what ties every statement the auth library runs to the request that caused it, in
			 * the host's own facility log. A single long-lived instance would launder them all under
			 * whichever effect id happened to construct it.
			 */
			const authFor = Effect.fn('Identity.authFor')(function* (effectId: EffectId) {
				yield* database.execute(effectId, {
					_tag: 'Query',
					// Two v4 UUIDs rather than `gen_random_bytes`, which lives in pgcrypto — an extension a
					// host is under no obligation to have installed, and did not. `gen_random_uuid` is core
					// Postgres, and two of them are 64 hex characters carrying ~244 bits of entropy.
					// `where not exists` rather than `on conflict (key)`: this is an ordinary collection now, so
					// it is keyed by `norbital_id` and `key` carries an index but no unique constraint for a
					// conflict target to match. Concurrent callers race to insert and the loser's row is
					// harmless — the select below takes whichever secret is there, and both are valid.
					sql: `insert into bolt_auth_config ("key", "value") select 'session-secret', replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '') where not exists (select 1 from bolt_auth_config where "key" = 'session-secret')`,
					parameters: []
				});
				const stored = yield* database.execute(effectId, {
					_tag: 'Query',
					sql: `select "value" from bolt_auth_config where "key" = 'session-secret' limit 1`,
					parameters: []
				});
				const secret = IdentityRows.text(stored.rows[0], 'value');
				if (secret === undefined) return yield* new AuthenticationError({ reason: 'malformed' });
				return makeAuth({
					secret,
					baseURL: 'https://bolt.invalid',
					production: canDeliver,
					execute: (sql, parameters) =>
						Effect.runPromise(
							database
								.execute(effectId, {
									_tag: 'Query',
									sql,
									parameters: parameters as ReadonlyArray<Schema.Json>
								})
								.pipe(
									Effect.map((result) => ({
										rows: result.rows as ReadonlyArray<Record<string, unknown>>,
										affectedRows: result.affectedRows
									}))
								)
						),
					deliver: (message) =>
						Effect.runPromise(
							communication
								.execute(effectId, {
									_tag: 'Send',
									channel: 'email',
									recipient: message.email,
									payload: {
										subject: 'Your sign-in code',
										body: `Your sign-in code is ${message.code}. It expires in 10 minutes.`
									}
								})
								.pipe(
									Effect.asVoid,
									Effect.catch(() => Effect.void)
								)
						)
				});
			});

			/** The projection every team write answers with, read off the row the statement returned. */
			const teamFromRow = (row: unknown): TeamRecord => {
				const parentId = IdentityRows.text(row, 'parentId');
				const description = IdentityRows.text(row, 'description');
				return {
					id: IdentityRows.text(row, 'id') ?? 'unknown',
					name: IdentityRows.text(row, 'name') ?? 'unknown',
					...(parentId === undefined ? {} : { parentId }),
					...(description === undefined ? {} : { description })
				};
			};
			const readTeam = Effect.fn('Identity.readTeam')(function* (
				effectId: EffectId,
				teamId: string
			) {
				if (!isRecordId(teamId)) return undefined;
				const found = yield* database.execute(effectId, {
					_tag: 'Query',
					sql: `select ${TEAM_COLUMNS} from bolt_team where "norbital_id" = $1::uuid`,
					parameters: [teamId]
				});
				const row = found.rows[0];
				return row === undefined ? undefined : teamFromRow(row);
			});
			/**
			 * The trace a team write leaves, in the ledger `workspaceAccess` already reads back.
			 *
			 * `bolt_audit` rather than an identity hook, because the hook facility carries membership
			 * events about *people* — `UserChanged`, `MembershipChanged` — and has no event for a team's
			 * own lifecycle. A host does not need told that a team was renamed; the workspace's own
			 * activity list does, and that is what this feeds.
			 */
			const recordTeamEvent = Effect.fn('Identity.recordTeamEvent')(function* (
				effectId: EffectId,
				kind: string,
				actorId: string,
				payload: Readonly<Record<string, Schema.Json>>
			) {
				yield* database.execute(effectId, {
					_tag: 'Query',
					sql: 'insert into bolt_audit (kind, subject_id, payload) values ($1, $2, $3)',
					parameters: [kind, actorId, payload]
				});
			});
			return Service.of({
				/**
				 * Resolves the credential against Better Auth's session table, which is the only session
				 * store bolt has.
				 *
				 * There was a second one — `bolt_sessions` — written by Bolt here and *also* written
				 * directly over `pg` by the host. Two writers and two shapes for one fact is what let a
				 * hardcoded token stay valid forever and a fabricated person stay signed in. A session is
				 * now a row only Better Auth's own flows create, and expiry is the row's own column rather
				 * than a `revoked_at` the host had to remember to set.
				 */
				authenticate: Effect.fn('Identity.authenticate')((effectId, credential) =>
					readSubject(effectId, AUTHENTICATE_SQL, [credential])
				),
				/** An external provider's subject, resolved through the same team join a session is. */
				resolveSubject: Effect.fn('Identity.resolveSubject')((effectId, provider, externalId) =>
					readSubject(effectId, EXTERNAL_SUBJECT_SQL, [provider, externalId])
				),
				subjectByEmail: Effect.fn('Identity.subjectByEmail')((effectId, email) =>
					readSubject(effectId, SUBJECT_BY_EMAIL_SQL, [email])
				),
				/**
				 * The account holding a verified identity for this sender, matched in two stages.
				 *
				 * Postgres narrows to the accounts that hold *some* verified identity on this transport —
				 * a containment test an expression index can answer — and the canonical comparison happens
				 * here. It has to: `canonicalTransportIdentity` strips a WhatsApp JID's domain and every
				 * non-digit from a number, so `+65 9123 4567` and `6591234567@s.whatsapp.net` are one
				 * address, and expressing that as SQL would put the rule in two places where it must be
				 * one. The prefilter is what keeps the loop small.
				 *
				 * `kind <> 'service'` keeps channel principals out of the candidate set. A principal has
				 * no transport identities to match, so it can only be reached by a bug — and the shape of
				 * that bug would be a sender resolving to the very account whose authority the channel
				 * runs under, which is worth one predicate to make impossible.
				 */
				accountByTransportIdentity: Effect.fn('Identity.accountByTransportIdentity')(
					function* (effectId, transport, senderAddress) {
						const result = yield* database.execute(effectId, {
							_tag: 'Query',
							sql: `select u."norbital_id" as "userId", u."email" as "email", u."channels" as "channels"
						        from ${AUTH_MODELS.user} u
						       where u."kind" <> 'service'
						         and u."channels" @> $1::jsonb`,
							parameters: [JSON.stringify([{ type: transport, verified: true }])]
						});
						for (const row of result.rows) {
							const held = identitiesOf(
								row === null || typeof row !== 'object' ? undefined : Reflect.get(row, 'channels')
							);
							if (!held.some((identity) => identityMatches(identity, transport, senderAddress)))
								continue;
							const userId = IdentityRows.text(row, 'userId');
							if (userId === undefined) continue;
							const email = IdentityRows.text(row, 'email');
							return email === undefined ? { userId } : { userId, email };
						}
						return undefined;
					}
				),
				invite: Effect.fn('Identity.invite')(function* (effectId, tenantId, email, invitedBy) {
					const invitationId = `${tenantId}:${effectId}`;
					yield* database.execute(effectId, {
						_tag: 'Query',
						sql: 'insert into bolt_invitations (invitation_id, tenant_id, email, invited_by, status) values ($1, $2, $3, $4, $5) on conflict (invitation_id) do nothing',
						parameters: [invitationId, tenantId, email, invitedBy, 'pending']
					});
					yield* communication.execute(effectId, {
						_tag: 'Notify',
						recipient: email,
						payload: { kind: 'workspace_invitation', invitationId, tenantId }
					});
					yield* identityHooks.emit(effectId, {
						_tag: 'UserInvited',
						invitationId,
						organizationId: tenantId,
						email,
						invitedBy
					});
					return invitationId;
				}),
				acceptInvitation: Effect.fn('Identity.acceptInvitation')(
					function* (effectId, invitationId, userId) {
						const result = yield* database.execute(effectId, {
							_tag: 'Query',
							sql: 'update bolt_invitations set status = $2, accepted_by = $3 where invitation_id = $1 and status = $4 returning invitation_id, tenant_id, email',
							parameters: [invitationId, 'accepted', userId, 'pending']
						});
						const row = result.rows[0];
						if (row === undefined) return yield* new AuthenticationError({ reason: 'invalid' });
						const organizationId = IdentityRows.text(row, 'tenant_id');
						if (organizationId === undefined)
							return yield* new AuthenticationError({ reason: 'malformed' });
						const email = IdentityRows.text(row, 'email');
						yield* identityHooks.emit(effectId, {
							_tag: 'MembershipChanged',
							userId,
							organizationId,
							...(email === undefined ? {} : { email }),
							action: 'joined'
						});
						yield* identityHooks.emit(effectId, {
							_tag: 'UserChanged',
							userId,
							organizationId,
							...(email === undefined ? {} : { email })
						});
					}
				),
				/**
				 * Issues a sign-in code for an address.
				 *
				 * Bolt generates it, decides its lifetime and its attempt limit, and hands it to the
				 * host only to be delivered. The host never learns a valid code for an address it did not
				 * ask about, and cannot mint one — which is the difference from the arrangement this
				 * replaces, where the host generated the code and bolt was never involved.
				 */
				sendCode: Effect.fn('Identity.sendCode')(function* (effectId, email) {
					const auth = yield* authFor(effectId).pipe(Effect.catch(() => Effect.succeed(undefined)));
					if (auth === undefined) return;
					// Failure is swallowed here and only here: whether an address is already known is not
					// something a caller may learn from whether this succeeded.
					yield* Effect.tryPromise({
						try: () => auth.api.sendVerificationOTP({ body: { email, type: 'sign-in' } }),
						catch: () => undefined
					}).pipe(Effect.catch(() => Effect.void));
				}),
				/**
				 * Redeems a code and returns a credential that can actually be used.
				 *
				 * The tenant write is the difference between those two things. Better Auth owns whether the
				 * code is good and creates the user row when the address is new, but it knows nothing about
				 * `tenantId` — that column is Bolt's, and it sits on the same row precisely so authentication
				 * reads one table. Left unset, `authenticate` decodes the subject, finds no tenant, and
				 * refuses the very credential this just issued as malformed.
				 *
				 * The tenant is the invocation's, minted at the dispatch boundary from the scope bolt was
				 * addressed with; a caller cannot supply it. So this admits the verified address to the
				 * workspace whose bolt it proved the code against, and to no other.
				 */
				/**
				 * Places an address in a team in this workspace before anybody signs in as it.
				 *
				 * A workspace's first administrator is the one membership nobody inside it can grant, because
				 * there is nobody inside it yet. `verifyCode` deliberately grants nothing — it binds a tenant
				 * and no more — so without this a founder signs in perfectly and then reads 403 from every
				 * collection, which is a failure that looks like a broken sign-in and is not one.
				 *
				 * Keyed by email and written before the person exists: Better Auth creates the user row on
				 * first sign-in, and an upsert on the address means the row it finds already carries the
				 * membership rather than the two racing.
				 */
				admit: Effect.fn('Identity.admit')(function* (effectId, tenantId, email, teamId, status) {
					const admitted = yield* database.execute(effectId, {
						_tag: 'Query',
						sql: `insert into ${AUTH_MODELS.user} ("norbital_id", "name", "email", "emailVerified", "kind", "status", "tenantId", "team_id")
					      values (gen_random_uuid(), $1, $1, true, 'person', $4, $2, $3)
					      on conflict ("email") do update set
					        "tenantId" = excluded."tenantId",
					        "team_id" = excluded."team_id",
					        "status" = excluded."status",
					        "norbital_updated_at" = now()
					      returning "norbital_id" as "id"`,
						parameters: [email, tenantId, teamId, status]
					});
					const admittedId = IdentityRows.text(admitted.rows[0], 'id') ?? '';
					// The address rides along because it is the only stable name this person has across
					// organizations: identity is per-tenant, so the same human is a different `norbital_id`
					// in every workspace they belong to, and a host filing memberships by user id records
					// six strangers rather than one person in six places.
					yield* identityHooks.emit(effectId, {
						_tag: 'UserChanged',
						userId: admittedId,
						email,
						organizationId: tenantId,
						...(teamId === null ? {} : { team: teamId })
					});
					return admittedId;
				}),
				verifyCode: Effect.fn('Identity.verifyCode')(function* (effectId, email, code, tenantId) {
					const auth = yield* authFor(effectId);
					const signedIn = yield* Effect.tryPromise({
						try: () => auth.api.signInEmailOTP({ body: { email, otp: code } }),
						catch: () => new AuthenticationError({ reason: 'invalid' })
					});
					if (signedIn.token === undefined || signedIn.token.length === 0) {
						return yield* new AuthenticationError({ reason: 'invalid' });
					}
					// Matched on the session just minted rather than on the address: it is the row Better Auth
					// actually signed in, so a second user sharing the address cannot be the one admitted.
					const admitted = yield* database.execute(effectId, {
						_tag: 'Query',
						sql: `update ${AUTH_MODELS.user} set "tenantId" = $2, "norbital_updated_at" = now() where "norbital_id" = (select "userId" from ${AUTH_MODELS.session} where "token" = $1) returning "norbital_id" as "id"`,
						parameters: [signedIn.token, tenantId]
					});
					const admittedId = IdentityRows.text(admitted.rows[0], 'id');
					if (admittedId === undefined)
						return yield* new AuthenticationError({ reason: 'invalid' });
					// Same reason as `admit`: without the address the host cannot tell that the person signing
					// into this organization is the one it already knows from another.
					yield* identityHooks.emit(effectId, {
						_tag: 'UserChanged',
						userId: admittedId,
						email,
						organizationId: tenantId
					});
					return signedIn.token;
				}),
				/**
				 * Mints a session for a subject that already exists.
				 *
				 * It will not create the person. That is the whole difference from what this replaced: the
				 * old path inserted a session row naming any user id it was handed, so a caller could name
				 * somebody who had never signed in — or somebody who did not exist at all — and be them.
				 * A session for an unknown subject is now refused rather than granted.
				 */
				startSession: Effect.fn('Identity.startSession')(function* (effectId, userId, tenantId) {
					const credential = `bolt:${tenantId}:${globalThis.crypto.randomUUID()}`;
					const admitted = yield* database.execute(effectId, {
						_tag: 'Query',
						sql: `update ${AUTH_MODELS.user} set "tenantId" = $2, "norbital_updated_at" = now() where "norbital_id" = $1 returning "norbital_id" as "id"`,
						parameters: [userId, tenantId]
					});
					if (admitted.rows[0] === undefined)
						return yield* new AuthenticationError({ reason: 'invalid' });
					yield* database.execute(effectId, {
						_tag: 'Query',
						sql: `insert into ${AUTH_MODELS.session} ("norbital_id", "token", "userId", "expiresAt") values ($1, $2, $3, now() + interval '8 hours')`,
						parameters: [globalThis.crypto.randomUUID(), credential, userId]
					});
					yield* identityHooks.emit(effectId, {
						_tag: 'UserChanged',
						userId,
						organizationId: tenantId
					});
					return credential;
				}),
				endSession: Effect.fn('Identity.endSession')(function* (effectId, credential) {
					// Deleted rather than flagged revoked. A revoked row that still authenticates if one
					// query forgets the flag is the failure the old two-writer design actually had.
					yield* database.execute(effectId, {
						_tag: 'Query',
						sql: `delete from ${AUTH_MODELS.session} where "token" = $1`,
						parameters: [credential]
					});
				}),
				/**
				 * Reads the workspace's people, outstanding invitations, teams and access history.
				 *
				 * Members come from the user table, which is now the same table authentication reads. This
				 * projection used to aggregate over live sessions instead — because Bolt had no user table
				 * — so a member who had simply signed out vanished from the workspace's own access list,
				 * and the list disagreed with authentication by construction. Teams are the distinct set
				 * those members carry: they are strings on a subject, so the projection is flat and says so
				 * rather than implying a hierarchy that is not stored anywhere.
				 */
				workspaceAccess: Effect.fn('Identity.workspaceAccess')(function* (
					effectId: EffectId,
					tenantId: string
				) {
					const memberRows = yield* database.execute(effectId, {
						_tag: 'Query',
						sql: `select subjects.user_id as "id", max(subjects.email) as "email", max(t."name") as "team",
						  -- Selected, because the projection below reports an administrator off this column and
						  -- a column the query never asked for reads as absent — which is exactly \`normal\`, so
						  -- omitting it listed every administrator in the workspace as an ordinary member and
						  -- did it silently. Aggregated as \`bool_or\` rather than \`max\` because the union has
						  -- two sources and \`'normal'\` sorts after \`'admin'\`: a plain \`max\` would let an
						  -- external row demote the person's own status row.
						  case when bool_or(subjects.status = '${ADMIN_STATUS}') then '${ADMIN_STATUS}' else '${NORMAL_STATUS}' end as "status"
						  from (
							-- Cast to text so the union matches: identity is keyed by \`norbital_id uuid\`, while an
							-- external subject's id is whatever its provider calls it, and both are only ever
							-- read back out of this projection as a string.
							select "norbital_id"::text as user_id, "email", "team_id", "status" from ${AUTH_MODELS.user} where "tenantId" = $1 and "kind" = 'person'
							union all
							-- An external subject is authenticated somewhere else and \`bolt_external_subjects\`
							-- carries no status column, so it can only ever be an ordinary member — the same
							-- answer \`resolveSubject\` gives it.
							select user_id, email, team_id, '${NORMAL_STATUS}' from bolt_external_subjects where tenant_id = $1
						  ) subjects
						  left join bolt_team t on t."norbital_id" = subjects."team_id"
						  group by subjects.user_id
						  order by subjects.user_id`,
						parameters: [tenantId]
					});
					const invitationRows = yield* database.execute(effectId, {
						_tag: 'Query',
						sql: 'select invitation_id as "id", email, status, invited_by as "invitedBy" from bolt_invitations where tenant_id = $1 order by created_at desc limit 200',
						parameters: [tenantId]
					});
					const auditRows = yield* database.execute(effectId, {
						_tag: 'Query',
						sql: 'select sequence::text as "id", kind as "action", subject_id as "actor", payload, created_at as "at" from bolt_audit order by sequence desc limit 200',
						parameters: []
					});
					const members = memberRows.rows.map((row) => {
						const team = IdentityRows.text(row, 'team');
						return {
							id: IdentityRows.text(row, 'id') ?? 'unknown',
							email: IdentityRows.text(row, 'email') ?? '',
							name:
								IdentityRows.text(row, 'email')?.split('@')[0] ??
								IdentityRows.text(row, 'id') ??
								'',
							// The status column, and only it. `admin` was never a role a workspace declares and
							// is now explicitly not one; what a person may do otherwise is their team's
							// business, so this reports the team rather than guessing a tier from it.
							role: IdentityRows.text(row, 'status') === ADMIN_STATUS ? 'admin' : 'basic',
							status: 'active',
							...(team === undefined ? {} : { team })
						};
					});
					const teamRows = yield* database.execute(effectId, {
						_tag: 'Query',
						sql: 'select "norbital_id"::text as "id", "name", "parent_id"::text as "parentId", "description" from bolt_team order by "name"',
						parameters: []
					});
					return {
						members,
						invitations: invitationRows.rows.map((row) => {
							const invitedBy = IdentityRows.text(row, 'invitedBy');
							return {
								id: IdentityRows.text(row, 'id') ?? 'unknown',
								email: IdentityRows.text(row, 'email') ?? '',
								role: 'basic',
								status: IdentityRows.text(row, 'status') ?? 'pending',
								...(invitedBy === undefined ? {} : { invitedBy })
							};
						}),
						teams: teamRows.rows.map((row) => {
							const parentId = IdentityRows.text(row, 'parentId');
							const description = IdentityRows.text(row, 'description');
							return {
								id: IdentityRows.text(row, 'id') ?? 'unknown',
								name: IdentityRows.text(row, 'name') ?? 'unknown',
								...(parentId === undefined ? {} : { parentId }),
								...(description === undefined ? {} : { description })
							};
						}),
						events: auditRows.rows.map((row) => {
							const payload = Reflect.get(Object(row), 'payload');
							// `team` is third because the entries that carry one — every `teams.*` write, and
							// the impersonation row that names a previewed team — have no collection and no
							// request behind them, and without it they render in the activity list as an
							// action by somebody against nothing.
							const subject = Schema.is(Schema.Record(Schema.String, Schema.Json))(payload)
								? (IdentityRows.text(payload, 'collection') ??
									IdentityRows.text(payload, 'requestId') ??
									IdentityRows.text(payload, 'team'))
								: undefined;
							return {
								id: IdentityRows.text(row, 'id') ?? 'unknown',
								action: IdentityRows.text(row, 'action') ?? 'unknown',
								actor: IdentityRows.text(row, 'actor') ?? 'unknown',
								...(subject === undefined ? {} : { subject }),
								at: IdentityRows.text(row, 'at') ?? ''
							};
						})
					};
				}),
				/**
				 * Creating a team, which is a name and a position and nothing else.
				 *
				 * Every statement below gets its own effect id derived from the invocation's, because the
				 * effect id *is* the idempotency key a facility dedupes on: a create and the audit row
				 * recording it, sent under one id, collapse into a single call and the second one is
				 * silently dropped.
				 */
				createTeam: Effect.fn('Identity.createTeam')(
					function* (effectId, tenantId, actorId, draft) {
						const name = draft.name.trim();
						if (name === '') return { _tag: 'Refused', reason: 'a team needs a name' } as const;
						const parentId = draft.parentId ?? null;
						if (
							parentId !== null &&
							(yield* readTeam(EffectId.make(`${effectId}:team-parent`), parentId)) === undefined
						) {
							return {
								_tag: 'Refused',
								reason: `there is no team ${parentId} to nest this one under`
							} as const;
						}
						const created = yield* database.execute(EffectId.make(`${effectId}:team-create`), {
							_tag: 'Query',
							// Uniqueness is asserted folded, in the statement, rather than left to the index. Every
							// comparison of a team name in this runtime is folded — `TEAM_LOOKUP_SQL` resolves a
							// preview with `lower("name") = lower($1)` and `policiesHeldByTeam` folds both sides —
							// but the unique index on the column is case-*sensitive*, so `on conflict` would admit
							// `hr manager` beside `HR Manager` and make which one an approval matched an accident.
							sql: `insert into bolt_team ("norbital_id", "name", "parent_id", "description")
						      select gen_random_uuid(), $1::text, $2::uuid, $3::text
						       where not exists (select 1 from bolt_team where lower("name") = lower($1::text))
						   returning ${TEAM_COLUMNS}`,
							parameters: [name, parentId, draft.description ?? null]
						});
						const row = created.rows[0];
						if (row === undefined)
							return { _tag: 'Refused', reason: `a team called ${name} already exists` } as const;
						const team = teamFromRow(row);
						yield* recordTeamEvent(
							EffectId.make(`${effectId}:team-create-audit`),
							'team_created',
							actorId,
							{ tenantId, teamId: team.id, team: team.name }
						);
						return { _tag: 'Team', team } as const;
					}
				),
				/**
				 * Renaming a team, or moving it in the tree.
				 *
				 * What it cannot do is change what the team may *do*. There is no policy argument here and
				 * there is nowhere to put one: the map from a team's name to its policies is compiled into
				 * the release, precisely so that authority cannot be granted with an `update` statement.
				 *
				 * Moving a team does change what its members hold, because descent is unconditional — a
				 * team gains whatever sits beneath its new parent. That is the hierarchy doing what a
				 * hierarchy is for, and it can still only ever compose policies teams *already* declare;
				 * there is no edit here that names a policy the release does not give that subtree.
				 *
				 * A rename does move authority, because the name is the binding: a team renamed away from
				 * what `+teams.ts` declares holds nothing, which is the ordinary inert case rather than an
				 * escalation, and is why this is safe to leave in an operator's hands.
				 */
				updateTeam: Effect.fn('Identity.updateTeam')(
					function* (effectId, tenantId, actorId, teamId, changes) {
						const current = yield* readTeam(EffectId.make(`${effectId}:team-read`), teamId);
						if (current === undefined)
							return { _tag: 'Refused', reason: `there is no team ${teamId}` } as const;
						const name = (changes.name ?? current.name).trim();
						if (name === '') return { _tag: 'Refused', reason: 'a team needs a name' } as const;
						// Absent leaves the column alone; an explicit `null` clears it. Collapsing the two would
						// mean a rename silently unparented the team, or that moving one to the root was
						// inexpressible — both have to be sayable, so both are distinguished here.
						const parentId =
							changes.parentId === undefined ? (current.parentId ?? null) : changes.parentId;
						if (parentId !== null) {
							if (
								(yield* readTeam(EffectId.make(`${effectId}:team-parent`), parentId)) === undefined
							) {
								return {
									_tag: 'Refused',
									reason: `there is no team ${parentId} to nest this one under`
								} as const;
							}
							// The subtree walk starts *at* this team, so naming itself as its own parent is caught
							// by the same query that catches naming one of its descendants — one refusal for one
							// mistake, rather than two checks that can disagree.
							const cycle = yield* database.execute(EffectId.make(`${effectId}:team-cycle`), {
								_tag: 'Query',
								sql: TEAM_SUBTREE_SQL,
								parameters: [current.id, parentId]
							});
							if (cycle.rows[0] !== undefined) {
								return {
									_tag: 'Refused',
									reason: `${current.name} cannot be nested inside its own subtree`
								} as const;
							}
						}
						const description =
							changes.description === undefined
								? (current.description ?? null)
								: changes.description;
						const updated = yield* database.execute(EffectId.make(`${effectId}:team-update`), {
							_tag: 'Query',
							// The folded uniqueness test rides in the statement rather than in a read before it, so
							// two operators renaming two teams to the same thing at once cannot both be told yes.
							sql: `update bolt_team set "name" = $2::text, "parent_id" = $3::uuid, "description" = $4::text,
						             "norbital_updated_at" = now()
						       where "norbital_id" = $1::uuid
						         and not exists (select 1 from bolt_team other
						                          where lower(other."name") = lower($2::text)
						                            and other."norbital_id" <> $1::uuid)
						   returning ${TEAM_COLUMNS}`,
							parameters: [current.id, name, parentId, description]
						});
						const row = updated.rows[0];
						if (row === undefined)
							return { _tag: 'Refused', reason: `a team called ${name} already exists` } as const;
						const team = teamFromRow(row);
						yield* recordTeamEvent(
							EffectId.make(`${effectId}:team-update-audit`),
							'team_updated',
							actorId,
							{ tenantId, teamId: team.id, team: team.name, previousName: current.name }
						);
						return { _tag: 'Team', team } as const;
					}
				),
				/**
				 * Deleting a team — **refused while anybody still belongs to it.**
				 *
				 * The alternative was to null the members' `team_id` and carry on, and that is the wrong
				 * half of the trade. A person's team is the whole of their authority in this workspace:
				 * emptying it strips every policy from every member at once, and nothing about the result
				 * says why. An operator who mis-clicked would see a department that had silently lost
				 * access with no event naming the cause and no undo, because the rows that said who was
				 * where are gone. Refusing costs them one extra step — move the members first — and that
				 * step is exactly the decision the delete was quietly making on their behalf.
				 *
				 * The children are a different case and are re-rooted rather than refused: the collection
				 * documents `parent_id` as `set null` on delete, but it is a plain uuid column with no
				 * foreign key, so nothing performs that — this does. Losing a parent costs a team nothing
				 * it held on its own, so there is no silent loss of authority to protect anybody from.
				 */
				deleteTeam: Effect.fn('Identity.deleteTeam')(
					function* (effectId, tenantId, actorId, teamId) {
						const current = yield* readTeam(EffectId.make(`${effectId}:team-read`), teamId);
						if (current === undefined)
							return { _tag: 'Refused', reason: `there is no team ${teamId}` } as const;
						// An existence probe rather than a count: a count has to be parsed back out of a driver
						// value, and a parse that failed would read as zero — which is exactly the answer that
						// lets the delete through. One row or none cannot be misread that way.
						const held = yield* database.execute(EffectId.make(`${effectId}:team-members`), {
							_tag: 'Query',
							sql: `select 1 from ${AUTH_MODELS.user} where "team_id" = $1::uuid and "tenantId" = $2::text
						      union all
						      select 1 from bolt_external_subjects where team_id = $1::uuid and tenant_id = $2::text
						      limit 1`,
							parameters: [current.id, tenantId]
						});
						if (held.rows[0] !== undefined) {
							return {
								_tag: 'Refused',
								reason: `${current.name} still has members — move them to another team before deleting it`
							} as const;
						}
						const deleted = yield* database.execute(EffectId.make(`${effectId}:team-delete`), {
							_tag: 'Query',
							sql: `delete from bolt_team where "norbital_id" = $1::uuid returning ${TEAM_COLUMNS}`,
							parameters: [current.id]
						});
						if (deleted.rows[0] === undefined)
							return { _tag: 'Refused', reason: `there is no team ${teamId}` } as const;
						yield* database.execute(EffectId.make(`${effectId}:team-reparent`), {
							_tag: 'Query',
							sql: `update bolt_team set "parent_id" = null, "norbital_updated_at" = now() where "parent_id" = $1::uuid`,
							parameters: [current.id]
						});
						yield* recordTeamEvent(
							EffectId.make(`${effectId}:team-delete-audit`),
							'team_deleted',
							actorId,
							{ tenantId, teamId: current.id, team: current.name }
						);
						return { _tag: 'Team', team: current } as const;
					}
				),
				/**
				 * Moving one person between teams, which writes `team_id` and nothing else.
				 *
				 * Notably not `status`. Administration is a property of the person and the only column that
				 * carries it; a membership command that could also write it would make "put Ada in
				 * Approvers" and "make Ada an administrator" the same request, reachable by anybody the
				 * identity gate lets through.
				 *
				 * Scoped by `tenantId`, which the boundary mints from the credential and never reads from
				 * the payload, so this cannot reach a person in another workspace.
				 */
				assignTeam: Effect.fn('Identity.assignTeam')(
					function* (effectId, tenantId, actorId, memberId, teamId) {
						const team =
							teamId === null
								? undefined
								: yield* readTeam(EffectId.make(`${effectId}:team-read`), teamId);
						if (teamId !== null && team === undefined)
							return { _tag: 'Refused', reason: `there is no team ${teamId}` } as const;
						if (!isRecordId(memberId))
							return {
								_tag: 'Refused',
								reason: `there is nobody with id ${memberId} in this workspace`
							} as const;
						const moved = yield* database.execute(EffectId.make(`${effectId}:team-assign`), {
							_tag: 'Query',
							sql: `update ${AUTH_MODELS.user} set "team_id" = $2::uuid, "norbital_updated_at" = now()
						       where "norbital_id" = $1::uuid and "tenantId" = $3::text and "kind" = 'person'
						   returning "norbital_id"::text as "id", "email"`,
							parameters: [memberId, team?.id ?? null, tenantId]
						});
						const row = moved.rows[0];
						if (row === undefined)
							return {
								_tag: 'Refused',
								reason: `there is nobody with id ${memberId} in this workspace`
							} as const;
						const email = IdentityRows.text(row, 'email');
						yield* recordTeamEvent(
							EffectId.make(`${effectId}:team-assign-audit`),
							'member_team_changed',
							actorId,
							{ tenantId, memberId, team: team?.name ?? null }
						);
						// The same pair `acceptInvitation` emits, for the same reason: the host keeps a
						// projection of who belongs where, and a move it never hears about leaves that
						// projection describing a membership this workspace no longer has.
						yield* identityHooks.emit(EffectId.make(`${effectId}:team-assign-hook`), {
							_tag: 'MembershipChanged',
							userId: memberId,
							organizationId: tenantId,
							...(email === undefined ? {} : { email }),
							action: 'team_changed',
							...(team === undefined ? {} : { team: team.name })
						});
						return {
							_tag: 'Assigned',
							memberId,
							...(team === undefined ? {} : { team })
						} as const;
					}
				),
				workspaceSettings: Effect.fn('Identity.workspaceSettings')(function* (effectId, tenantId) {
					const result = yield* database.execute(effectId, {
						_tag: 'Query',
						sql: 'select settings from bolt_workspace_identity_settings where tenant_id = $1',
						parameters: [tenantId]
					});
					const row = result.rows[0];
					const settings =
						typeof row === 'object' && row !== null ? Reflect.get(row, 'settings') : undefined;
					return yield* Schema.decodeUnknownEffect(Schema.Json)(settings ?? {}).pipe(Effect.orDie);
				})
			});
		})
	);

/** The default binding: a host that has bound communication. */
export const layer = layerWith(true);

export * as Identity from './identity.js';
