import { Effect, Schema } from 'effect';
import { EffectId, type DispatchResponse, type Invocation } from '@norbital-ai/bolt-protocol';
import { AccessControl } from './access/access-control.js';
import { Agents } from './agents/agents.js';
import { AI, Files } from './facilities/services.js';
import { Approvals, ApprovalState } from './approvals/approvals.js';
import { Automations } from './automations/automations.js';
import { Channels } from './channels/channels.js';
import { Collections } from './collections/collections.js';
import { compileOrderTerms, makeWhereContext } from './collections/where.js';
import { Integrations } from './integrations/integrations.js';
import { Identity, Subject } from './identity/identity.js';
import { Notification, Notifications } from './notifications/notifications.js';
import { RemoteRegistry } from './remotes.js';
import { WorkspaceSchema } from './schema/workspace-schema.js';
import { Secrets } from './secrets/secrets.js';
import { PersonalSecrets } from './secrets/personal-secrets.js';
import { describeGeneratedColumnWrite, describeInvalidCustomValue } from './collections/custom-values.js';
import { Sync, SyncCursor } from './sync/sync.js';
import { AuthoredRuntimeService, makeAuthoringApi, makeBoundAuthoringOps, runAuthoredHandler } from './collections/authored.js';
import { DispatchError, Workspace } from './workspace.js';

export { DispatchError } from './workspace.js';

const VisibleAppsInput = Schema.Struct({ subject: Subject });
const ImpersonateInput = Schema.Struct({ actor: Subject, target: Subject });
const ImpersonateTeamInput = Schema.Struct({ actor: Subject, teamId: Schema.NonEmptyString });
/**
 * Both halves are minted by the boundary, never read from the payload.
 *
 * `actor` is the credential holder and `impersonatedTeam` is what the boundary resolved out of the
 * host's header — so this command reports the preview the runtime is *actually* running, not the one
 * a browser believes it asked for. A sidebar that trusted its own cookie would keep showing a team
 * as active after the runtime had refused it.
 */
const ImpersonationStateInput = Schema.Struct({ actor: Subject, impersonatedTeam: Schema.NullOr(Schema.String) });
const AccessDecisionInput = Schema.Struct({ subject: Subject, action: Schema.NonEmptyString, resource: Schema.NonEmptyString });
const AccessMaskInput = Schema.Struct({ subject: Subject, action: Schema.NonEmptyString, resource: Schema.NonEmptyString, value: Schema.Record(Schema.String, Schema.Json) });
const ApprovalRequestInput = Schema.Struct({ subject: Subject, requestId: Schema.NonEmptyString, operation: Schema.Json });
const ApprovalDecideInput = Schema.Struct({ subject: Subject, state: ApprovalState, decision: Schema.Literals(['approve', 'reject']), reason: Schema.optionalKey(Schema.String) });
const SyncDiffInput = Schema.Struct({ subject: Subject, cursor: SyncCursor, limit: Schema.Number });
const AgentTurnInput = Schema.Struct({ subject: Subject, agent: Schema.NonEmptyString, conversationId: Schema.NonEmptyString, message: Schema.String });
const AgentTitleInput = Schema.Struct({ conversationId: Schema.NonEmptyString });
const CollectionFindInput = Schema.Struct({
	subject: Subject,
	collection: Schema.NonEmptyString,
	limit: Schema.optionalKey(Schema.Number),
	where: Schema.optionalKey(Schema.Json),
	orderBy: Schema.optionalKey(Schema.Json),
	with: Schema.optionalKey(Schema.Json),
	search: Schema.optionalKey(Schema.String),
	after: Schema.optionalKey(Schema.String),
	columns: Schema.optionalKey(Schema.Json)
});
const SecretsWriteInput = Schema.Struct({ subject: Subject, name: Schema.NonEmptyString, value: Schema.String });
/**
 * Note what these do *not* declare: no `subject`, no `userId`, no owner of any kind.
 *
 * Every other input on this page decodes a `Subject` because the command acts on tenant data and has
 * to say on whose authority. A personal secret has exactly one legitimate owner — the person whose
 * credential this invocation authenticated — and the service reads that from `Identity.CurrentSubject`.
 * Accepting an owner here, even one the boundary overwrites, would put a user id on the path from a
 * request body to a WHERE clause, and the only safe number of such paths is none.
 */
const PersonalSecretsWriteInput = Schema.Struct({ name: Schema.NonEmptyString, value: Schema.String });
const PersonalSecretsNameInput = Schema.Struct({ name: Schema.NonEmptyString });
const DataBrowserInput = Schema.Struct({ collection: Schema.NonEmptyString, input: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)) });
/**
 * What a host may still assert once it has proved who it is, which is only ever *less* authority.
 *
 * This used to carry `subject`, `roles`, `teams` and `impersonatedUser` as well, and the branch below
 * minted a subject straight out of them whenever `subject` was absent — so
 * `POST /_bolt/plugin/data-browser/query` with `{"trustedContext":{"roles":["admin"]}}` read any
 * collection in the tenant, unauthenticated. Those four fields are gone rather than checked: a
 * credential names a session row, and that row's roles are the answer, so there was nothing for the
 * payload's copy to do except be believed. `impersonatedSubject` survives because it narrows rather
 * than widens — `AccessControl.impersonate` still has to authorize the authenticated actor for it.
 */
const PluginContext = Schema.Struct({
	impersonatedSubject: Schema.optionalKey(Schema.NonEmptyString)
});
const CollectionCreateInput = Schema.Struct({ subject: Subject, collection: Schema.NonEmptyString, id: Schema.NonEmptyString, values: Schema.Record(Schema.String, Schema.Json) });
const CollectionUpdateInput = CollectionCreateInput;
const CollectionDeleteInput = Schema.Struct({ subject: Subject, collection: Schema.NonEmptyString, id: Schema.NonEmptyString });
const CollectionMutation = Schema.Struct({ collection: Schema.NonEmptyString, id: Schema.NonEmptyString, values: Schema.Record(Schema.String, Schema.Json) });
const CollectionCreateManyInput = Schema.Struct({ subject: Subject, records: Schema.Array(CollectionMutation) });
const AutomationStartInput = Schema.Struct({ subject: Subject, name: Schema.NonEmptyString, input: Schema.Json });
const ChannelReceiveInput = Schema.Struct({ subject: Subject, channel: Schema.NonEmptyString, conversationId: Schema.NonEmptyString, message: Schema.String });
/**
 * `binding` is what a scheduled pull carries and an enqueued one does not.
 *
 * The registration `activate` hands the host names one binding, because that is the granularity a
 * `+integrations.ts` cron is declared at; `install` and `reconcile` enqueue without it and mean
 * "every binding this integration has".
 */
const IntegrationPullInput = Schema.Struct({ name: Schema.NonEmptyString, cursor: Schema.Json, binding: Schema.optionalKey(Schema.NonEmptyString) });
const NamedInput = Schema.Struct({ name: Schema.NonEmptyString });
const TaskInput = Schema.Struct({ taskId: Schema.NonEmptyString, input: Schema.optionalKey(Schema.Json) });
/** The task payload an authored automation runs from: the runtime's trigger context and the subject the runtime stamped at enqueue time. */
const AutomationTaskInput = Schema.Struct({
	args: Schema.Record(Schema.String, Schema.Json),
	scope: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
	bolt_run_as: Subject
});
const AgentStartInput = Schema.Struct({ subject: Subject, agent: Schema.NonEmptyString, conversationId: Schema.NonEmptyString });
const AgentResumeInput = Schema.Struct({ taskId: Schema.NonEmptyString, conversationId: Schema.NonEmptyString });
const AgentVerifierInput = Schema.Struct({ conversationId: Schema.NonEmptyString, verifier: Schema.Json });
const AgentHistoryInput = Schema.Struct({ subject: Subject, conversationId: Schema.NonEmptyString });
const AgentListConversationsInput = Schema.Struct({ subject: Subject });
const SkillInput = Schema.Struct({ agent: Schema.optionalKey(Schema.NonEmptyString), name: Schema.optionalKey(Schema.NonEmptyString) });
const ApprovalStatusInput = Schema.Struct({ requestId: Schema.NonEmptyString });
const ApprovalWithdrawInput = Schema.Struct({ subject: Subject, state: ApprovalState });
const SyncShapeInput = Schema.Struct({ subject: Subject });
const SyncSnapshotInput = Schema.Struct({
	subject: Subject,
	collection: Schema.NonEmptyString,
	after: Schema.optional(Schema.String),
	limit: Schema.optional(Schema.Number)
});
const SyncCompactInput = Schema.Struct({ retentionDays: Schema.optional(Schema.Number) });
const SyncMutateInput = Schema.Struct({ subject: Subject, changes: Schema.Array(Schema.Struct({ cursor: SyncCursor, collection: Schema.NonEmptyString, recordId: Schema.NonEmptyString, operation: Schema.Literals(['create', 'update', 'delete']), record: Schema.optionalKey(Schema.Json) })) });
const ChannelNameInput = Schema.Struct({ channel: Schema.NonEmptyString });
const ChannelReplyInput = Schema.Struct({ channel: Schema.NonEmptyString, recipient: Schema.NonEmptyString, payload: Schema.Json });
/**
 * One pushed webhook delivery, as the boundary receives it.
 *
 * `body` is a string and `headers` travel beside it, because the source's HMAC was computed over the
 * exact bytes it sent: `JSON.stringify(JSON.parse(body))` is a different string for the same
 * document, so a parsed payload cannot be verified against anything. This used to be
 * `{ name, receiptId, input: Schema.Json }` — a parsed body and a caller-nominated dedup key, which
 * is a shape in which verification is not merely absent but impossible.
 *
 * There is no `receiptId` here for the same reason there is no `subject`: it decides whether a
 * delivery is a duplicate, so a caller that supplies it decides whether a write happens. It is
 * derived instead, from the header the binding declares or from the verified digest.
 */
