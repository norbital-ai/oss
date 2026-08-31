import { Clock, Context, Effect, Layer, Schema } from 'effect';
import { EffectId } from '@norbital-ai/bolt-protocol';
import { and, asc, desc, eq, gt, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { Communication, IdentityHooks } from '#lib/runtime/facilities/services.js';
import * as Database from '#lib/runtime/facilities/database.js';
import { Subject } from './subject.js';
import { SYSTEM_MODEL_TABLES } from '#lib/authoring/system-models.js';
import { makeAuth, SIGN_IN_CODE_EXPIRES_SECONDS } from '#lib/runtime/identity/auth.js';
import { identitiesOf, identityMatches } from '#lib/runtime/envoys/transport-identity.js';
import { composer, dbNow, dbNowPlusSeconds, executeBuilt } from '#lib/runtime/persistence.js';

export { Subject } from './subject.js';
export { CurrentSubject, currentSubject } from './subject.js';

const usersTable = SYSTEM_MODEL_TABLES.user;
const sessionsTable = SYSTEM_MODEL_TABLES.session;
const authConfigTable = SYSTEM_MODEL_TABLES.auth_config;
const teamsTable = SYSTEM_MODEL_TABLES.team;
const auditTable = SYSTEM_MODEL_TABLES.bolt_audit;
const externalSubjectsTable = SYSTEM_MODEL_TABLES.bolt_external_subjects;
const invitationsTable = SYSTEM_MODEL_TABLES.bolt_invitations;
const workspaceIdentitySettingsTable = SYSTEM_MODEL_TABLES.bolt_workspace_identity_settings;
const verificationTable = SYSTEM_MODEL_TABLES.verification;

const JsonObject = Schema.Record(Schema.String, Schema.Json);
const NullableString = Schema.NullOr(Schema.String);
const SubjectDatabaseRow = Schema.Struct({
	userId: Schema.NonEmptyString,
	tenantId: Schema.NonEmptyString,
	email: Schema.optionalKey(NullableString),
	status: Schema.optionalKey(NullableString),
	teamPath: Schema.Array(Schema.NonEmptyString)
});
const UserSubjectSourceRow = Schema.Struct({
	id: Schema.NonEmptyString,
	tenantId: Schema.NonEmptyString,
	email: Schema.optionalKey(NullableString),
	status: Schema.optionalKey(NullableString),
	team_id: NullableString
});
const ExternalSubjectSourceRow = Schema.Struct({
	user_id: Schema.NonEmptyString,
	tenant_id: Schema.NonEmptyString,
	email: Schema.optionalKey(NullableString),
	team_id: NullableString
});
const SecretRow = Schema.Struct({ value: Schema.NonEmptyString });
const TeamDatabaseRow = Schema.Struct({
	id: Schema.NonEmptyString,
	name: Schema.NonEmptyString,
	parent_id: NullableString,
	description: NullableString
});
const TransportAccountRow = Schema.Struct({
	id: Schema.NonEmptyString,
	email: NullableString,
	channels: Schema.Json
});
const InvitationAcceptedRow = Schema.Struct({
	tenant_id: Schema.NonEmptyString,
	email: NullableString
});
const InvitationClaimRow = Schema.Struct({
	tenant_id: Schema.NonEmptyString,
	email: Schema.NonEmptyString,
	status: Schema.NonEmptyString,
	expires_at: Schema.NullOr(Schema.String)
});
const IdRow = Schema.Struct({ id: Schema.NonEmptyString });
const MemberRow = Schema.Struct({
	id: Schema.NonEmptyString,
	email: NullableString,
	team: NullableString,
	status: Schema.String
});
const MemberSourceRow = Schema.Struct({
	id: Schema.NonEmptyString,
	email: NullableString,
	team_id: NullableString,
	status: Schema.String
});
const ExternalMemberSourceRow = Schema.Struct({
	user_id: Schema.NonEmptyString,
	email: NullableString,
	team_id: NullableString
});
const InvitationRow = Schema.Struct({
	invitation_id: Schema.NonEmptyString,
	email: Schema.String,
	status: Schema.String,
	invited_by: NullableString,
	expires_at: Schema.NullOr(Schema.String)
});
const AuditSubject = Schema.Struct({
	collection: Schema.optionalKey(Schema.String),
	requestId: Schema.optionalKey(Schema.String),
	team: Schema.optionalKey(Schema.String)
});
const AuditSourceRow = Schema.Struct({
	sequence: Schema.Union([Schema.Number, Schema.NumberFromString]),
	kind: Schema.NonEmptyString,
	subject_id: Schema.NonEmptyString,
	payload: AuditSubject,
	created_at: Schema.String
});
const AssignedMemberRow = Schema.Struct({ id: Schema.NonEmptyString, email: NullableString });
const WorkspaceSettingsRow = Schema.Struct({ settings: Schema.Json });

/** Workspace invitations last long enough to be acted on, while still bounding forwarded links. */
export const INVITATION_EXPIRES_SECONDS = 7 * 24 * 60 * 60;

export type InvitationClaimState =
	| Readonly<{ readonly state: 'ready' }>
	| Readonly<{ readonly state: 'expired' | 'accepted' | 'revoked' | 'invalid' }>;

export type InvitationAcceptance =
	| Readonly<{ readonly state: 'accepted' }>
	| Readonly<{
			readonly state: 'expired' | 'already_accepted' | 'revoked' | 'wrong_account' | 'invalid';
	  }>;

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

/**
 * The two values `user.status` may hold, named once so no call site spells them.
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
type TeamDraft = Readonly<{
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
type TeamChanges = Readonly<{
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
	) => Effect.Effect<string, Database.FacilityError>;
	/** Read-only invitation link probe. It never accepts or otherwise changes the claim. */
	readonly inspectInvitation: (
		effectId: EffectId,
		tenantId: string,
		invitationId: string
	) => Effect.Effect<InvitationClaimState, Database.FacilityError>;
	readonly acceptInvitation: (
		effectId: EffectId,
		invitationId: string,
		subject: Subject
	) => Effect.Effect<InvitationAcceptance, Database.FacilityError>;
	/** Persists a sign-in code and submits it to the host's communication provider. */
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
	/** Mints a fresh tenant-local session for an existing member selected by verified address. */
	readonly startSessionForEmail: (
		effectId: EffectId,
		email: string,
		tenantId: string
	) => Effect.Effect<string, AuthenticationError | Database.FacilityError>;
	readonly endSession: (
		effectId: EffectId,
		credential: string
	) => Effect.Effect<void, Database.FacilityError>;
	/** Reads the replay ledger used by the host-only founder bootstrap command. */
	readonly readFounderClaim: (
		effectId: EffectId,
		identifier: string
	) => Effect.Effect<string | undefined, Database.FacilityError>;
	/** Records a spent founder claim without exposing the verification collection to dispatch. */
	readonly recordFounderClaim: (
		effectId: EffectId,
		identifier: string,
		value: string,
		expiresAt: string
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
	 * The four writes an operator makes against `team`, and the whole of what they can change.
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
	 * Every team in the workspace, read from `team` rather than derived from who is in one.
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
			const teamProjection = {
				id: teamsTable.id,
				name: teamsTable.name,
				parent_id: teamsTable.parent_id,
				description: teamsTable.description
			} as const;
			const readTeamRows = Effect.fn('Identity.readTeamRows')(function* (effectId: EffectId) {
				const result = yield* executeBuilt(
					effectId,
					database,
					composer.select(teamProjection).from(teamsTable).orderBy(asc(teamsTable.name))
				);
				return yield* Schema.decodeUnknownEffect(Schema.Array(TeamDatabaseRow))(result.rows).pipe(
					Effect.mapError(() => malformedDatabaseRow('identity.teams.read'))
				);
			});
			/** Resolves the bounded descendant path in memory from one typed collection read. */
			const teamPathOf = (
				teamId: string | null,
				teams: ReadonlyArray<Schema.Schema.Type<typeof TeamDatabaseRow>>
			): ReadonlyArray<string> => {
				if (teamId === null) return [];
				const byId = new Map(teams.map((team) => [team.id, team] as const));
				const children = new Map<string, Array<string>>();
				for (const team of teams) {
					if (team.parent_id === null) continue;
					const siblings = children.get(team.parent_id) ?? [];
					siblings.push(team.id);
					children.set(team.parent_id, siblings);
				}
				const path: Array<string> = [];
				let frontier = [teamId];
				for (let depth = 0; depth < 8 && frontier.length > 0; depth += 1) {
					const next: Array<string> = [];
					for (const id of frontier) {
						const team = byId.get(id);
						if (team === undefined) continue;
						path.push(team.name);
						next.push(...(children.get(id) ?? []));
					}
					frontier = next;
				}
				return path;
			};
			const subtreeContains = (
				rootId: string,
				candidateId: string,
				teams: ReadonlyArray<Schema.Schema.Type<typeof TeamDatabaseRow>>
			): boolean => {
				const children = new Map<string, Array<string>>();
				for (const team of teams) {
					if (team.parent_id === null) continue;
					const siblings = children.get(team.parent_id) ?? [];
					siblings.push(team.id);
					children.set(team.parent_id, siblings);
				}
				const visited = new Set<string>();
				let frontier = [rootId];
				for (let depth = 0; depth < 8 && frontier.length > 0; depth += 1) {
					if (frontier.includes(candidateId)) return true;
					const next: Array<string> = [];
					for (const id of frontier) {
						if (visited.has(id)) continue;
						visited.add(id);
						next.push(...(children.get(id) ?? []));
					}
					frontier = next;
				}
				return false;
			};
			const subjectFromSource = Effect.fn('Identity.subjectFromSource')(function* (
				effectId: EffectId,
				source: Readonly<{
					readonly userId: string;
					readonly tenantId: string;
					readonly email?: string | null;
					readonly status?: string | null;
					readonly teamId: string | null;
				}>
			) {
				const teams = yield* readTeamRows(EffectId.make(`${effectId}:teams`)).pipe(
					Effect.mapError(() => new AuthenticationError({ reason: 'malformed' }))
				);
				return subjectFromRow({
					userId: source.userId,
					tenantId: source.tenantId,
					...(source.email === undefined ? {} : { email: source.email }),
					...(source.status === undefined ? {} : { status: source.status }),
					teamPath: teamPathOf(source.teamId, teams)
				});
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
				let stored = yield* executeBuilt(
					EffectId.make(`${effectId}:auth-secret-read`),
					database,
					composer
						.select({ value: authConfigTable.value })
						.from(authConfigTable)
						.where(eq(authConfigTable.key, 'session-secret'))
						.limit(1)
				);
				if (stored.rows[0] === undefined) {
					const generated = `${randomId().replaceAll('-', '')}${randomId().replaceAll('-', '')}`;
					yield* executeBuilt(
						EffectId.make(`${effectId}:auth-secret-create`),
						database,
						composer.insert(authConfigTable).values({ key: 'session-secret', value: generated })
					);
					stored = yield* executeBuilt(
						EffectId.make(`${effectId}:auth-secret-reread`),
						database,
						composer
							.select({ value: authConfigTable.value })
							.from(authConfigTable)
							.where(eq(authConfigTable.key, 'session-secret'))
							.limit(1)
					);
				}
				const secret = yield* Schema.decodeUnknownEffect(SecretRow)(stored.rows[0]).pipe(
					Effect.mapError(() => new AuthenticationError({ reason: 'malformed' })),
					Effect.map((row) => row.value)
				);
				return makeAuth(
					{
						secret,
						baseURL: 'https://bolt.invalid',
						production: canDeliver,
						execute: ({ sql, parameters }) =>
							Effect.gen(function* () {
								const decodedParameters = yield* Schema.decodeUnknownEffect(
									Schema.Array(Schema.Json)
								)(parameters);
								const result = yield* database.execute(effectId, {
									_tag: 'Query',
									sql,
									parameters: decodedParameters
								});
								const rows = yield* Schema.decodeUnknownEffect(Schema.Array(JsonObject))(
									result.rows
								);
								return { rows, affectedRows: result.affectedRows };
							}),
						deliver: (message) =>
							Effect.gen(function* () {
								/**
								 * Better Auth writes the verification row before it invokes this callback. OTP delivery
								 * is interactive work: submit it immediately and answer only after the provider accepts
								 * it. The effect id is the provider idempotency key, so an uncertain transport outcome
								 * can be retried without sending the same code twice. Once accepted, Resend owns delivery.
								 */
								yield* communication.execute(EffectId.make(`${effectId}:code-delivery`), {
									_tag: 'Send',
									channel: 'email',
									recipient: message.email,
									payload: {
										kind: 'sign_in_code',
										code: message.code,
										purpose: message.purpose,
										expiresInMinutes: SIGN_IN_CODE_EXPIRES_SECONDS / 60,
										subject: 'Your sign-in code',
										body: `Your sign-in code is ${message.code}. It expires in ${SIGN_IN_CODE_EXPIRES_SECONDS / 60} minutes.`
									}
								});
							})
					},
					random,
					randomId
				);
			});

			/** The projection every team write answers with, read off the row the statement returned. */
			const teamFromRow = (row: Schema.Schema.Type<typeof TeamDatabaseRow>): TeamRecord => {
				const { description, id, name, parent_id: parentId } = row;
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
				const found = yield* executeBuilt(
					effectId,
					database,
					composer.select(teamProjection).from(teamsTable).where(eq(teamsTable.id, teamId)).limit(1)
				);
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
				yield* executeBuilt(
					effectId,
					database,
					composer
						.insert(auditTable)
						// `.toSQL()` intentionally does not run Drizzle's driver encoders. PostgreSQL's jsonb
						// input therefore receives JSON text here, not a JavaScript object on the facility wire.
						.values({ kind, subject_id: actorId, payload: JSON.stringify(payload) as never })
				);
			});
			/** The one session constructor, shared by id-based and host-mediated sign-in. */
			const startSession = Effect.fn('Identity.startSession')(function* (
				effectId: EffectId,
				userId: string,
				tenantId: string
			) {
				const credential = `bolt:${tenantId}:${randomId()}`;
				const admitted = yield* executeBuilt(
					EffectId.make(`${effectId}:user-admit`),
					database,
					composer
						.update(usersTable)
						.set({ tenantId, updated_at: dbNow() })
						.where(eq(usersTable.id, userId))
						.returning({ id: usersTable.id })
				);
				if (admitted.rows[0] === undefined)
					return yield* new AuthenticationError({ reason: 'invalid' });
				yield* executeBuilt(
					EffectId.make(`${effectId}:session-create`),
					database,
					composer.insert(sessionsTable).values({
						id: randomId(),
						token: credential,
						userId,
						expiresAt: dbNowPlusSeconds(8 * 60 * 60)
					})
				);
				yield* identityHooks.emit(effectId, {
					_tag: 'UserChanged',
					userId,
					organizationId: tenantId
				});
				return credential;
			});
			const inspectInvitation = Effect.fn('Identity.inspectInvitation')(function* (
				effectId: EffectId,
				tenantId: string,
				invitationId: string
			) {
				const result = yield* executeBuilt(
					effectId,
					database,
					composer
						.select({
							tenant_id: invitationsTable.tenant_id,
							email: invitationsTable.email,
							status: invitationsTable.status,
							expires_at: invitationsTable.expires_at
						})
						.from(invitationsTable)
						.where(
							and(
								eq(invitationsTable.invitation_id, invitationId),
								eq(invitationsTable.tenant_id, tenantId)
							)
						)
						.limit(1)
				);
				const row = result.rows[0];
				if (row === undefined) return { state: 'invalid' as const };
				const invitation = yield* Schema.decodeUnknownEffect(InvitationClaimRow)(row).pipe(
					Effect.mapError(() => malformedDatabaseRow('identity.inspectInvitation'))
				);
				if (invitation.status === 'accepted') return { state: 'accepted' as const };
				if (invitation.status === 'revoked') return { state: 'revoked' as const };
				if (invitation.status !== 'pending') return { state: 'invalid' as const };
				const now = yield* Clock.currentTimeMillis;
				return invitation.expires_at !== null && Date.parse(invitation.expires_at) <= now
					? { state: 'expired' as const }
					: { state: 'ready' as const };
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
				authenticate: Effect.fn('Identity.authenticate')(function* (effectId, credential) {
					const result = yield* executeBuilt(
						effectId,
						database,
						composer
							.select({
								userId: usersTable.id,
								tenantId: usersTable.tenantId,
								email: usersTable.email,
								status: usersTable.status,
								teamId: usersTable.team_id
							})
							.from(sessionsTable)
							.innerJoin(usersTable, eq(usersTable.id, sessionsTable.userId))
							.where(and(eq(sessionsTable.token, credential), gt(sessionsTable.expiresAt, dbNow())))
							.limit(1)
					);
					const first = result.rows[0];
					if (first === undefined) return yield* new AuthenticationError({ reason: 'invalid' });
					const source = yield* Schema.decodeUnknownEffect(UserSubjectSourceRow)(first).pipe(
						Effect.mapError(() => new AuthenticationError({ reason: 'malformed' }))
					);
					return yield* subjectFromSource(effectId, {
						userId: source.id,
						tenantId: source.tenantId,
						...(source.email === undefined ? {} : { email: source.email }),
						...(source.status === undefined ? {} : { status: source.status }),
						teamId: source.team_id
					});
				}),
				/** An external provider's subject, resolved through the same team join a session is. */
				resolveSubject: Effect.fn('Identity.resolveSubject')(
					function* (effectId, provider, externalId) {
						const result = yield* executeBuilt(
							effectId,
							database,
							composer
								.select({
									userId: externalSubjectsTable.user_id,
									tenantId: externalSubjectsTable.tenant_id,
									email: externalSubjectsTable.email,
									teamId: externalSubjectsTable.team_id
								})
								.from(externalSubjectsTable)
								.where(
									and(
										eq(externalSubjectsTable.provider, provider),
										eq(externalSubjectsTable.external_id, externalId)
									)
								)
								.limit(1)
						);
						const first = result.rows[0];
						if (first === undefined) return yield* new AuthenticationError({ reason: 'invalid' });
						const source = yield* Schema.decodeUnknownEffect(ExternalSubjectSourceRow)(first).pipe(
							Effect.mapError(() => new AuthenticationError({ reason: 'malformed' }))
						);
						return yield* subjectFromSource(effectId, {
							userId: source.user_id,
							tenantId: source.tenant_id,
							...(source.email === undefined ? {} : { email: source.email }),
							teamId: source.team_id
						});
					}
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
				 * set. A static identity is minted in memory now and never written to `user`, so
				 * every row this reaches is a person, and the predicate would have been a filter over an
				 * empty set that read as a safety property.
				 */
				accountByTransportIdentity: Effect.fn('Identity.accountByTransportIdentity')(
					function* (effectId, transport, senderAddress) {
						const result = yield* executeBuilt(
							effectId,
							database,
							composer
								.select({
									userId: usersTable.id,
									email: usersTable.email,
									channels: usersTable.channels
								})
								.from(usersTable)
								.where(isNotNull(usersTable.channels))
						);
						for (const row of result.rows) {
							const decoded = yield* Schema.decodeUnknownEffect(TransportAccountRow)(row).pipe(
								Effect.mapError(() => malformedDatabaseRow('identity.accountByTransportIdentity'))
							);
							const held = identitiesOf(decoded.channels);
							if (!held.some((identity) => identityMatches(identity, transport, senderAddress)))
								continue;
							return decoded.email === null
								? { userId: decoded.id }
								: { userId: decoded.id, email: decoded.email };
						}
						return undefined;
					}
				),
				invite: Effect.fn('Identity.invite')(function* (effectId, tenantId, email, invitedBy) {
					const invitationId = randomId();
					const normalizedEmail = email.trim().toLowerCase();
					yield* executeBuilt(
						effectId,
						database,
						composer
							.insert(invitationsTable)
							.values({
								invitation_id: invitationId,
								tenant_id: tenantId,
								email: normalizedEmail,
								invited_by: invitedBy,
								status: 'pending',
								expires_at: dbNowPlusSeconds(INVITATION_EXPIRES_SECONDS)
							})
							.onConflictDoNothing({ target: invitationsTable.invitation_id })
					);
					yield* communication.execute(effectId, {
						_tag: 'Notify',
						recipient: normalizedEmail,
						payload: {
							kind: 'workspace_invitation',
							invitationId,
							tenantId,
							expiresInDays: INVITATION_EXPIRES_SECONDS / 86_400
						}
					});
					yield* identityHooks.emit(effectId, {
						_tag: 'UserInvited',
						invitationId,
						organizationId: tenantId,
						email: normalizedEmail,
						invitedBy
					});
					return invitationId;
				}),
				inspectInvitation,
				acceptInvitation: Effect.fn('Identity.acceptInvitation')(
					function* (effectId, invitationId, subject) {
						if (subject.email === undefined) return { state: 'wrong_account' as const };
						const result = yield* executeBuilt(
							effectId,
							database,
							composer
								.update(invitationsTable)
								.set({ status: 'accepted', accepted_by: subject.userId })
								.where(
									and(
										eq(invitationsTable.invitation_id, invitationId),
										eq(invitationsTable.tenant_id, subject.tenantId),
										eq(invitationsTable.status, 'pending'),
										or(
											isNull(invitationsTable.expires_at),
											gt(invitationsTable.expires_at, dbNow())
										),
										eq(sql<string>`lower(${invitationsTable.email})`, subject.email.toLowerCase())
									)
								)
								.returning({
									tenant_id: invitationsTable.tenant_id,
									email: invitationsTable.email
								})
						);
						const row = result.rows[0];
						if (row === undefined) {
							const inspected = yield* inspectInvitation(
								EffectId.make(`${effectId}:inspect`),
								subject.tenantId,
								invitationId
							);
							if (inspected.state === 'accepted') return { state: 'already_accepted' as const };
							if (inspected.state !== 'ready') return inspected;
							return { state: 'wrong_account' as const };
						}
						const invitation = yield* Schema.decodeUnknownEffect(InvitationAcceptedRow)(row).pipe(
							Effect.mapError(() => malformedDatabaseRow('identity.acceptInvitation'))
						);
						const { email, tenant_id: organizationId } = invitation;
						yield* identityHooks.emit(effectId, {
							_tag: 'MembershipChanged',
							userId: subject.userId,
							organizationId,
							...(email === null ? {} : { email }),
							action: 'joined'
						});
						yield* identityHooks.emit(effectId, {
							_tag: 'UserChanged',
							userId: subject.userId,
							organizationId,
							...(email === null ? {} : { email })
						});
						return { state: 'accepted' as const };
					}
				),
				/** Persists a sign-in code, then submits it directly to the host communication facility. */
				sendCode: Effect.fn('Identity.sendCode')(function* (effectId, email) {
					const auth = yield* authFor(effectId).pipe(
						Effect.mapError((cause) =>
							cause instanceof Database.FacilityError
								? cause
								: new Database.FacilityError({
										operation: 'identity.sendCode',
										code: 'identity_challenge_unavailable',
										message: 'Sign-in challenge storage is unavailable',
										retryable: false,
										outcome: 'known'
									})
						)
					);
					/**
					 * Better Auth's public send endpoint deliberately treats its courier callback as background
					 * work and logs rather than propagates a rejection. That is useful for non-interactive mail
					 * and wrong for sign-in: the UI must not say "sent" when the provider refused the request.
					 * Create the persisted challenge through Better Auth, then await the communication facility
					 * ourselves. Unknown addresses take the same two steps, preserving non-enumeration.
					 */
					const code = yield* Effect.tryPromise({
						try: () => auth.api.createVerificationOTP({ body: { email, type: 'sign-in' } }),
						catch: (cause) =>
							cause instanceof Database.FacilityError
								? cause
								: new Database.FacilityError({
										operation: 'identity.sendCode',
										code: 'identity_challenge_not_persisted',
										message: 'Sign-in challenge could not be persisted',
										retryable: true,
										outcome: 'unknown'
									})
					});
					yield* communication.execute(EffectId.make(`${effectId}:code-delivery`), {
						_tag: 'Send',
						channel: 'email',
						recipient: email,
						payload: {
							kind: 'sign_in_code',
							code,
							purpose: 'sign-in',
							expiresInMinutes: SIGN_IN_CODE_EXPIRES_SECONDS / 60,
							subject: 'Your sign-in code',
							body: `Your sign-in code is ${code}. It expires in ${SIGN_IN_CODE_EXPIRES_SECONDS / 60} minutes.`
						}
					});
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
					const admitted = yield* executeBuilt(
						effectId,
						database,
						composer
							.insert(usersTable)
							.values({
								name: email,
								email,
								emailVerified: true,
								status,
								tenantId,
								team_id: teamId
							})
							.onConflictDoUpdate({
								target: usersTable.email,
								set: {
									tenantId,
									team_id: teamId,
									status,
									updated_at: dbNow()
								}
							})
							.returning({ id: usersTable.id })
					);
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
					const session = yield* executeBuilt(
						EffectId.make(`${effectId}:session-read`),
						database,
						composer
							.select({ userId: sessionsTable.userId })
							.from(sessionsTable)
							.where(eq(sessionsTable.token, signedIn.token))
							.limit(1)
					);
					const sessionUser = yield* Schema.decodeUnknownEffect(
						Schema.Struct({ userId: Schema.NonEmptyString })
					)(session.rows[0]).pipe(
						Effect.mapError(() => new AuthenticationError({ reason: 'invalid' }))
					);
					const admitted = yield* executeBuilt(
						EffectId.make(`${effectId}:user-admit`),
						database,
						composer
							.update(usersTable)
							.set({ tenantId, updated_at: dbNow() })
							.where(eq(usersTable.id, sessionUser.userId))
							.returning({ id: usersTable.id })
					);
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
				startSession,
				startSessionForEmail: Effect.fn('Identity.startSessionForEmail')(
					function* (effectId, email, tenantId) {
						const found = yield* executeBuilt(
							EffectId.make(`${effectId}:user-read`),
							database,
							composer
								.select({ id: usersTable.id })
								.from(usersTable)
								.where(and(eq(usersTable.email, email), eq(usersTable.tenantId, tenantId)))
								.limit(1)
						);
						const member = yield* Schema.decodeUnknownEffect(IdRow)(found.rows[0]).pipe(
							Effect.mapError(() => new AuthenticationError({ reason: 'invalid' }))
						);
						return yield* startSession(effectId, member.id, tenantId);
					}
				),
				endSession: Effect.fn('Identity.endSession')(function* (effectId, credential) {
					// Deleted rather than flagged revoked. A revoked row that still authenticates if one
					// query forgets the flag is the failure the old two-writer design actually had.
					yield* executeBuilt(
						effectId,
						database,
						composer.delete(sessionsTable).where(eq(sessionsTable.token, credential))
					);
				}),
				readFounderClaim: Effect.fn('Identity.readFounderClaim')(function* (effectId, identifier) {
					const result = yield* executeBuilt(
						effectId,
						database,
						composer
							.select({ value: verificationTable.value })
							.from(verificationTable)
							.where(eq(verificationTable.identifier, identifier))
							.limit(1)
					);
					return yield* Schema.decodeUnknownEffect(Schema.optional(SecretRow))(result.rows[0]).pipe(
						Effect.map((row) => row?.value),
						Effect.mapError(() => malformedDatabaseRow('identity.founderClaim.read'))
					);
				}),
				recordFounderClaim: Effect.fn('Identity.recordFounderClaim')(
					function* (effectId, identifier, value, expiresAt) {
						yield* executeBuilt(
							effectId,
							database,
							composer.insert(verificationTable).values({ identifier, value, expiresAt })
						);
					}
				),
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
					const memberRows = yield* executeBuilt(
						EffectId.make(`${effectId}:members`),
						database,
						composer
							.select({
								id: usersTable.id,
								email: usersTable.email,
								teamId: usersTable.team_id,
								status: usersTable.status
							})
							.from(usersTable)
							.where(eq(usersTable.tenantId, tenantId))
					);
					const externalRows = yield* executeBuilt(
						EffectId.make(`${effectId}:external-members`),
						database,
						composer
							.select({
								id: externalSubjectsTable.user_id,
								email: externalSubjectsTable.email,
								teamId: externalSubjectsTable.team_id
							})
							.from(externalSubjectsTable)
							.where(eq(externalSubjectsTable.tenant_id, tenantId))
					);
					const invitationRows = yield* executeBuilt(
						EffectId.make(`${effectId}:invitations`),
						database,
						composer
							.select({
								invitation_id: invitationsTable.invitation_id,
								email: invitationsTable.email,
								status: invitationsTable.status,
								invited_by: invitationsTable.invited_by,
								expires_at: invitationsTable.expires_at
							})
							.from(invitationsTable)
							.where(eq(invitationsTable.tenant_id, tenantId))
							.orderBy(desc(invitationsTable.created_at))
							.limit(200)
					);
					const auditRows = yield* executeBuilt(
						EffectId.make(`${effectId}:audit`),
						database,
						composer
							.select({
								sequence: auditTable.sequence,
								action: auditTable.kind,
								actor: auditTable.subject_id,
								payload: auditTable.payload,
								at: auditTable.created_at
							})
							.from(auditTable)
							.orderBy(desc(auditTable.sequence))
							.limit(200)
					);
					const decodedMemberSources = yield* Schema.decodeUnknownEffect(
						Schema.Array(MemberSourceRow)
					)(memberRows.rows).pipe(
						Effect.mapError(() => malformedDatabaseRow('identity.workspaceAccess.members'))
					);
					const decodedExternalSources = yield* Schema.decodeUnknownEffect(
						Schema.Array(ExternalMemberSourceRow)
					)(externalRows.rows).pipe(
						Effect.mapError(() => malformedDatabaseRow('identity.workspaceAccess.externalMembers'))
					);
					const decodedInvitations = yield* Schema.decodeUnknownEffect(Schema.Array(InvitationRow))(
						invitationRows.rows
					).pipe(
						Effect.mapError(() => malformedDatabaseRow('identity.workspaceAccess.invitations'))
					);
					const decodedAudits = yield* Schema.decodeUnknownEffect(Schema.Array(AuditSourceRow))(
						auditRows.rows
					).pipe(Effect.mapError(() => malformedDatabaseRow('identity.workspaceAccess.audit')));
					const teamRows = yield* readTeamRows(EffectId.make(`${effectId}:teams`));
					const teamNames = new Map(teamRows.map((team) => [team.id, team.name] as const));
					const groupedMembers = new Map<string, Schema.Schema.Type<typeof MemberRow>>();
					for (const row of decodedMemberSources) {
						groupedMembers.set(row.id, {
							id: row.id,
							email: row.email,
							team: row.team_id === null ? null : (teamNames.get(row.team_id) ?? null),
							status: row.status
						});
					}
					for (const row of decodedExternalSources) {
						const current = groupedMembers.get(row.user_id);
						if (current !== undefined) continue;
						groupedMembers.set(row.user_id, {
							id: row.user_id,
							email: row.email,
							team: row.team_id === null ? null : (teamNames.get(row.team_id) ?? null),
							status: NORMAL_STATUS
						});
					}
					const members = [...groupedMembers.values()]
						.toSorted((left, right) => left.id.localeCompare(right.id))
						.map((row) => {
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
					const teams = teamRows.map(teamFromRow);
					return {
						members,
						invitations: decodedInvitations.map((row) => {
							const { email, invitation_id: id, invited_by, status, expires_at } = row;
							return {
								id,
								email,
								role: 'basic',
								status,
								...(invited_by === null ? {} : { invitedBy: invited_by }),
								...(expires_at === null ? {} : { expiresAt: expires_at })
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
								id: String(row.sequence),
								action: row.kind,
								actor: row.subject_id,
								...(subject === undefined ? {} : { subject }),
								at: row.created_at
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
						const existingTeams = yield* readTeamRows(EffectId.make(`${effectId}:team-name-check`));
						if (existingTeams.some((team) => team.name.toLowerCase() === name.toLowerCase()))
							return { _tag: 'Refused', reason: `a team called ${name} already exists` } as const;
						const created = yield* executeBuilt(
							EffectId.make(`${effectId}:team-create`),
							database,
							composer
								.insert(teamsTable)
								.values({ name, parent_id: parentId, description: draft.description ?? null })
								.onConflictDoNothing({ target: teamsTable.name })
								.returning(teamProjection)
						);
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
							const hierarchy = yield* readTeamRows(EffectId.make(`${effectId}:team-cycle`));
							if (subtreeContains(current.id, parentId, hierarchy)) {
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
						const siblings = yield* readTeamRows(EffectId.make(`${effectId}:team-name-check`));
						if (
							siblings.some(
								(team) => team.id !== current.id && team.name.toLowerCase() === name.toLowerCase()
							)
						)
							return { _tag: 'Refused', reason: `a team called ${name} already exists` } as const;
						const updated = yield* executeBuilt(
							EffectId.make(`${effectId}:team-update`),
							database,
							composer
								.update(teamsTable)
								.set({
									name,
									parent_id: parentId,
									description,
									updated_at: dbNow()
								})
								.where(eq(teamsTable.id, current.id))
								.returning(teamProjection)
						);
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
						const heldUsers = yield* executeBuilt(
							EffectId.make(`${effectId}:team-members`),
							database,
							composer
								.select({ id: usersTable.id })
								.from(usersTable)
								.where(and(eq(usersTable.team_id, current.id), eq(usersTable.tenantId, tenantId)))
								.limit(1)
						);
						const heldExternal = yield* executeBuilt(
							EffectId.make(`${effectId}:team-external-members`),
							database,
							composer
								.select({ id: externalSubjectsTable.id })
								.from(externalSubjectsTable)
								.where(
									and(
										eq(externalSubjectsTable.team_id, current.id),
										eq(externalSubjectsTable.tenant_id, tenantId)
									)
								)
								.limit(1)
						);
						if (heldUsers.rows[0] !== undefined || heldExternal.rows[0] !== undefined) {
							return {
								_tag: 'Refused',
								reason: `${current.name} still has members — move them to another team before deleting it`
							} as const;
						}
						const deleted = yield* executeBuilt(
							EffectId.make(`${effectId}:team-delete`),
							database,
							composer
								.delete(teamsTable)
								.where(eq(teamsTable.id, current.id))
								.returning(teamProjection)
						);
						if (deleted.rows[0] === undefined)
							return { _tag: 'Refused', reason: `there is no team ${teamId}` } as const;
						yield* executeBuilt(
							EffectId.make(`${effectId}:team-reparent`),
							database,
							composer
								.update(teamsTable)
								.set({ parent_id: null, updated_at: dbNow() })
								.where(eq(teamsTable.parent_id, current.id))
						);
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
						const moved = yield* executeBuilt(
							EffectId.make(`${effectId}:team-assign`),
							database,
							composer
								.update(usersTable)
								.set({ team_id: team?.id ?? null, updated_at: dbNow() })
								.where(and(eq(usersTable.id, memberId), eq(usersTable.tenantId, tenantId)))
								.returning({ id: usersTable.id, email: usersTable.email })
						);
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
					const result = yield* executeBuilt(
						effectId,
						database,
						composer
							.select({ settings: workspaceIdentitySettingsTable.settings })
							.from(workspaceIdentitySettingsTable)
							.where(eq(workspaceIdentitySettingsTable.tenant_id, tenantId))
							.limit(1)
					);
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
