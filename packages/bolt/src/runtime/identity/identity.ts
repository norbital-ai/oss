import { Context, Effect, Layer, Schema } from 'effect';
import { EffectId } from '@norbital-ai/bolt-protocol';
import { Communication, IdentityHooks } from '#lib/runtime/facilities/services.js';
import * as Database from '#lib/runtime/facilities/database.js';
import { AUTH_MODELS } from '#lib/authoring/system-models.js';
import { makeAuth } from '#lib/runtime/identity/auth.js';
import { identitiesOf, identityMatches } from '#lib/runtime/envoys/transport-identity.js';

export const Subject = Schema.Struct({
	userId: Schema.NonEmptyString,
	tenantId: Schema.NonEmptyString,
	/**
	 * The team names whose declared policies this subject holds: its own team first, then the teams
	 * beneath it in the hierarchy.
	 *
	 * Names, not policies. The mapping from a team name to the policies it holds is authored — it
	 * lives in the compiled release, not in a row — so only `AccessControl` resolves it, and identity
	 * stays ignorant of what any policy grants.
	 *
	 * The subject's own team is `teamPath[0]`, and there is deliberately no second field carrying it.
	 * There used to be: the SQL computed `team` as `tree.depth = 1` and `teamPath` as the same tree
	 * ordered by depth, so the two could never disagree — but two fields carrying one fact are two
	 * places to read it from, and `approvals.decide` and `AccessControl` read different ones.
	 */
	teamPath: Schema.Array(Schema.NonEmptyString),
	/**
	 * The policies this subject holds directly, named by a declaration rather than through a team.
	 *
	 * Empty for a person: a person belongs to one team, and the team names what it holds. Non-empty
	 * for a static identity — an envoy, an automation — which has no team at all and carries the
	 * policies its declaration named.
	 *
	 * It is a `MINTED_IDENTITY` field, refused when it arrives in a payload exactly as `system` is,
	 * and no database column produces it. That is what makes "the sender cannot widen it" a
	 * structural fact rather than a review comment: there is no string a sender can send that adds a
	 * policy, and no row that confers one.
	 */
	policies: Schema.Array(Schema.NonEmptyString),
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

const JsonObject = Schema.Record(Schema.String, Schema.Json);
const NullableString = Schema.NullOr(Schema.String);
const SubjectDatabaseRow = Schema.Struct({
	userId: Schema.NonEmptyString,
	tenantId: Schema.NonEmptyString,
	email: Schema.optionalKey(NullableString),
	status: Schema.optionalKey(NullableString),
	teamPath: Schema.Array(Schema.NonEmptyString)
});
const SecretRow = Schema.Struct({ value: Schema.NonEmptyString });
const TeamDatabaseRow = Schema.Struct({
	id: Schema.NonEmptyString,
	name: Schema.NonEmptyString,
	parentId: NullableString,
	description: NullableString
});
const TransportAccountRow = Schema.Struct({
	userId: Schema.NonEmptyString,
	email: NullableString,
	channels: Schema.Json
});
const InvitationAcceptedRow = Schema.Struct({
	tenant_id: Schema.NonEmptyString,
	email: NullableString
});
const IdRow = Schema.Struct({ id: Schema.NonEmptyString });
const MemberRow = Schema.Struct({
	id: Schema.NonEmptyString,
	email: NullableString,
	team: NullableString,
	status: Schema.String
});
const InvitationRow = Schema.Struct({
	id: Schema.NonEmptyString,
	email: Schema.String,
	status: Schema.String,
	invitedBy: NullableString
});
const AuditSubject = Schema.Struct({
	collection: Schema.optionalKey(Schema.String),
	requestId: Schema.optionalKey(Schema.String),
	team: Schema.optionalKey(Schema.String)
});
const AuditRow = Schema.Struct({
	id: Schema.NonEmptyString,
	action: Schema.NonEmptyString,
	actor: Schema.NonEmptyString,
	payload: AuditSubject,
	at: Schema.String
});
const AssignedMemberRow = Schema.Struct({ id: Schema.NonEmptyString, email: NullableString });
const WorkspaceSettingsRow = Schema.Struct({ settings: Schema.Json });

const malformedDatabaseRow = (operation: string) =>
	new Database.FacilityError({
		operation,
		code: 'malformed_response',
		message: `database returned a malformed row for ${operation}`,
		retryable: false,
		outcome: 'known'
	});

/**
 * Whether a string is shaped like the `id` an identity row is keyed by.
 *
 * Checked before the value reaches a statement, because `$1::uuid` on anything else is a *database*
 * error — a 500 with a Postgres sentence in it — where the honest answer to "delete the team called
 * `nonsense`" is that there is no such team. A caller naming a malformed id gets the same refusal
 * as one naming an id that is merely absent, which is the same thing from where they stand.
 */
const RECORD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isRecordId = (value: string): boolean => RECORD_ID_PATTERN.test(value);

/** Every column a team is read back as, spelled once so the four writes cannot project it differently. */
const TEAM_COLUMNS = `"id"::text as "id", "name", "parent_id"::text as "parentId", "description"`;

/**
 * The subtree under one team, bounded exactly as `TEAM_TREE_SQL` is and for the same reason.
 *
 * Used to refuse a re-parent that would put a team inside its own subtree. The bound is not
 * redundant with that refusal: these commands are what stops a *new* cycle being made, and a row
 * written before they existed can already be in one — so the walk that detects it must terminate on
 * a graph that is already cyclic.
 */
const TEAM_SUBTREE_SQL = `with recursive tree as (
	select "id" as id, 1 as depth from bolt_team where "id" = $1::uuid
	union all
	select c."id", p.depth + 1 from bolt_team c join tree p on c."parent_id" = p.id
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
const subjectFromRow = (row: Schema.Schema.Type<typeof SubjectDatabaseRow>): Subject => {
	return {
		userId: row.userId,
		tenantId: row.tenantId,
		teamPath: row.teamPath,
		// Empty, always. A person holds policies through their team and never directly; the array is
		// what a *static* identity carries, and no row projects one.
		policies: [],
		// Exactly one spelling counts. A column that is null, absent, misspelled or holding anything
		// else at all is an ordinary user, so a projection that forgets to select `status` cannot
		// promote everybody it returns.
		admin: row.status === ADMIN_STATUS,
		...(row.email === undefined || row.email === null ? {} : { email: row.email })
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
 * policy is not inheriting its rows. A grant scoped `${requestor.id}` re-evaluates against
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
	select t."id" as id, t."name" as name, 1 as depth
	  from bolt_team t join subject on t."id" = subject."team_id"
	union all
	select c."id", c."name", p.depth + 1
	  from bolt_team c join tree p on c."parent_id" = p.id
	 where p.depth < 8
)`;

/**
 * The projection every subject read ends in: the row, its team's name, and the resolved path.
 *
 * `teamPath` is ordered by depth so the subject's own team is first — the order a diagnostic reads
 * best in, the order `AccessControl` reports when it explains why something was allowed, and the
 * reason there is no separate `team` column here. The subject's own team *is* `teamPath[0]`, and
 * projecting it twice is how two readers came to disagree about which one meant "the team".
 */
const SUBJECT_TAIL_SQL = `select subject.*,
	coalesce((select json_agg(tree.name order by tree.depth) from tree), '[]'::json) as "teamPath"
	from subject`;

const EXTERNAL_SUBJECT_SQL = `with recursive subject as (
	select user_id as "userId", tenant_id as "tenantId", email, team_id as "team_id", null as "status"
	  from bolt_external_subjects
	 where provider = $1 and external_id = $2
)${TEAM_TREE_SQL} ${SUBJECT_TAIL_SQL}`;

const AUTHENTICATE_SQL = `with recursive subject as (
	select u."id" as "userId", u."tenantId" as "tenantId",
	       u."email" as "email", u."status" as "status", u."team_id" as "team_id"
	  from ${AUTH_MODELS.session} s
	  join ${AUTH_MODELS.user} u on u."id" = s."userId"
	 where s."token" = $1 and s."expiresAt" > now()
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
	readonly parentId?: string | null | undefined;
	readonly description?: string | null | undefined;
}>;

/**
 * What an edit changes, where an absent key means "leave it alone" and an explicit `null` clears it.
 *
 * The two have to be distinguishable: renaming a team must not silently unparent it, and moving a
 * team to the root must be expressible. An optional key that can also hold `null` is the only shape
 * that says both.
 */
export type TeamChanges = Readonly<{
	readonly name?: string | undefined;
	readonly parentId?: string | null | undefined;
	readonly description?: string | null | undefined;
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
	 * The account that has proven ownership of this address on this transport, or nothing.
	 *
	 * Answers `userId` and `email` and deliberately not a `Subject`. A subject carries a `teamPath`
	 * and a policy set, and this person's are exactly what an inbound envoy message must *not*
	 * inherit: their authority on an envoy is the envoy's declared policies, whatever they hold in
	 * the web app. Returning half an identity is what makes that impossible to get wrong by accident
	 * downstream.
	 *
	 * Nothing, rather than a failure, when no account matches: an unrecognised sender is an ordinary
	 * and expected state on an envoy anyone can message, not a fault.
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
export const layerWith = (
	canDeliver: boolean,
	randomId: () => string = () => globalThis.crypto.randomUUID(),
	/** Uniform source for the six-digit sign-in codes; the platform RNG unless a host injects one. */
	random: () => number = Math.random
) =>
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
				const row = yield* Schema.decodeUnknownEffect(SubjectDatabaseRow)(first).pipe(
					Effect.mapError(() => new AuthenticationError({ reason: 'malformed' }))
				);
				return subjectFromRow(row);
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
					// it is keyed by `id` and `key` carries an index but no unique constraint for a
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
				const secret = yield* Schema.decodeUnknownEffect(SecretRow)(stored.rows[0]).pipe(
					Effect.mapError(() => new AuthenticationError({ reason: 'malformed' })),
					Effect.map((row) => row.value)
				);
				return makeAuth(
					{
						secret,
						baseURL: 'https://bolt.invalid',
						production: canDeliver,
						execute: (sql, parameters) =>
							Effect.gen(function* () {
								const decodedParameters = yield* Schema.decodeUnknownEffect(
									Schema.Array(Schema.Json)
								)(parameters);
								const result = yield* database.execute(effectId, {
									_tag: 'Query',
									sql,
									parameters: decodedParameters
								});
								const rows = yield* Schema.decodeUnknownEffect(Schema.Array(JsonObject))(result.rows);
								return { rows, affectedRows: result.affectedRows };
							}),
						deliver: (message) =>
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
					},
					random,
					randomId
				);
			});

			/** The projection every team write answers with, read off the row the statement returned. */
			const teamFromRow = (row: Schema.Schema.Type<typeof TeamDatabaseRow>): TeamRecord => {
				const { description, id, name, parentId } = row;
				return {
					id,
					name,
					...(parentId === null ? {} : { parentId }),
					...(description === null ? {} : { description })
				};
			};
			const decodeTeamRow = (operation: string, row: Schema.Json) =>
				Schema.decodeUnknownEffect(TeamDatabaseRow)(row).pipe(
					Effect.map(teamFromRow),
					Effect.mapError(() => malformedDatabaseRow(operation))
				);
			const readTeam = Effect.fn('Identity.readTeam')(function* (
				effectId: EffectId,
				teamId: string
			) {
				if (!isRecordId(teamId)) return undefined;
				const found = yield* database.execute(effectId, {
					_tag: 'Query',
					sql: `select ${TEAM_COLUMNS} from bolt_team where "id" = $1::uuid`,
					parameters: [teamId]
				});
				const row = found.rows[0];
				return row === undefined ? undefined : yield* decodeTeamRow('identity.team.read', row);
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
				 * There is no `kind <> 'service'` filter, and there is nothing left for one to exclude. It
				 * existed to keep channel principals — rows minted for a machine — out of the candidate
				 * set. A static identity is minted in memory now and never written to `bolt_auth_user`, so
				 * every row this reaches is a person, and the predicate would have been a filter over an
				 * empty set that read as a safety property.
				 */
				accountByTransportIdentity: Effect.fn('Identity.accountByTransportIdentity')(
					function* (effectId, transport, senderAddress) {
						const result = yield* database.execute(effectId, {
							_tag: 'Query',
							sql: `select u."id" as "userId", u."email" as "email", u."channels" as "channels"
						        from ${AUTH_MODELS.user} u
						       where u."channels" @> $1::jsonb`,
							parameters: [JSON.stringify([{ type: transport, verified: true }])]
						});
						for (const row of result.rows) {
							const decoded = yield* Schema.decodeUnknownEffect(TransportAccountRow)(row).pipe(
								Effect.mapError(() => malformedDatabaseRow('identity.accountByTransportIdentity'))
							);
							const held = identitiesOf(decoded.channels);
							if (!held.some((identity) => identityMatches(identity, transport, senderAddress)))
								continue;
							return decoded.email === null
								? { userId: decoded.userId }
								: { userId: decoded.userId, email: decoded.email };
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
						const invitation = yield* Schema.decodeUnknownEffect(InvitationAcceptedRow)(row).pipe(
							Effect.mapError(() => new AuthenticationError({ reason: 'malformed' }))
						);
						const { email, tenant_id: organizationId } = invitation;
						yield* identityHooks.emit(effectId, {
							_tag: 'MembershipChanged',
							userId,
							organizationId,
							...(email === null ? {} : { email }),
							action: 'joined'
						});
						yield* identityHooks.emit(effectId, {
							_tag: 'UserChanged',
							userId,
							organizationId,
							...(email === null ? {} : { email })
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
						sql: `insert into ${AUTH_MODELS.user} ("id", "name", "email", "emailVerified", "status", "tenantId", "team_id")
					      values (gen_random_uuid(), $1, $1, true, $4, $2, $3)
					      on conflict ("email") do update set
					        "tenantId" = excluded."tenantId",
					        "team_id" = excluded."team_id",
					        "status" = excluded."status",
					        "updated_at" = now()
					      returning "id" as "id"`,
						parameters: [email, tenantId, teamId, status]
					});
					const admittedId = yield* Schema.decodeUnknownEffect(IdRow)(admitted.rows[0]).pipe(
						Effect.map((row) => row.id),
						Effect.mapError(() => malformedDatabaseRow('identity.admit'))
					);
					// The address rides along because it is the only stable name this person has across
					// organizations: identity is per-tenant, so the same human is a different `id`
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
						sql: `update ${AUTH_MODELS.user} set "tenantId" = $2, "updated_at" = now() where "id" = (select "userId" from ${AUTH_MODELS.session} where "token" = $1) returning "id" as "id"`,
						parameters: [signedIn.token, tenantId]
					});
					const admittedId = yield* Schema.decodeUnknownEffect(IdRow)(admitted.rows[0]).pipe(
						Effect.map((row) => row.id),
						Effect.mapError(() => new AuthenticationError({ reason: 'invalid' }))
					);
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
					const credential = `bolt:${tenantId}:${randomId()}`;
					const admitted = yield* database.execute(effectId, {
						_tag: 'Query',
						sql: `update ${AUTH_MODELS.user} set "tenantId" = $2, "updated_at" = now() where "id" = $1 returning "id" as "id"`,
						parameters: [userId, tenantId]
					});
					if (admitted.rows[0] === undefined)
						return yield* new AuthenticationError({ reason: 'invalid' });
					yield* database.execute(effectId, {
						_tag: 'Query',
						sql: `insert into ${AUTH_MODELS.session} ("id", "token", "userId", "expiresAt") values ($1, $2, $3, now() + interval '8 hours')`,
						parameters: [randomId(), credential, userId]
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
							-- Cast to text so the union matches: identity is keyed by \`id uuid\`, while an
							-- external subject's id is whatever its provider calls it, and both are only ever
							-- read back out of this projection as a string.
							select "id"::text as user_id, "email", "team_id", "status" from ${AUTH_MODELS.user} where "tenantId" = $1
							union all
							-- An external subject is authenticated somewhere else and \`bolt_external_subjects\`
							-- carries no status column, so it can only ever be an ordinary member — the same
							-- answer \`resolveSubject\` gives it.
							select user_id, email, team_id, '${NORMAL_STATUS}' from bolt_external_subjects where tenant_id = $1
						  ) subjects
						  left join bolt_team t on t."id" = subjects."team_id"
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
					const decodedMembers = yield* Schema.decodeUnknownEffect(Schema.Array(MemberRow))(
						memberRows.rows
					).pipe(Effect.mapError(() => malformedDatabaseRow('identity.workspaceAccess.members')));
					const decodedInvitations = yield* Schema.decodeUnknownEffect(Schema.Array(InvitationRow))(
						invitationRows.rows
					).pipe(
						Effect.mapError(() => malformedDatabaseRow('identity.workspaceAccess.invitations'))
					);
					const decodedAudits = yield* Schema.decodeUnknownEffect(Schema.Array(AuditRow))(
						auditRows.rows
					).pipe(Effect.mapError(() => malformedDatabaseRow('identity.workspaceAccess.audit')));
					const members = decodedMembers.map((row) => {
						const { email, id, status, team } = row;
						return {
							id,
							email: email ?? '',
							name: email?.split('@')[0] ?? id,
							// The status column, and only it. `admin` was never a role a workspace declares and
							// is now explicitly not one; what a person may do otherwise is their team's
							// business, so this reports the team rather than guessing a tier from it.
							role: status === ADMIN_STATUS ? 'admin' : 'basic',
							status: 'active',
							...(team === null ? {} : { team })
						};
					});
					const teamRows = yield* database.execute(effectId, {
						_tag: 'Query',
						sql: 'select "id"::text as "id", "name", "parent_id"::text as "parentId", "description" from bolt_team order by "name"',
						parameters: []
					});
					const teams = yield* Schema.decodeUnknownEffect(Schema.Array(TeamDatabaseRow))(
						teamRows.rows
					).pipe(
						Effect.map((rows) => rows.map(teamFromRow)),
						Effect.mapError(() => malformedDatabaseRow('identity.workspaceAccess.teams'))
					);
					return {
						members,
						invitations: decodedInvitations.map((row) => {
							const { email, id, invitedBy, status } = row;
							return {
								id,
								email,
								role: 'basic',
								status,
								...(invitedBy === null ? {} : { invitedBy })
							};
						}),
						teams,
						events: decodedAudits.map((row) => {
							// `team` is third because the entries that carry one — every `teams.*` write, and
							// the impersonation row that names a previewed team — have no collection and no
							// request behind them, and without it they render in the activity list as an
							// action by somebody against nothing.
							const subject = row.payload.collection ?? row.payload.requestId ?? row.payload.team;
							return {
								id: row.id,
								action: row.action,
								actor: row.actor,
								...(subject === undefined ? {} : { subject }),
								at: row.at
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
							sql: `insert into bolt_team ("id", "name", "parent_id", "description")
						      select gen_random_uuid(), $1::text, $2::uuid, $3::text
						       where not exists (select 1 from bolt_team where lower("name") = lower($1::text))
						   returning ${TEAM_COLUMNS}`,
							parameters: [name, parentId, draft.description ?? null]
						});
						const row = created.rows[0];
						if (row === undefined)
							return { _tag: 'Refused', reason: `a team called ${name} already exists` } as const;
						const team = yield* decodeTeamRow('identity.team.create', row);
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
						             "updated_at" = now()
						       where "id" = $1::uuid
						         and not exists (select 1 from bolt_team other
						                          where lower(other."name") = lower($2::text)
						                            and other."id" <> $1::uuid)
						   returning ${TEAM_COLUMNS}`,
							parameters: [current.id, name, parentId, description]
						});
						const row = updated.rows[0];
						if (row === undefined)
							return { _tag: 'Refused', reason: `a team called ${name} already exists` } as const;
						const team = yield* decodeTeamRow('identity.team.update', row);
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
							sql: `delete from bolt_team where "id" = $1::uuid returning ${TEAM_COLUMNS}`,
							parameters: [current.id]
						});
						if (deleted.rows[0] === undefined)
							return { _tag: 'Refused', reason: `there is no team ${teamId}` } as const;
						yield* database.execute(EffectId.make(`${effectId}:team-reparent`), {
							_tag: 'Query',
							sql: `update bolt_team set "parent_id" = null, "updated_at" = now() where "parent_id" = $1::uuid`,
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
							sql: `update ${AUTH_MODELS.user} set "team_id" = $2::uuid, "updated_at" = now()
						       where "id" = $1::uuid and "tenantId" = $3::text
						   returning "id"::text as "id", "email"`,
							parameters: [memberId, team?.id ?? null, tenantId]
						});
						const row = moved.rows[0];
						if (row === undefined)
							return {
								_tag: 'Refused',
								reason: `there is nobody with id ${memberId} in this workspace`
							} as const;
						const movedMember = yield* Schema.decodeUnknownEffect(AssignedMemberRow)(row).pipe(
							Effect.mapError(() => malformedDatabaseRow('identity.assignTeam'))
						);
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
							...(movedMember.email === null ? {} : { email: movedMember.email }),
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
					if (row === undefined) return {};
					return yield* Schema.decodeUnknownEffect(WorkspaceSettingsRow)(row).pipe(
						Effect.map((decoded) => decoded.settings),
						Effect.mapError(() => malformedDatabaseRow('identity.workspaceSettings'))
					);
				})
			});
		})
	);

/** The default binding: a host that has bound communication. */
export const layer = layerWith(true);