const IntegrationReceiveInput = Schema.Struct({
	name: Schema.NonEmptyString,
	binding: Schema.NonEmptyString,
	headers: Schema.Record(Schema.String, Schema.String),
	body: Schema.String
});
/**
 * `input` is optional because the drain's own registration does not carry one.
 *
 * A scheduled flush means "empty this integration's outbox"; the only thing a caller may narrow is
 * how much of it to attempt in one invocation. It cannot name a delivery — a caller that could
 * would be a caller who can replay one.
 */
const IntegrationFlushInput = Schema.Struct({ name: Schema.NonEmptyString, input: Schema.optionalKey(Schema.Json) });
const NotificationRecipientInput = Schema.Struct({ recipient: Schema.NonEmptyString, unreadOnly: Schema.optionalKey(Schema.Boolean) });
const NotificationReadInput = Schema.Struct({ recipient: Schema.NonEmptyString, id: Schema.NonEmptyString });
const IdentityInviteInput = Schema.Struct({ tenantId: Schema.NonEmptyString, email: Schema.NonEmptyString, invitedBy: Schema.NonEmptyString });
const IdentityAcceptInput = Schema.Struct({ invitationId: Schema.NonEmptyString, userId: Schema.NonEmptyString });
const IdentitySessionInput = Schema.Struct({ userId: Schema.NonEmptyString, tenantId: Schema.NonEmptyString });
const IdentitySendCodeInput = Schema.Struct({ email: Schema.NonEmptyString });
const IdentityAdmitFounderInput = Schema.Struct({ email: Schema.NonEmptyString, tenantId: Schema.NonEmptyString });
const IdentityVerifyCodeInput = Schema.Struct({ email: Schema.NonEmptyString, code: Schema.NonEmptyString, tenantId: Schema.NonEmptyString });

/**
 * The only commands reachable without a credential.
 *
 * Sign-in cannot require a session; producing one is what it is for. The exemption is stated here,
 * at the gate, as a closed set of exactly two names — not as a `case` that quietly skips the check.
 * Five `schema.*` commands each shipped unguarded because the check was per-case, and the comment
 * below the schema prefix gate says so; this is the same lesson applied in the other direction.
 *
 * Neither command answers anything about an address the caller did not supply, and neither reveals
 * whether an address is already known, so an unauthenticated caller learns nothing from either.
 * Rate limiting and bot checks are the host's: a bolt cannot see the request rate of a surface it
 * does not serve.
 */
const SIGN_IN_COMMANDS: ReadonlySet<string> = new Set(['identity.sendCode', 'identity.verifyCode']);
const IdentityCredentialInput = Schema.Struct({ credential: Schema.NonEmptyString });
const IdentitySettingsInput = Schema.Struct({ tenantId: Schema.NonEmptyString });
const IdentityAuthenticateInput = Schema.Struct({ credential: Schema.NonEmptyString });
const IdentityResolveInput = Schema.Struct({ provider: Schema.NonEmptyString, externalId: Schema.NonEmptyString });
const CollectionRecordInput = Schema.Struct({ subject: Subject, collection: Schema.NonEmptyString, id: Schema.NonEmptyString });

/** Owns wire decoding, JSON responses, and credential extraction shared by every invocation kind. */
const DispatchValues = {
	decode: <S extends Schema.Top>(schema: S, value: unknown) => Schema.decodeUnknownEffect(schema)(value).pipe(
		Effect.mapError(() => new DispatchError({ code: 'invalid_input', message: 'Command input did not match its schema' }))
	),
	json: (value: Schema.Json): DispatchResponse => ({ status: 200, headers: {}, value }),
	// The page ceiling belongs to this boundary, not the collections service: a client asks for a
	// page, while an authored server-side handler asks for the exact rows its computation needs.
	collectionQuery: (input: typeof CollectionFindInput.Type) => ({
		collection: input.collection,
		limit: Math.max(1, Math.min(input.limit ?? 100, 500)),
		...(input.where === undefined ? {} : { where: input.where }),
		...(input.orderBy === undefined ? {} : { orderBy: input.orderBy }),
		...(input.with === undefined ? {} : { with: input.with }),
		...(input.search === undefined ? {} : { search: input.search }),
		...(input.after === undefined ? {} : { after: input.after })
		// `columns` is accepted on the wire but deliberately not forwarded: Bolt's read path has no
		// projection, it selects the whole row. Honouring it would mean rewriting the select list *and*
		// re-adding every ordering column the cursor is cut from plus every relation key `with` joins
		// on, then stripping them back out — so it stays unimplemented rather than half-wired into a
		// query that returns fewer columns than the cursor and the prefetch both need.
	}),
	/**
	 * The team this invocation asks to be viewed as, or `undefined`.
	 *
	 * The same `x-colony-impersonated-*` family the plugin path reads out of `trustedContext`, carried
	 * as a header because a `Command` has no `trustedContext` field — headers are already where it
	 * carries its credential, and a second channel would be a second thing to authenticate.
	 *
	 * Nothing here trusts the value. It names a policy the workspace itself declares, and
	 * `subjectAsTeam` grants it only after checking, against the subject this boundary just
	 * authenticated from the credential, that the actor holds `impersonator`.
	 */
	impersonatedTeamFromHeaders: (headers: Readonly<Record<string, ReadonlyArray<string>>>): string | undefined => {
		const value = Object.entries(headers).find(([name]) => name.toLowerCase() === 'x-colony-impersonated-team')?.[1][0]?.trim();
		return value === undefined || value === '' ? undefined : value;
	},
	credentialFromHeaders: (headers: Readonly<Record<string, ReadonlyArray<string>>>): string | undefined => {
		const authorization = Object.entries(headers).find(([name]) => name.toLowerCase() === 'authorization')?.[1][0];
		if (authorization !== undefined) return authorization.replace(/^Bearer\s+/i, '');
		const cookie = Object.entries(headers).find(([name]) => name.toLowerCase() === 'cookie')?.[1].join(';');
		return cookie?.split(';').map((part) => part.trim()).find((part) => part.startsWith('bolt_session='))?.slice('bolt_session='.length);
	}
};
const decode = DispatchValues.decode;

/**
 * Refuses a write whose `custom()` value does not match the schema its type declares.
 *
 * It lives at this boundary rather than inside Collections because a malformed value is exactly what
 * `invalid_input` already means here — so the check reuses the failure the boundary already has,
 * instead of introducing one that every service touching a write would have to widen to carry.
 */
const checkWrittenValues = Effect.fn('Bolt.checkWrittenValues')(function* (collection: string, values: Readonly<Record<string, Schema.Json>>) {
	const workspace = yield* Workspace.Service;
	const definition = yield* workspace.collection(collection);
	// Both faults are the same kind of thing — values this collection will not accept — so they are
	// reported the same way, through the `invalid_input` the boundary already has.
	const invalid =
		describeGeneratedColumnWrite(definition.fields, values) ??
		describeInvalidCustomValue(definition.fields, values, workspace.definition.customTypes);
	if (invalid !== undefined) yield* Effect.fail(new DispatchError({ code: 'invalid_input', message: invalid }));
});
const json = DispatchValues.json;

