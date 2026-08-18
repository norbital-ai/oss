import { Context, Effect, Layer, Schema } from 'effect';
import type { EffectId } from '@norbital-ai/bolt-protocol';
import { Communication, IdentityHooks } from '../facilities/services.js';
import { Database } from '../facilities/database.js';
import { AUTH_MODELS, makeAuth } from './auth.js';

export const Subject = Schema.Struct({
	userId: Schema.NonEmptyString,
	tenantId: Schema.NonEmptyString,
	roles: Schema.Array(Schema.NonEmptyString),
	teams: Schema.Array(Schema.NonEmptyString),
	email: Schema.optionalKey(Schema.NonEmptyString),
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
 * Projects a subject row into the shape `Subject` describes.
 *
 * `email` is nullable in both subject tables and `startSession` writes no email at all, so the
 * column comes back as an explicit null — which an optional key rejects, and every session the
 * service itself started failed to authenticate as `malformed`. An unknown email is an *absent*
 * key, not a null one, which is already how `workspaceAccess` reads the same column; widening
 * `Subject` instead would push null-handling onto every consumer of an authenticated subject.
 *
 * Roles and teams are filtered rather than trusted whole: a non-string entry in either jsonb array
 * can only ever drop a role, so this narrows access and never grants it.
 *
 * A row missing `userId` or `tenantId` still fails to decode — those stay `NonEmptyString`, so a
 * genuinely malformed row is still refused rather than admitted as an anonymous subject.
 */
const subjectFromRow = (row: unknown): Record<string, unknown> => {
	const email = IdentityRows.text(row, 'email');
	const impersonatedBy = IdentityRows.text(row, 'impersonatedBy');
	return {
		userId: IdentityRows.text(row, 'userId'),
		tenantId: IdentityRows.text(row, 'tenantId'),
		roles: IdentityRows.strings(row, 'roles'),
		teams: IdentityRows.strings(row, 'teams'),
		...(email === undefined ? {} : { email }),
		...(impersonatedBy === undefined ? {} : { impersonatedBy })
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
	readonly admit: (
		effectId: EffectId,
		tenantId: string,
		email: string,
		roles: ReadonlyArray<string>,
		teams: ReadonlyArray<string>
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
			teams: ReadonlyArray<string>;
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
	readonly teams: ReadonlyArray<Readonly<{ id: string; name: string }>>;
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
					readSubject(
						effectId,
						`select u."norbital_id" as "userId", u."tenantId" as "tenantId", u."roles" as "roles", u."teams" as "teams", u."email" as "email" from ${AUTH_MODELS.session} s join ${AUTH_MODELS.user} u on u."norbital_id" = s."userId" where s."token" = $1 and s."expiresAt" > now()`,
						[credential]
					)
				),
				resolveSubject: Effect.fn('Identity.resolveSubject')((effectId, provider, externalId) =>
					readSubject(
						effectId,
						'select user_id as "userId", tenant_id as "tenantId", roles, teams, email from bolt_external_subjects where provider = $1 and external_id = $2',
						[provider, externalId]
					)
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
							...(email === undefined ? {} : { email }),
							roles: [],
							teams: []
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
				 * Gives an address roles and teams in this workspace before anybody signs in as it.
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
				admit: Effect.fn('Identity.admit')(function* (effectId, tenantId, email, roles, teams) {
					const admitted = yield* database.execute(effectId, {
						_tag: 'Query',
						sql: `insert into ${AUTH_MODELS.user} ("norbital_id", "name", "email", "emailVerified", "kind", "tenantId", "roles", "teams")
					      values (gen_random_uuid(), $1, $1, true, 'person', $2, $3::jsonb, $4::jsonb)
					      on conflict ("email") do update set
					        "tenantId" = excluded."tenantId",
					        "roles" = excluded."roles",
					        "teams" = excluded."teams",
					        "norbital_updated_at" = now()
					      returning "norbital_id" as "id"`,
						parameters: [email, tenantId, JSON.stringify([...roles]), JSON.stringify([...teams])]
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
						roles: [...roles],
						teams: [...teams]
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
						organizationId: tenantId,
						roles: [],
						teams: []
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
						organizationId: tenantId,
						roles: [],
						teams: []
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
						sql: `select user_id as "id", max(email) as "email", jsonb_agg(distinct role) filter (where role is not null) as "roles", jsonb_agg(distinct team) filter (where team is not null) as "teams"
						  from (
							-- Cast to text so the union matches: identity is keyed by \`norbital_id uuid\`, while an
							-- external subject's id is whatever its provider calls it, and both are only ever
							-- read back out of this projection as a string.
							select "norbital_id"::text as user_id, "email", "roles", "teams" from ${AUTH_MODELS.user} where "tenantId" = $1 and "kind" = 'person'
							union all
							select user_id, email, roles, teams from bolt_external_subjects where tenant_id = $1
						  ) subjects
						  left join lateral jsonb_array_elements_text(coalesce(subjects.roles, '[]'::jsonb)) as role on true
						  left join lateral jsonb_array_elements_text(coalesce(subjects.teams, '[]'::jsonb)) as team on true
						  group by user_id
						  order by user_id`,
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
						const roles = IdentityRows.strings(row, 'roles');
						return {
							id: IdentityRows.text(row, 'id') ?? 'unknown',
							email: IdentityRows.text(row, 'email') ?? '',
							name:
								IdentityRows.text(row, 'email')?.split('@')[0] ??
								IdentityRows.text(row, 'id') ??
								'',
							role: roles.includes('admin')
								? 'admin'
								: roles.includes('manager')
									? 'manager'
									: 'basic',
							status: 'active',
							teams: IdentityRows.strings(row, 'teams')
						};
					});
					const teamNames = [...new Set(members.flatMap((member) => member.teams))].toSorted();
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
						teams: teamNames.map((name) => ({ id: name, name })),
						events: auditRows.rows.map((row) => {
							const payload = Reflect.get(Object(row), 'payload');
							const subject = Schema.is(Schema.Record(Schema.String, Schema.Json))(payload)
								? (IdentityRows.text(payload, 'collection') ??
									IdentityRows.text(payload, 'requestId'))
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