/**
 * The authority a `schema.*` command requires, and the proof the caller holds it.
 *
 * These commands used to run for any authenticated subject in the tenant — and, on a `Task` or a
 * non-data-browser `Plugin` invocation, for no verified subject at all, because those tags carry
 * their input through untouched. `schema.migrate` opens a DDL transaction, so a tenant-wide
 * `create table` sat behind an ordinary employee's session token and behind an unauthenticated task
 * payload.
 *
 * `schema` is a named resource in the vocabulary `secrets` already uses, so an authored policy
 * grants it the way it grants everything else — `{ actions: ['read'], apps: ['schema'] }` — and the
 * admin policy the compiler always appends (`actions: ['*'], apps: ['*']`) covers it with no
 * template changing.
 *
 * Reading the plan is separated from applying it because they are different powers. `plan`,
 * `fingerprint`, `validate` and `verify` disclose the whole schema *unfiltered* — unlike
 * `workspace.manifest`, which drops the collections the subject may not read — while `migrate`
 * rewrites the database. `manage` is the default so that a sixth `schema.*` command added later is
 * gated as a mutation until somebody decides otherwise.
 */
const SCHEMA_RESOURCE = 'schema';
const SCHEMA_READ_COMMANDS: ReadonlySet<string> = new Set(['schema.plan', 'schema.fingerprint', 'schema.validate', 'schema.verify']);
// Only a `Command` reaches here at all: `authorizeInvocationProvenance` has already refused the two
// credential-free tags, on which the `subject` this decodes would be whatever the payload claimed.
const authorizeSchemaCommand = Effect.fn('Bolt.authorizeSchemaCommand')(function* (command: string, commandInput: unknown) {
	const action = SCHEMA_READ_COMMANDS.has(command) ? 'read' : 'manage';
	const input = yield* decode(Schema.Struct({ subject: Subject }), commandInput);
	yield* (yield* AccessControl.Service).authorize(input.subject, action, SCHEMA_RESOURCE);
});

/**
 * The commands the runtime enqueues for itself, which is the whole of what a `Task` may run.
 *
 * A durable task is a message the runtime posted to itself and the host handed back; nothing about
 * the message proves that, because a `Task` carries no credential and never did. What can be checked
 * is the other end: whether this command is one the runtime ever enqueues. Everything here is
 * addressed by a name the workspace declared or by a record the runtime already wrote, and none of
 * it takes an identity — `integrations.pull`/`flush` and `automations.<name>` are the runtime's own
 * machinery, `agents.resume` continues a conversation `Agents.turn` started, and
 * `collections.resume` takes `{ requestId }` and derives its authority from the stored approval:
 * `Collections.resume` refuses a request that is not `Approved` and replays the write under the
 * subject recorded when the original create was authenticated.
 *
 * `automations.<name>` is resolved against the declared automations rather than matched on the
 * prefix, because `automations.start`, `.register`, `.runStep`, `.resume`, `.status` and `.cancel`
 * share it and are host commands rather than enqueued ones.
 */
const ENQUEUED_COMMANDS: ReadonlySet<string> = new Set(['integrations.pull', 'integrations.flush', 'agents.resume', 'collections.resume', 'collections.discard']);

/**
 * Which invocation tags may reach the command switch, and on what authority.
 *
 * `POST /_bolt/plugin/<anything>/<command>` builds a `Plugin` invocation out of a URL and a request
 * body with no authentication anywhere, and a `Task` carries no credential by construction. Both
 * handed their input to the switch untouched, so the switch was a second, unauthenticated command
 * port: every case that does not happen to decode a `Subject` — `identity.endSession` revoking any
 * session by bare token, `notifications.list`/`markRead` over any recipient, every
 * `automations.*`, `integrations.install`/`disable`/`receive`, `channels.register`/`reply`,
 * `approvals.status`/`timeline`, `agents.title`/`cancel`/`updateVerifier` — ran for anyone who could
 * reach the port. The `MINTED_IDENTITY` refusal below closed only the cases that name an identity to
 * forge, which is why the remainder outnumbered it.
 *
 * So the gate is default-deny and it is one gate, at the point where a credential is turned into a
 * subject rather than in the thirty-eight cases that lacked one: a `Plugin` gets the plugin surface
 * (`data-browser`, resolved above from its host-supplied context) and nothing else, and a `Task`
 * gets exactly what the runtime enqueues. A case added tomorrow is refused on both tags until
 * somebody enqueues it — the opposite polarity to the per-command list that let five `schema.*`
 * commands each ship without a check.
 */
const authorizeInvocationProvenance = Effect.fn('Bolt.authorizeInvocationProvenance')(function* (tag: Invocation['_tag'], command: string) {
	const enqueued =
		tag === 'Task' &&
		(ENQUEUED_COMMANDS.has(command) || (yield* Workspace.Service).definition.automations.some(({ name }) => `automations.${name}` === command));
	if (!enqueued) {
		yield* new AccessControl.AccessDenied({
			action: 'invoke',
			resource: command,
			reason: `a ${tag} invocation carries no credential, and ${command} is not a command the runtime enqueues`
		});
	}
});

/**
 * The identity fields this boundary mints, and why a payload may never supply one.
 *
 * On a `Command` the five below are overwritten with values derived from an authenticated
 * credential, so whatever the input claimed about who it is has already been discarded before any
 * case reads it. A `Task` carries no credential, and a non-data-browser `Plugin` is an
 * unauthenticated `POST /_bolt/plugin/<anything>/<command>` — both hand their input to the switch
 * untouched, so on those tags these keys are claims rather than facts. Every case that decodes
 * `subject: Subject` then authorises that claim: `secrets.write` and `secrets.status` took it
 * straight to `authorize(subject, 'manage', 'secrets')` and the vault, `access.impersonate` minted a
 * subject from it, and every `collections.*` read and write ran as it. `identity.startSession` is
 * the same hole one field down — it would have issued a session credential for whatever `userId`
 * the payload named.
 *
 * So the refusal lives where identity is minted, once, rather than in the cases that consume it: a
 * per-case check is exactly what let five `schema.*` commands each ship without one, and the next
 * case to decode a `Subject` would have shipped without one too.
 *
 * It still earns its place behind `authorizeInvocationProvenance`, which now refuses every command a
 * credential-free tag has no business running: what survives that gate is the enqueued set, and
 * `automations.<name>` forwards its whole input to an authored automation. Without this, a task
 * payload could smuggle a subject in through that input.
 */
const MINTED_IDENTITY = ['subject', 'actor', 'userId', 'tenantId', 'invitedBy', 'impersonatedTeam'] as const;

/**
 * Answers one keyset page: the rows, and the cursor its successor should carry.
 *
 * It lives at the boundary that owns the page ceiling, so `findMany` keeps returning plain rows for
 * the callers that want exactly the rows they asked for — the relation prefetch calls it recursively,
 * and `export` reads a whole collection through it.
 *
 * The read asks for one row past the page because that is the only honest answer to "is there
 * another page?". A cursor emitted from a last page that happened to fill the limit would offer a
 * next page that comes back empty, and the table would keep offering one forever.
 */
const collectionPage = Effect.fn('Bolt.collectionPage')(function* (effectId: EffectId, input: typeof CollectionFindInput.Type) {
	const query = DispatchValues.collectionQuery(input);
	const workspace = yield* Workspace.Service;
	const definition = yield* workspace.collection(input.collection);
	const collections = yield* Collections.Service;
	const rows = yield* collections.findMany(effectId, input.subject, { ...query, limit: query.limit + 1 });
	const page = rows.slice(0, query.limit);
	const last = page[page.length - 1];
	// Compiled the same way the seek predicate was, so the tuple the cursor carries is the tuple the
	// next page's seek compares against — including the primary key `compileOrderTerms` appends.
	const ordering = compileOrderTerms(input.orderBy, makeWhereContext(input.collection, definition.fields, workspace.definition));
	return json({
		rows: page,
		nextCursor: rows.length > query.limit && last !== undefined ? Collections.encodeCollectionCursor(ordering, last) : null
	});
});

/**
 * Exported for the boundary test.
 *
 * This function has silently dropped a query field twice — `where`/`orderBy` once, then `with` —
 * because it rebuilds the query field by field, so anything not explicitly listed disappears
 * without an error anywhere. The test asserts every field survives the crossing.
 */
export const collectionQuery = DispatchValues.collectionQuery;
const credentialFromHeaders = DispatchValues.credentialFromHeaders;
const impersonatedTeamFromHeaders = DispatchValues.impersonatedTeamFromHeaders;

export const dispatchInvocation = Effect.fn('Bolt.dispatch')(function* (invocation: Invocation) {
	if (invocation._tag === 'Request') {
		if (new URL(invocation.url, 'http://bolt.invalid').pathname === '/health') return json({ status: 'ok' });
		const credential = credentialFromHeaders(invocation.headers);
		if (credential === undefined || credential === '') return yield* new DispatchError({ code: 'unauthorized', message: 'Missing authorization credential' });
		const identity = yield* Identity.Service;
		const subject = yield* identity.authenticate(EffectId.make(invocation.id), credential);
		if (subject.tenantId !== invocation.scope.tenantId) return yield* new DispatchError({ code: 'tenant_mismatch', message: 'Authenticated subject is outside the invocation tenant' });
		const access = yield* AccessControl.Service;
		return json({ subject, apps: access.visibleApps(subject) });
	}
	if (invocation._tag === 'Realtime') {
		if (invocation.event._tag === 'Open') return { status: 200, headers: {}, realtime: { frames: [], nextCursor: '0' } };
		if (invocation.event._tag === 'Input') {
			const cursor = String(invocation.event.frame.sequence);
			return { status: 200, headers: {}, realtime: { frames: [{ cursor, kind: invocation.event.frame.kind, bytes: invocation.event.frame.bytes }], nextCursor: cursor } };
		}
		return {
			status: 200,
			headers: {},
			realtime: { frames: [], ...(invocation.event._tag === 'Close' || invocation.event._tag === 'Cancel' ? { close: { code: invocation.event._tag === 'Close' ? invocation.event.code : 1000, reason: invocation.event.reason } } : {}) }
		};
	}
	if (invocation._tag !== 'Command' && invocation._tag !== 'Plugin' && invocation._tag !== 'Task') {
		return yield* new DispatchError({ code: 'unsupported_invocation', message: 'Unsupported Bolt invocation' });
	}
	const effectId = EffectId.make(invocation.id);
	if (invocation._tag === 'Plugin' && invocation.plugin === 'data-browser') {
		if (invocation.command !== 'query') return yield* new DispatchError({ code: 'unknown_plugin_command', message: `Unknown Data Browser command: ${invocation.command}` });
		const input = yield* decode(DataBrowserInput, invocation.input);
		const context = yield* decode(PluginContext, invocation.trustedContext);
		// The same credential the `Command` path reads, authenticated the same way, because the Data
		// Browser is a read of tenant data and there is no weaker thing it could be. Refused when it is
		// absent rather than downgraded to an empty role set: a silent empty result reads as "this
		// workspace has no rows" and sends the operator looking for the wrong fault.
		const credential = credentialFromHeaders(invocation.headers);
		if (credential === undefined || credential === '') {
			return yield* new AccessControl.AccessDenied({ action: 'read', resource: input.collection, reason: 'a Plugin invocation must present a credential before its trustedContext is honoured' });
		}
		const identity = yield* Identity.Service;
		const actor = yield* identity.authenticate(effectId, credential);
		if (actor.tenantId !== invocation.scope.tenantId) return yield* new DispatchError({ code: 'tenant_mismatch', message: 'Plugin actor is outside the invocation tenant' });
		const subject = yield* Effect.gen(function* () {
			if (context.impersonatedSubject === undefined) return actor;
			const target = yield* identity.resolveSubject(effectId, 'colony', context.impersonatedSubject);
			if (target.tenantId !== invocation.scope.tenantId) return yield* new DispatchError({ code: 'tenant_mismatch', message: 'Plugin target is outside the invocation tenant' });
			return yield* (yield* AccessControl.Service).impersonate(actor, target);
		});
		const collections = yield* Collections.Service;
		const options = input.input ?? {};
		const limit = typeof options['limit'] === 'number' ? options['limit'] : undefined;
		// The *effective* subject, which on an impersonated query is the target and not the actor.
		// A facility is being told who this read is on behalf of, and the whole content of an
		// impersonated read is that it is on behalf of somebody else — an operator opening a member's
		// rows must see that member's per-user state, not their own. The actor is not lost: the subject
		// `impersonate` returns carries `impersonatedBy`, and the audit row it writes names them.
		return json(yield* Effect.provideService(
			collections.findMany(effectId, subject, { collection: input.collection, ...(limit === undefined ? {} : { limit }) }),
			Identity.CurrentSubject,
			subject
		));
	}
	const authenticated = yield* Effect.gen(function* () {
		const fields = typeof invocation.input === 'object' && invocation.input !== null && !Array.isArray(invocation.input) ? invocation.input : {};
		if (invocation._tag !== 'Command') {
			yield* authorizeInvocationProvenance(invocation._tag, invocation.command);
			// Refused, not stripped: a payload that names a subject is asking to run as somebody, and
			// answering `invalid_input` would report that as a malformed request rather than as the claim
			// it is. A task that names nobody passes here and fails to decode in its own case, which is
			// the same refusal by the schema each case already declares.
			const claimed = MINTED_IDENTITY.find((name) => name in fields);
			if (claimed !== undefined) {
				return yield* new AccessControl.AccessDenied({ action: 'authenticate', resource: invocation.command, reason: `a ${invocation._tag} invocation carries no credential, so the ${claimed} its payload claims is refused` });
			}
			// Nobody is behind a `Task` or a bare `Plugin`, so it carries no subject and nothing is
			// provided below — a facility called from here sees the same absence the runtime does.
			return { input: invocation.input, subject: undefined };
		}
		// Checked before the credential is demanded, because a person signing in has none yet.
		//
		// The tenant is minted here rather than left out. A bolt serves exactly one workspace, so which
		// tenant a sign-in belongs to is a fact the invocation already carries — and the alternative was
		// not "no tenant" but a broken flow: Better Auth admits the address, the user row lands with a
		// null `tenantId`, and the credential it hands back fails `authenticate` as malformed on its
		// very first use. Nothing else set that column; `startSession` does, but it needs the working
		// credential this is supposed to produce, and `acceptInvitation` never touched it.
		//
		// It comes from `invocation.scope`, never from the payload, which is what `tenantId` being a
		// `MINTED_IDENTITY` field means — so the refusal below is the same one the credential-free tags
		// get, for the same reason. Whether an address may reach this command at all is the host's
		// question, and Colony answers it in front of the forward with Turnstile and its rate limits.
		if (SIGN_IN_COMMANDS.has(invocation.command)) {
			const claimed = MINTED_IDENTITY.find((name) => name in fields);
			if (claimed !== undefined) {
				return yield* new AccessControl.AccessDenied({ action: 'authenticate', resource: invocation.command, reason: `a sign-in carries no credential, so the ${claimed} its payload claims is refused` });
			}
			return { input: { ...fields, tenantId: invocation.scope.tenantId }, subject: undefined };
		}
		const credential = credentialFromHeaders(invocation.headers);
		if (credential === undefined || credential === '') return yield* new DispatchError({ code: 'unauthorized', message: 'Missing command credential' });
		const actor = yield* (yield* Identity.Service).authenticate(effectId, credential);
		if (actor.tenantId !== invocation.scope.tenantId) return yield* new DispatchError({ code: 'tenant_mismatch', message: 'Authenticated subject is outside the invocation tenant' });
		/**
		 * The one place a team preview changes what this invocation is.
		 *
		 * It substitutes the *subject* rather than filtering any particular answer, which is the whole
		 * point: `visibleApps` decides what the sidebar offers, but the row predicate is what decides
		 * whether a read is served, and both read `subject.roles`. Narrowing the subject once here moves
		 * every decision below together — the ninety-odd cases in `runCommand`, the collection predicates,
		 * the field masks — so there is no path where the navigation hides an app the runtime would still
		 * serve rows for.
		 *
		 * `actor` stays the real credential holder. `subject` is who the command runs as, `actor` is who
		 * is really here, and the audit trail, `invitedBy` and `access.impersonation`'s own answer all
		 * need the second — an admin previewing `Employee` must still be told they may impersonate, or
		 * the picker disappears and there is no way back.
		 *
		 * `impersonatedTeam` is minted unconditionally, as `null` when there is no preview, so a payload
		 * claiming one is overwritten in both directions rather than only while a preview is running.
		 */
		const team = impersonatedTeamFromHeaders(invocation.headers);
		const subject = team === undefined ? actor : yield* (yield* AccessControl.Service).subjectAsTeam(actor, team);
		return { input: { ...fields, subject, actor, userId: actor.userId, tenantId: actor.tenantId, invitedBy: actor.userId, impersonatedTeam: team ?? null }, subject };
	});
	/**
	 * Who the facilities are told this invocation is acting for.
	 *
	 * Provided once around the whole command body rather than threaded through the services under it,
	 * because the alternative is a parameter on every facility method and a decision, per call site,
	 * about what to pass — which is how a facility ends up seeing tenant and environment and nothing
	 * finer. `invokeBinding` reads it back out of the Effect context, so a per-user secret or a
	 * signed-in browser session finally has a key to be stored under.
	 *
	 * The value is the one `authenticate` returned above and nothing else. The payload's own
	 * `subject` was already overwritten before this point — that is what `MINTED_IDENTITY` is for —
	 * so there is no route from a request body to what a facility is told. A credential-free tag
	 * reaches here with `subject: undefined` and provides nothing, leaving `currentSubject` `None`
	 * rather than a fabricated stand-in a facility would have to learn to distrust.
	 */
	const invoked = runCommand(invocation.command, effectId, authenticated.input);
	return yield* (authenticated.subject === undefined ? invoked : Effect.provideService(invoked, Identity.CurrentSubject, authenticated.subject));
});

/**
 * Everything a command does once its identity is settled, which is why it is a function.
 *
 * The switch used to be the tail of `dispatchInvocation`, and there was nowhere to stand between
 * "the credential has been checked" and "the command runs" — authentication happens inside the
 * block that builds the command input. Splitting the body out gives the subject a scope to be
 * provided over, so a facility called from any of the ninety-odd cases below carries it without
 * one of them being edited.
 */
const runCommand = Effect.fn('Bolt.runCommand')(function* (command: string, effectId: EffectId, commandInput: unknown) {
	if (command.startsWith('invoke.')) {
		const values = yield* decode(Schema.Struct({ subject: Subject, input: Schema.Json }), commandInput);
		return json(yield* (yield* RemoteRegistry).invoke(command.slice('invoke.'.length), values.input, values.subject, effectId));
	}
	// Gated before the switch, not case by case: the five schema commands were each written without a
	// check, and one gate on the prefix is the only form a sixth cannot be added past.
	if (command.startsWith('schema.')) yield* authorizeSchemaCommand(command, commandInput);
	switch (command) {
		case 'health': return json({ status: 'ok' });
		/**
		 * There is deliberately no `secrets.read`.
		 *
		 * A value never crosses this boundary: `status` reports which names are declared and whether
		 * each is set, and `write` stores one. Server-side code reads values through the service. A
		 * read command would be the single line that put every credential one fetch away from a
		 * browser, so it does not exist.
		 */
		case 'secrets.status': {
			const input = yield* decode(Schema.Struct({ subject: Subject }), commandInput);
			yield* (yield* AccessControl.Service).authorize(input.subject, 'manage', 'secrets');
			const entries = yield* (yield* Secrets.Service).status(effectId);
			// Rebuilt field by field rather than passed through: whatever this boundary returns reaches a
			// browser, so the shape is written out here where it can be read, not inherited from a type.
			return json(
				entries.map((entry) => ({
					name: entry.name,
					label: entry.label,
					secret: entry.secret,
					configured: entry.configured,
					...(entry.description === undefined ? {} : { description: entry.description }),
					...(entry.default === undefined ? {} : { default: entry.default }),
					...(entry.updatedAt === undefined ? {} : { updatedAt: entry.updatedAt })
				}))
			);
		}
		case 'secrets.write': {
			const input = yield* decode(SecretsWriteInput, commandInput);
			yield* (yield* AccessControl.Service).authorize(input.subject, 'manage', 'secrets');
			yield* (yield* Secrets.Service).write(effectId, input.name, input.value, input.subject.userId);
			return json({ saved: true, name: input.name });
		}
		/**
		 * The personal vault: three commands, and deliberately no `personal-secrets.read`.
		 *
		 * Same reason `secrets.read` does not exist — a read command is the single line that puts every
		 * stored credential one fetch away from a browser — and here it would be worse, because these
		 * values are the things that let a capability act *as* the person: a live signed-in session, a
		 * personal token. Server-side code reads them through `PersonalSecrets.read`.
		 *
		 * There is no `authorize` call in any of the three, and that is not an omission. Authority here
		 * is ownership, not a permission: the service can only ever touch the row belonging to the
		 * subject `dispatchInvocation` authenticated, so even the strongest check — `manage secrets` —
		 * would neither grant an admin somebody else's row nor deny a person their own. Adding one
		 * would only suggest, falsely, that a permission is what keeps these rows apart.
		 */
		case 'personal-secrets.status': {
			const entries = yield* (yield* PersonalSecrets.Service).status(effectId);
			// Rebuilt field by field rather than passed through: whatever this boundary returns reaches a
			// browser, so the shape is written out here where it can be read, not inherited from a type.
			return json(
				entries.map((entry) => ({
					name: entry.name,
					configured: entry.configured,
					...(entry.updatedAt === undefined ? {} : { updatedAt: entry.updatedAt })
				}))
			);
		}
		case 'personal-secrets.write': {
			const input = yield* decode(PersonalSecretsWriteInput, commandInput);
			yield* (yield* PersonalSecrets.Service).write(effectId, input.name, input.value);
			return json({ saved: true, name: input.name });
		}
		case 'personal-secrets.forget': {
			const input = yield* decode(PersonalSecretsNameInput, commandInput);
			yield* (yield* PersonalSecrets.Service).forget(effectId, input.name);
			return json({ forgotten: true, name: input.name });
		}
		case 'apps.visible': {
			const input = yield* decode(VisibleAppsInput, commandInput);
			const access = yield* AccessControl.Service;
			return json({ apps: access.visibleApps(input.subject) });
		}
		case 'access.impersonate': {
			const input = yield* decode(ImpersonateInput, commandInput);
			const access = yield* AccessControl.Service;
			return json({ subject: yield* access.impersonate(input.actor, input.target), apps: access.visibleApps(input.target) });
		}
		/**
		 * What the sidebar needs to render the picker: may this actor impersonate, what may they
		 * become, and what are they right now.
		 *
		 * A command rather than something stamped onto the document, for the same reason `apps.visible`
		 * is one: the answer is the compiled workspace's policy list crossed with the credential's own
		 * roles, and only the tenant runtime holds both.
		 */
		case 'access.impersonation': {
			const input = yield* decode(ImpersonationStateInput, commandInput);
			const access = yield* AccessControl.Service;
			return json({
				isAdmin: access.mayImpersonate(input.actor),
				isActive: input.impersonatedTeam !== null,
				activeTeamIds: input.impersonatedTeam === null ? [] : [input.impersonatedTeam],
				teams: access.impersonationTeams()
			});
		}
		/**
		 * Starting a preview, which is what writes the audit row.
		 *
		 * The host calls this once, before it stores the choice, so a refusal is reported where a person
		 * can see it rather than as every subsequent command failing. `subjectAsTeam` re-checks the same
		 * authority on every invocation afterwards — this is not the gate, it is the record.
		 */
		case 'access.impersonateTeam': {
			const input = yield* decode(ImpersonateTeamInput, commandInput);
			const access = yield* AccessControl.Service;
			const previewed = yield* access.impersonateTeam(input.actor, input.teamId);
			return json({ subject: previewed, apps: access.visibleApps(previewed) });
		}
		case 'access.resolveScope': {
			const input = yield* decode(VisibleAppsInput, commandInput);
			return json((yield* AccessControl.Service).resolveScope(input.subject));
		}
		case 'access.authorize': {
			const input = yield* decode(AccessDecisionInput, commandInput);
			yield* (yield* AccessControl.Service).authorize(input.subject, input.action, input.resource);
			return json({ allowed: true });
		}
		case 'access.predicate':
		case 'access.explain': {
			const input = yield* decode(AccessDecisionInput, commandInput);
			const access = yield* AccessControl.Service;
			const decision = command === 'access.predicate' ? access.predicate(input.subject, input.action, input.resource) : access.explain(input.subject, input.action, input.resource);
			return json({ allowed: decision.allowed, reason: decision.reason });
		}
		case 'access.mask': {
			const input = yield* decode(AccessMaskInput, commandInput);
			return json((yield* AccessControl.Service).mask(input.subject, input.action, input.resource, input.value));
		}
		case 'identity.authenticate': {
			const input = yield* decode(IdentityAuthenticateInput, commandInput);
			return json(yield* (yield* Identity.Service).authenticate(effectId, input.credential));
		}
		case 'identity.resolveSubject': {
			const input = yield* decode(IdentityResolveInput, commandInput);
			return json(yield* (yield* Identity.Service).resolveSubject(effectId, input.provider, input.externalId));
		}
		case 'identity.admitFounder': {
			const input = yield* decode(IdentityAdmitFounderInput, commandInput);
			const definition = (yield* Workspace.Service).definition;
			// Every role the workspace declares, and every team it names as an approver.
			//
			// Derived rather than configured because only the workspace knows them. A founder given
			// `['admin']` matches no policy at all — there is no admin bypass in `decide`, and a policy
			// is matched by its own name — so the first administrator of the HR workspace could see no
			// app and read no collection. The approver teams matter for the same reason one step later:
			// a record whose create is approval-gated is written, locked, and then waits forever if
			// nobody in the workspace is eligible to decide.
			const roles = new Set<string>();
			const teams = new Set<string>();
			// Plus the one role no policy can declare. `mayImpersonate` requires it, and viewing the
			// workspace as another team is not an authority a policy grants to a group — it is a property
			// of being the administrator who owns the workspace. Derived from the policies alone, the
			// founder of every workspace would hold every role *except* the one the sidebar's picker
			// needs, and the impersonation menu would never render for anybody.
			roles.add(AccessControl.IMPERSONATOR_ROLE);
			for (const policy of definition.policies) {
				for (const role of policy.roles ?? [policy.name]) roles.add(role);
				for (const grant of policy.grants ?? []) {
					const approval = grant.approval;
					if (approval === null || typeof approval !== 'object') continue;
					const steps = Reflect.get(approval, 'steps');
					if (!Array.isArray(steps)) continue;
					for (const step of steps) {
						const approvers = step === null || typeof step !== 'object' ? undefined : Reflect.get(step, 'approvers');
						if (!Array.isArray(approvers)) continue;
						for (const team of approvers) if (typeof team === 'string') teams.add(team);
					}
				}
			}
			// `tenantId` is stamped onto every command input from the invocation scope, never read from
			// the payload — so a caller cannot admit a founder into somebody else's workspace.
			const founderId = yield* (yield* Identity.Service).admit(
				effectId,
				input.tenantId,
				input.email,
				[...roles],
				[...teams]
			);
			return json({ admitted: true, userId: founderId, roles: [...roles], teams: [...teams] });
		}
		case 'identity.invite': {
			const input = yield* decode(IdentityInviteInput, commandInput);
			return json({ invitationId: yield* (yield* Identity.Service).invite(effectId, input.tenantId, input.email, input.invitedBy) });
		}
		case 'identity.acceptInvitation': {
			const input = yield* decode(IdentityAcceptInput, commandInput);
			yield* (yield* Identity.Service).acceptInvitation(effectId, input.invitationId, input.userId);
			return json({ accepted: true });
		}
		case 'identity.sendCode': {
			const input = yield* decode(IdentitySendCodeInput, commandInput);
			yield* (yield* Identity.Service).sendCode(effectId, input.email);
			// Always the same answer. A response that differed for a known address would turn this
			// into an account-enumeration oracle for anyone who can reach the endpoint.
			return json({ sent: true });
		}
		case 'identity.verifyCode': {
			const input = yield* decode(IdentityVerifyCodeInput, commandInput);
			return json({ credential: yield* (yield* Identity.Service).verifyCode(effectId, input.email, input.code, input.tenantId) });
		}
		case 'identity.startSession': {
			const input = yield* decode(IdentitySessionInput, commandInput);
			return json({ credential: yield* (yield* Identity.Service).startSession(effectId, input.userId, input.tenantId) });
		}
		case 'identity.endSession': {
			const input = yield* decode(IdentityCredentialInput, commandInput);
			yield* (yield* Identity.Service).endSession(effectId, input.credential);
			return json({ ended: true });
		}
		case 'identity.workspaceAccess': {
			const input = yield* decode(IdentitySettingsInput, commandInput);
			return json(yield* (yield* Identity.Service).workspaceAccess(effectId, input.tenantId));
		}
		case 'identity.workspaceSettings': {
			const input = yield* decode(IdentitySettingsInput, commandInput);
			return json(yield* (yield* Identity.Service).workspaceSettings(effectId, input.tenantId));
		}
		case 'approvals.request': {
			const input = yield* decode(ApprovalRequestInput, commandInput);
			const approvals = yield* Approvals.Service;
			return json(yield* approvals.request(effectId, input.subject, input.requestId, input.operation));
		}
		case 'approvals.decide': {
			const input = yield* decode(ApprovalDecideInput, commandInput);
			const approvals = yield* Approvals.Service;
			return json(yield* approvals.decide(effectId, input.subject, input.state, input.decision, input.reason));
		}
		case 'approvals.withdraw': {
			const input = yield* decode(ApprovalWithdrawInput, commandInput);
			return json(yield* (yield* Approvals.Service).withdraw(effectId, input.subject, input.state));
		}
		case 'approvals.status': {
			const input = yield* decode(ApprovalStatusInput, commandInput);
			return json((yield* (yield* Approvals.Service).status(effectId, input.requestId)) ?? null);
		}
		case 'approvals.timeline': {
			const input = yield* decode(ApprovalStatusInput, commandInput);
			return json(yield* (yield* Approvals.Service).timeline(effectId, input.requestId));
		}
		case 'sync.head': {
			const sync = yield* Sync.Service;
			return json(yield* sync.head(effectId));
		}
		case 'sync.diff': {
			const input = yield* decode(SyncDiffInput, commandInput);
			const sync = yield* Sync.Service;
			return json(yield* sync.diff(effectId, input.subject, input.cursor, input.limit));
		}
		case 'sync.shape': {
			const input = yield* decode(SyncShapeInput, commandInput);
			return json(yield* (yield* Sync.Service).shape(input.subject));
		}
		case 'sync.snapshot': {
			const input = yield* decode(SyncSnapshotInput, commandInput);
			return json(yield* (yield* Sync.Service).snapshot(effectId, input.subject, input.collection, input.after, input.limit ?? 500));
		}
		case 'sync.compact': {
			const input = yield* decode(SyncCompactInput, commandInput);
			return json(yield* (yield* Sync.Service).compact(effectId, input.retentionDays ?? 30));
		}
		case 'sync.schema': return json((yield* Sync.Service).schema());
		case 'sync.wakeHint': {
			const input = yield* decode(SyncCursor, commandInput);
			return json((yield* Sync.Service).wakeHint(input));
		}
		case 'sync.mutate': {
			const input = yield* decode(SyncMutateInput, commandInput);
			yield* (yield* Sync.Service).mutate(effectId, input.subject, input.changes);
			return json({ mutated: input.changes.length });
		}
		case 'agents.turn': {
			const input = yield* decode(AgentTurnInput, commandInput);
			const agents = yield* Agents.Service;
			return json(yield* agents.turn(effectId, input.subject, input.agent, input.conversationId, input.message));
		}
		case 'agents.title': {
			const input = yield* decode(AgentTitleInput, commandInput);
			const agents = yield* Agents.Service;
			return json({ title: yield* agents.title(effectId, input.conversationId) });
		}
		case 'agents.start': {
			const input = yield* decode(AgentStartInput, commandInput);
			yield* (yield* Agents.Service).start(effectId, input.subject, input.agent, input.conversationId);
			return json({ started: true, conversationId: input.conversationId });
		}
		case 'agents.resume': {
			const input = yield* decode(AgentResumeInput, commandInput);
			yield* (yield* Agents.Service).resume(effectId, input.taskId, input.conversationId);
			return json({ resumed: true });
		}
		case 'agents.cancel': {
			const input = yield* decode(TaskInput, commandInput);
			yield* (yield* Agents.Service).cancel(effectId, input.taskId);
			return json({ cancelled: true });
		}
		case 'agents.updateVerifier': {
			const input = yield* decode(AgentVerifierInput, commandInput);
			yield* (yield* Agents.Service).updateVerifier(effectId, input.conversationId, input.verifier);
			return json({ updated: true });
		}
		case 'agents.listConversations': {
			const input = yield* decode(AgentListConversationsInput, commandInput);
			const agents = yield* Agents.Service;
			return json(yield* agents.listConversations(effectId, input.subject));
		}
		case 'agents.history': {
			const input = yield* decode(AgentHistoryInput, commandInput);
			const agents = yield* Agents.Service;
			return json(yield* agents.history(effectId, input.subject, input.conversationId));
		}
		case 'agents.listSkills': {
			const input = yield* decode(SkillInput, commandInput);
			if (input.agent === undefined) return yield* new DispatchError({ code: 'invalid_input', message: 'Agent name is required' });
			return json(yield* (yield* Agents.Service).listSkills(input.agent));
		}
		case 'agents.readSkill': {
			const input = yield* decode(SkillInput, commandInput);
			if (input.name === undefined) return yield* new DispatchError({ code: 'invalid_input', message: 'Skill name is required' });
			return json(yield* (yield* Agents.Service).readSkill(effectId, input.name));
		}
		// The agent model picker asks for the models this deployment offers. Bolt does not decide that
		// — the host's AI facility does — so this forwards the question rather than answering it.
		case 'ai.models': {
			const ai = yield* AI.Service;
			return json((yield* ai.execute(effectId, { _tag: 'Models' })).output);
		}
		case 'workspace.agents': {
			return json((yield* Workspace.Service).definition.agents.map(({ name }) => name));
		}
		// The Studio and Data Browser are host surfaces: they read workspace structure through this
		// command and never touch tenant SQL. What a subject may see is still an access decision, so
		// collections are filtered by the same read predicate every query uses.
		case 'workspace.manifest': {
			const input = yield* decode(VisibleAppsInput, commandInput);
			const workspace = yield* Workspace.Service;
			const access = yield* AccessControl.Service;
			const definition = workspace.definition;
			const readable = definition.collections.filter(({ name }) => access.predicate(input.subject, 'read', name).allowed);
			return json({
				name: definition.name,
				version: definition.version,
				collections: readable.map((collection) => ({
					name: collection.name,
					history: collection.history,
					hooks: [...(collection.hooks ?? [])],
					// The three `defineModel` options that used to stop one hop short of a reader. The
					// compiler now lifts them onto the collection descriptor, and this is the projection
					// that would otherwise drop them again: a studio needs `description` and `icon` to
					// name a collection, and `approvalLock` to know a write on it will be held.
					...(collection.approvalLock === undefined ? {} : { approvalLock: collection.approvalLock }),
					...(collection.description === undefined ? {} : { description: collection.description }),
					...(collection.icon === undefined ? {} : { icon: collection.icon }),
					...(collection.sourcePath === undefined ? {} : { sourcePath: collection.sourcePath }),
					// Every key a field description carries, not a chosen four. The projection named
					// `name`/`type`/`required`/`generated` and dropped the rest, so a studio could not
					// offer an enum's members, could not mark a searchable column, could not resolve a
					// `custom()` renderer and could not set an upload's accept list — each of them a
					// declaration a workspace makes, and this the last hop before it would be read.
					fields: Object.entries(collection.fields).map(([field, definition]) => ({
						name: field,
						type: definition.type,
						required: definition.required,
						generated: definition.generated !== undefined,
						...(definition.values === undefined ? {} : { values: [...definition.values] }),
						...(definition.search === undefined ? {} : { search: definition.search }),
						...(definition.customType === undefined ? {} : { customType: definition.customType }),
						...(definition.mimeTypes === undefined ? {} : { mimeTypes: [...definition.mimeTypes] })
					})),
					relations: definition.relations.filter((relation) => relation.source === collection.name).map(({ name, target, cardinality }) => ({ name, target, cardinality }))
				})),
				apps: definition.apps.map(({ name, label }) => ({ name, label })),
				policies: definition.policies.map((policy) => ({ name: policy.name, grants: policy.grants?.length ?? 0 })),
				agents: definition.agents.map(({ name }) => ({ name })),
				automations: definition.automations.map(({ name }) => ({ name })),
				// What identifies a channel and what shape of traffic it carries, for the same reason the
				// field projection above stopped naming four keys: a studio that is told only a channel's
				// name cannot attribute it to the agent that answers on it, cannot say which transport it
				// arrives over, and cannot tell a public channel from one only members reach.
				//
				// `policy`, `task` and `rateLimits` are declared and deliberately not published. `task` is
				// the channel's system prompt and `policy` names the grants its runs are ceilinged by;
				// `workspace.manifest` answers any authenticated caller, and neither is something a caller
				// needs in order to render a channel.
				channels: definition.channels.map(({ name, agent, transport, audience, description, groupMessages }) => ({
					name,
					agent,
					transport,
					audience,
					description,
					...(groupMessages === undefined ? {} : { groupMessages })
				})),
				integrations: definition.integrations.map(({ name }) => ({ name })),
				requiredFacilities: [...definition.requiredFacilities]
			});
		}
		case 'collections.findMany': {
			const input = yield* decode(CollectionFindInput, commandInput);
			return yield* collectionPage(effectId, input);
		}
		case 'collections.findFirst': {
			const input = yield* decode(CollectionFindInput, commandInput);
			return json((yield* (yield* Collections.Service).findFirst(effectId, input.subject, collectionQuery(input))) ?? null);
		}
		case 'collections.count': {
			const input = yield* decode(CollectionFindInput, commandInput);
			return json({ count: yield* (yield* Collections.Service).count(effectId, input.subject, collectionQuery(input)) });
		}
		case 'collections.history': {
			const input = yield* decode(CollectionRecordInput, commandInput);
			return json(yield* (yield* Collections.Service).history(effectId, input.subject, input.collection, input.id));
		}
		case 'collections.create': {
			const input = yield* decode(CollectionCreateInput, commandInput);
			yield* checkWrittenValues(input.collection, input.values);
			const collections = yield* Collections.Service;
			yield* collections.create(effectId, input.subject, input);
			return json({ created: true, norbital_id: input.id });
		}
		case 'collections.createMany': {
			const input = yield* decode(CollectionCreateManyInput, commandInput);
			const records = input.records.map((record) => ({ ...record, subject: input.subject }));
			for (const record of records) yield* checkWrittenValues(record.collection, record.values);
			yield* (yield* Collections.Service).createMany(effectId, input.subject, records);
			return json({ created: records.length, ids: records.map(({ id }) => id), norbital_ids: records.map(({ id }) => id) });
		}
		case 'collections.update': {
			const input = yield* decode(CollectionUpdateInput, commandInput);
			yield* checkWrittenValues(input.collection, input.values);
			const collections = yield* Collections.Service;
			yield* collections.update(effectId, input.subject, input);
			return json({ updated: true, id: input.id });
		}
		case 'collections.delete': {
			const input = yield* decode(CollectionDeleteInput, commandInput);
			const collections = yield* Collections.Service;
			yield* collections.delete(effectId, input.subject, input.collection, input.id);
			return json({ deleted: true, id: input.id });
		}
		case 'collections.resume': {
			const input = yield* decode(ApprovalStatusInput, commandInput);
			yield* (yield* Collections.Service).resume(effectId, input.requestId);
			return json({ resumed: true, requestId: input.requestId });
		}
		case 'collections.discard': {
			const input = yield* decode(ApprovalStatusInput, commandInput);
			yield* (yield* Collections.Service).discard(effectId, input.requestId);
			return json({ discarded: true, requestId: input.requestId });
		}
		case 'collections.import': {
			const input = yield* decode(CollectionCreateManyInput, commandInput);
			const records = input.records.map((record) => ({ ...record, subject: input.subject }));
			return json({ imported: yield* (yield* Collections.Service).import(effectId, input.subject, records) });
		}
		case 'collections.export': {
			const input = yield* decode(CollectionFindInput, commandInput);
			return json(yield* (yield* Collections.Service).export(effectId, input.subject, collectionQuery(input)));
		}
		/**
		 * The exact DDL this tenant's database was provisioned with, in order.
		 *
		 * Served so a browser replica can build a local PostgreSQL whose schema cannot drift from the
		 * server's — the alternative being a second renderer in the client, which is the mistake the
		 * plan/lineage split already was. The lineage is carried in the compiled workspace, so this
		 * needs no generator at runtime and ships no drizzle-kit to the browser.
		 *
		 * Ordering matches what a real provision applies: the plan's extensions, functions and `bolt_*`
		 * tables first, because generated columns call `norbital_date` and trigram indexes need
		 * `pg_trgm`; then the lineage, which owns every authored collection; then the plan's supplements
		 * for what Drizzle cannot express.
		 */
		case 'sync.provisioning': {
			const plan = (yield* WorkspaceSchema.Service).plan();
			const workspace = yield* Workspace.Service;
			return json({
				steps: [
					...plan.steps.filter(({ id }) => id.startsWith('bolt:')).map(({ id, sql }) => ({ id, sql })),
					...[...(workspace.definition.migrations ?? [])]
						.toSorted((left, right) => left.tag.localeCompare(right.tag))
						.flatMap((entry) =>
							entry.statements.map((sql, index) => ({ id: `lineage:${entry.tag}:${index}`, sql }))
						),
					...plan.steps.filter(({ id }) => !id.startsWith('bolt:')).map(({ id, sql }) => ({ id, sql }))
				],
				fingerprint: plan.fingerprint,
				/**
				 * The metadata the replica needs to compile a query the way the server would.
				 *
				 * Sent rather than re-derived on the client, so the local read path and the server read
				 * path cannot disagree about what a column is. Nothing is disclosed that the DDL above
				 * does not already state — these are the same collections, spelled as declarations
				 * instead of as `create table`.
				 */
				collections: workspace.definition.collections.map(({ name, fields }) => ({ name, fields })),
				relations: workspace.definition.relations ?? []
			} as unknown as Schema.Json);
		}
		case 'schema.plan': {
			const schema = yield* WorkspaceSchema.Service;
			const plan = schema.plan();
			return json({ fingerprint: plan.fingerprint, steps: plan.steps.map(({ id, sql }) => ({ id, sql })) });
		}
		case 'schema.fingerprint': {
			const schema = yield* WorkspaceSchema.Service;
			return json({ fingerprint: schema.fingerprint() });
		}
		case 'schema.validate': {
			yield* (yield* WorkspaceSchema.Service).validate();
			return json({ valid: true });
		}
		case 'schema.verify': {
			// The divergences ride along with the verdict: "not verified" on its own sends the reader
			// back to the database to find out what is wrong, which is the work this command just did.
			const divergences = yield* (yield* WorkspaceSchema.Service).verify(effectId);
			return json({ verified: divergences.length === 0, divergences });
		}
		case 'schema.migrate': {
			const schema = yield* WorkspaceSchema.Service;
			yield* schema.migrate(effectId);
			return json({ migrated: true, fingerprint: schema.fingerprint() });
		}
		case 'automations.start': {
			const input = yield* decode(AutomationStartInput, commandInput);
			const automations = yield* Automations.Service;
			return json({ taskId: yield* automations.start(effectId, input.subject, input.name, input.input) });
		}
		case 'automations.register': {
			const input = yield* decode(NamedInput, commandInput);
			yield* (yield* Automations.Service).register(input.name);
			return json({ registered: true });
		}
		case 'automations.runStep': {
			const input = yield* decode(AutomationStartInput, commandInput);
			return json({ taskId: yield* (yield* Automations.Service).runStep(effectId, input.subject, input.name, input.input) });
		}
		case 'automations.resume': {
			const input = yield* decode(TaskInput, commandInput);
			yield* (yield* Automations.Service).resume(effectId, input.taskId, input.input ?? null);
			return json({ resumed: true });
		}
		case 'automations.status': {
			const input = yield* decode(TaskInput, commandInput);
			return json((yield* (yield* Automations.Service).status(effectId, input.taskId)) ?? null);
		}
		case 'automations.cancel': {
			const input = yield* decode(TaskInput, commandInput);
			yield* (yield* Automations.Service).cancel(effectId, input.taskId);
			return json({ cancelled: true });
		}
		case 'channels.receive': {
			const input = yield* decode(ChannelReceiveInput, commandInput);
			const channels = yield* Channels.Service;
			return json(yield* channels.receive(effectId, input.subject, input.channel, input.conversationId, input.message));
		}
		case 'channels.register': {
			const input = yield* decode(ChannelNameInput, commandInput);
			yield* (yield* Channels.Service).register(effectId, input.channel);
			return json({ registered: true });
		}
		case 'channels.reply': {
			const input = yield* decode(ChannelReplyInput, commandInput);
			yield* (yield* Channels.Service).reply(effectId, input.channel, input.recipient, input.payload);
			return json({ replied: true });
		}
		case 'channels.status': {
			const input = yield* decode(ChannelNameInput, commandInput);
			return json(yield* (yield* Channels.Service).status(effectId, input.channel));
		}
		case 'integrations.pull': {
			const input = yield* decode(IntegrationPullInput, commandInput);
			const integrations = yield* Integrations.Service;
			return json(yield* integrations.pull(effectId, input.name, input.cursor, input.binding));
		}
		case 'integrations.install':
		case 'integrations.reconcile':
		case 'integrations.disable':
		case 'integrations.status': {
			const input = yield* decode(NamedInput, commandInput);
			const integrations = yield* Integrations.Service;
			if (command === 'integrations.install') { yield* integrations.install(effectId, input.name); return json({ installed: true }); }
			if (command === 'integrations.reconcile') { yield* integrations.reconcile(effectId, input.name); return json({ reconciled: true }); }
			if (command === 'integrations.disable') { yield* integrations.disable(effectId, input.name); return json({ disabled: true }); }
			return json(yield* integrations.status(effectId, input.name));
		}
		case 'integrations.receive': {
			const input = yield* decode(IntegrationReceiveInput, commandInput);
			// Deliberately *not* added to `ENQUEUED_COMMANDS`: a webhook is not something the runtime
			// posts to itself, so it stays a `Command` and the host relaying it must present its own
			// credential. That is one of the two independent checks a delivery passes — the host proves it
			// is the host, and the HMAC proves the source is the source. Listing it as enqueued would drop
			// the first of those and re-open a credential-free route into a collection write.
			return json(yield* (yield* Integrations.Service).receive(effectId, input.name, input.binding, { headers: input.headers, body: input.body }));
		}
		case 'integrations.flush': {
			const input = yield* decode(IntegrationFlushInput, commandInput);
			return json(yield* (yield* Integrations.Service).flush(effectId, input.name, input.input ?? null));
		}
		case 'notifications.enqueue': {
			const input = yield* decode(Notification, commandInput);
			const notifications = yield* Notifications.Service;
			yield* notifications.enqueue(effectId, input);
			return json({ enqueued: true, id: input.id });
		}
		case 'notifications.drain': {
			const input = yield* decode(Notification, commandInput);
			const notifications = yield* Notifications.Service;
			yield* notifications.drain(effectId, input);
			return json({ delivered: true, id: input.id });
		}
		case 'notifications.markRead': {
			const input = yield* decode(NotificationReadInput, commandInput);
			yield* (yield* Notifications.Service).markRead(effectId, input.recipient, input.id);
			return json({ read: true, id: input.id });
		}
		case 'notifications.list': {
			const input = yield* decode(NotificationRecipientInput, commandInput);
			return json(yield* (yield* Notifications.Service).list(effectId, input.recipient, input.unreadOnly));
		}
		default:
			// An enqueued `automations.<name>` task is an authored automation's turn to run: the
			// handler receives the Effect-native api and the trigger context, and its result is the
			// task's answer. Resolved against the declared automations rather than the prefix, so a
			// workspace can never route a stray command to a handler it did not declare. The
			// `bolt_run_as` subject is stamped by the runtime's own enqueue points (`Automations.start`
			// and the collection change events), never by the payload.
			if (command.startsWith('automations.')) {
				const name = command.slice('automations.'.length);
				const automation = (yield* AuthoredRuntimeService).automations[name];
				if (automation !== undefined) {
					const input = yield* decode(AutomationTaskInput, commandInput);
					const collections = yield* Collections.Service;
					const ai = yield* AI.Service;
					const files = yield* Files.Service;
					const ops = makeBoundAuthoringOps(effectId, input.bolt_run_as, collections, ai, files);
					const api = makeAuthoringApi(ops);
					const output = yield* runAuthoredHandler(automation.handler(api, { args: input.args, scope: input.scope ?? {} }));
					return json(output as Schema.Json);
				}
			}
			return yield* new DispatchError({ code: 'unknown_command', message: `Unknown Bolt command: ${command}` });
	}
});
