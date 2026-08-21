import { Effect, Schema } from 'effect';
import {
	CollectionWriteValues,
	EffectId,
	StoredRecord,
	type DispatchResponse,
	type Invocation
} from '@norbital-ai/bolt-protocol';
import { AccessControl } from './access/access-control.js';
import { SystemPrincipal } from './access/system-principal.js';
import { Agents } from './agents/agents.js';
import { AI, Files } from './facilities/services.js';
import { Approvals, ApprovalState } from './approvals/approvals.js';
import { Automations } from './automations/automations.js';
import { ChannelDelivery, Channels } from './channels/channels.js';
import { Collections } from './collections/collections.js';
import { compileOrderTerms, makeWhereContext } from './collections/where.js';
import { Integrations } from './integrations/integrations.js';
import { ADMIN_STATUS, Identity, Subject } from './identity/identity.js';
import { Database } from './facilities/database.js';
import { Notification, Notifications } from './notifications/notifications.js';
import { RemoteRegistry } from './remotes.js';
import { WorkspaceSchema } from './schema/workspace-schema.js';
import { Secrets } from './secrets/secrets.js';
import { PersonalSecrets } from './secrets/personal-secrets.js';
import {
	describeGeneratedColumnWrite,
	describeInvalidCustomValue
} from './collections/custom-values.js';
import { Sync, SyncCursor } from './sync/sync.js';
import {
	AuthoredRuntimeService,
	makeAuthoringApi,
	makeBoundAuthoringOps,
	runAuthoredHandler
} from './collections/authored.js';
import { describeCause, DispatchError, Workspace } from './workspace.js';
import { RateLimits } from './rate-limits.js';
import { TaskQueue } from './tasks/tasks.js';

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
const ImpersonationStateInput = Schema.Struct({
	actor: Subject,
	impersonatedTeam: Schema.NullOr(Schema.String)
});
const AccessDecisionInput = Schema.Struct({
	subject: Subject,
	action: Schema.NonEmptyString,
	resource: Schema.NonEmptyString
});
const AccessMaskInput = Schema.Struct({
	subject: Subject,
	action: Schema.NonEmptyString,
	resource: Schema.NonEmptyString,
	value: Schema.Record(Schema.String, Schema.Json)
});
const ApprovalRequestInput = Schema.Struct({
	subject: Subject,
	requestId: Schema.NonEmptyString,
	operation: Schema.Json
});
const ApprovalDecideInput = Schema.Struct({
	subject: Subject,
	state: ApprovalState,
	decision: Schema.Literals(['approve', 'reject']),
	reason: Schema.optionalKey(Schema.String)
});
const SyncDiffInput = Schema.Struct({ subject: Subject, cursor: SyncCursor, limit: Schema.Number });
const AgentTurnInput = Schema.Struct({
	subject: Subject,
	agent: Schema.NonEmptyString,
	conversationId: Schema.NonEmptyString,
	message: Schema.String
});
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
const SecretsWriteInput = Schema.Struct({
	subject: Subject,
	name: Schema.NonEmptyString,
	value: Schema.String
});
/**
 * Note what these do *not* declare: no `subject`, no `userId`, no owner of any kind.
 *
 * Every other input on this page decodes a `Subject` because the command acts on tenant data and has
 * to say on whose authority. A personal secret has exactly one legitimate owner — the person whose
 * credential this invocation authenticated — and the service reads that from `Identity.CurrentSubject`.
 * Accepting an owner here, even one the boundary overwrites, would put a user id on the path from a
 * request body to a WHERE clause, and the only safe number of such paths is none.
 */
const PersonalSecretsWriteInput = Schema.Struct({
	name: Schema.NonEmptyString,
	value: Schema.String
});
const PersonalSecretsNameInput = Schema.Struct({ name: Schema.NonEmptyString });
const DataBrowserInput = Schema.Struct({
	collection: Schema.NonEmptyString,
	input: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json))
});
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
/**
 * The create body, and the `id` that used to be on it.
 *
 * `CollectionCreateRequest` in `@norbital-ai/bolt-protocol` is this struct without `subject`, which
 * the boundary injects from the authenticated credential. It is declared there rather than only
 * here because the browser client posts against it and the two halves must not be able to disagree
 * about whether an id is part of a create.
 *
 * It is not, any more. The client minted one with `crypto.randomUUID()` and posted it, which made
 * the browser the authority on a primary key before the write had been authorized, before
 * `create.before` had run, and before the row existed — and it made a nested write inexpressible,
 * because the child of a record the client has not yet created has no parent id to carry. Ids are
 * assigned in `mutate`, at the point the row is built, and answered with.
 *
 * A create that arrives carrying an `id` has it *ignored* rather than honoured, because
 * `Schema.Struct` drops keys it does not declare. That is the one silent behaviour in this change,
 * and it is bounded: the runtime and the browser client that talks to it are the same compiled
 * artifact, so there is no version of the client still sending one. The paths that legitimately
 * choose their own key — an import replaying a deterministic id, an integration keying on an
 * external id — go through `collections.createMany` and `collections.import`, which still declare it.
 */
const CollectionCreateInput = Schema.Struct({
	subject: Subject,
	collection: Schema.NonEmptyString,
	values: CollectionWriteValues
});
/**
 * An update names the row it changes, so its `id` is required and this is no longer an alias of the
 * create input. It was one, which is the only reason the create input could lose a field an update
 * cannot do without.
 */
const CollectionUpdateInput = Schema.Struct({
	subject: Subject,
	collection: Schema.NonEmptyString,
	id: Schema.NonEmptyString,
	values: Schema.Record(Schema.String, Schema.Json)
});
const CollectionDeleteInput = Schema.Struct({
	subject: Subject,
	collection: Schema.NonEmptyString,
	id: Schema.NonEmptyString
});
const CollectionMutation = Schema.Struct({
	collection: Schema.NonEmptyString,
	id: Schema.NonEmptyString,
	values: Schema.Record(Schema.String, Schema.Json)
});
const CollectionCreateManyInput = Schema.Struct({
	subject: Subject,
	records: Schema.Array(CollectionMutation)
});
const AutomationStartInput = Schema.Struct({
	subject: Subject,
	name: Schema.NonEmptyString,
	input: Schema.Json
});
/**
 * What a host may say about a message it took off a transport.
 *
 * `subject` is gone from this input and its absence is the point. It was a `Subject` the caller
 * supplied, which made the identity of a channel turn something outside the runtime decided — and on
 * a `Command` the boundary overwrites `subject` from the credential anyway, so a host relaying a
 * WhatsApp message could only ever have run the turn as *itself*, an administrator. `Channels.receive`
 * resolves the requestor from the release's own declarations now; the host supplies the wire's facts
 * and nothing about authority.
 */
const ChannelReceiveInput = Schema.Struct({
	channel: Schema.NonEmptyString,
	delivery: ChannelDelivery
});
/**
 * `binding` is what a scheduled pull carries and an enqueued one does not.
 *
 * The registration `activate` hands the host names one binding, because that is the granularity a
 * `+integrations.ts` cron is declared at; `install` and `reconcile` enqueue without it and mean
 * "every binding this integration has".
 */
const IntegrationPullInput = Schema.Struct({
	name: Schema.NonEmptyString,
	cursor: Schema.Json,
	binding: Schema.optionalKey(Schema.NonEmptyString)
});
const NamedInput = Schema.Struct({ name: Schema.NonEmptyString });
const TaskInput = Schema.Struct({
	taskId: Schema.NonEmptyString,
	input: Schema.optionalKey(Schema.Json)
});
/** The task payload an authored automation runs from: the runtime's trigger context and the subject the runtime stamped at enqueue time. */
const AutomationTaskInput = Schema.Struct({
	args: Schema.Record(Schema.String, Schema.Json),
	scope: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
	bolt_run_as: Subject
});
const AgentStartInput = Schema.Struct({
	subject: Subject,
	agent: Schema.NonEmptyString,
	conversationId: Schema.NonEmptyString
});
const AgentResumeInput = Schema.Struct({
	taskId: Schema.NonEmptyString,
	conversationId: Schema.NonEmptyString
});
const AgentVerifierInput = Schema.Struct({
	conversationId: Schema.NonEmptyString,
	verifier: Schema.Json
});
const AgentHistoryInput = Schema.Struct({
	subject: Subject,
	conversationId: Schema.NonEmptyString
});
const AgentListConversationsInput = Schema.Struct({ subject: Subject });
const SkillInput = Schema.Struct({
	agent: Schema.optionalKey(Schema.NonEmptyString),
	name: Schema.optionalKey(Schema.NonEmptyString)
});
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
const SyncMutateInput = Schema.Struct({
	subject: Subject,
	changes: Schema.Array(
		Schema.Struct({
			cursor: SyncCursor,
			collection: Schema.NonEmptyString,
			recordId: Schema.NonEmptyString,
			operation: Schema.Literals(['create', 'update', 'delete']),
			record: Schema.optionalKey(Schema.Json)
		})
	)
});
const ChannelNameInput = Schema.Struct({ channel: Schema.NonEmptyString });
const ChannelReplyInput = Schema.Struct({
	channel: Schema.NonEmptyString,
	recipient: Schema.NonEmptyString,
	payload: Schema.Json
});
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
const IntegrationFlushInput = Schema.Struct({
	name: Schema.NonEmptyString,
	input: Schema.optionalKey(Schema.Json)
});
const NotificationRecipientInput = Schema.Struct({
	recipient: Schema.NonEmptyString,
	unreadOnly: Schema.optionalKey(Schema.Boolean)
});
const NotificationReadInput = Schema.Struct({
	recipient: Schema.NonEmptyString,
	id: Schema.NonEmptyString
});
const IdentityInviteInput = Schema.Struct({
	tenantId: Schema.NonEmptyString,
	email: Schema.NonEmptyString,
	invitedBy: Schema.NonEmptyString
});
const IdentityAcceptInput = Schema.Struct({
	invitationId: Schema.NonEmptyString,
	userId: Schema.NonEmptyString
});
const IdentitySessionInput = Schema.Struct({
	userId: Schema.NonEmptyString,
	tenantId: Schema.NonEmptyString
});
const IdentitySendCodeInput = Schema.Struct({ email: Schema.NonEmptyString });
const IdentityAdmitFounderInput = Schema.Struct({
	email: Schema.NonEmptyString,
	tenantId: Schema.NonEmptyString
});
/**
 * Admitting the first administrator *and* starting their session, in one invocation.
 *
 * `claimId` is the id of a proof the host holds — Colony verified that whoever is completing this
 * signup controls `email` — and it is carried here for exactly one purpose: so this command can
 * refuse to act on the same proof twice. Bolt does not check that proof and could not; what it
 * checks is that the invocation came from the host, and that this particular claim is unspent.
 */
const IdentityBootstrapFounderInput = Schema.Struct({
	email: Schema.NonEmptyString,
	claimId: Schema.NonEmptyString,
	tenantId: Schema.NonEmptyString,
	subject: Subject
});
const IdentityVerifyCodeInput = Schema.Struct({
	email: Schema.NonEmptyString,
	code: Schema.NonEmptyString,
	tenantId: Schema.NonEmptyString
});

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
/**
 * What an operator may say about a team, and — by omission — what they may not.
 *
 * There is no policy field on any of these and there is nowhere one could go. Which policies a team
 * holds is declared in `+teams.ts` and compiled into the release, so it changes by deploying and by
 * nothing else; a `teams.*` command shapes the tree and decides who is in it, and that is the whole
 * of its reach.
 *
 * `parentId` and `description` are `optionalKey` over a nullable value because absent and `null`
 * mean different things: absent leaves the column as it is, `null` clears it. Collapsing them would
 * make renaming a team silently unparent it, or make moving one to the root inexpressible.
 */
const TeamCreateInput = Schema.Struct({
	subject: Subject,
	tenantId: Schema.NonEmptyString,
	name: Schema.NonEmptyString,
	parentId: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
	description: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null]))
});
const TeamUpdateInput = Schema.Struct({
	subject: Subject,
	tenantId: Schema.NonEmptyString,
	teamId: Schema.NonEmptyString,
	name: Schema.optionalKey(Schema.NonEmptyString),
	parentId: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
	description: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null]))
});
const TeamDeleteInput = Schema.Struct({
	subject: Subject,
	tenantId: Schema.NonEmptyString,
	teamId: Schema.NonEmptyString
});
/**
 * The person being moved is `memberId`, deliberately not `userId`.
 *
 * `userId` is a `MINTED_IDENTITY` field: the boundary overwrites it with the id of whoever the
 * credential authenticated, on every command, before any case reads it. Naming the target that way
 * would compile, decode and run — and would move the operator instead of the member, every time,
 * with nothing anywhere reporting a fault.
 */
const TeamAssignInput = Schema.Struct({
	subject: Subject,
	tenantId: Schema.NonEmptyString,
	memberId: Schema.NonEmptyString,
	/** The team to put them in, or `null` to take them out of every team. */
	teamId: Schema.Union([Schema.String, Schema.Null])
});
const IdentityAuthenticateInput = Schema.Struct({ credential: Schema.NonEmptyString });
const IdentityResolveInput = Schema.Struct({
	provider: Schema.NonEmptyString,
	externalId: Schema.NonEmptyString
});
const CollectionRecordInput = Schema.Struct({
	subject: Subject,
	collection: Schema.NonEmptyString,
	id: Schema.NonEmptyString
});

/** Owns wire decoding, JSON responses, and credential extraction shared by every invocation kind. */
const DispatchValues = {
	decode: <S extends Schema.Top>(schema: S, value: unknown) =>
		Schema.decodeUnknownEffect(schema)(value).pipe(
			Effect.mapError(
				() =>
					new DispatchError({
						code: 'invalid_input',
						message: 'Command input did not match its schema'
					})
			)
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
	impersonatedTeamFromHeaders: (
		headers: Readonly<Record<string, ReadonlyArray<string>>>
	): string | undefined => {
		const value = Object.entries(headers)
			.find(([name]) => name.toLowerCase() === 'x-colony-impersonated-team')?.[1][0]
			?.trim();
		return value === undefined || value === '' ? undefined : value;
	},
	credentialFromHeaders: (
		headers: Readonly<Record<string, ReadonlyArray<string>>>
	): string | undefined => {
		const authorization = Object.entries(headers).find(
			([name]) => name.toLowerCase() === 'authorization'
		)?.[1][0];
		if (authorization !== undefined) return authorization.replace(/^Bearer\s+/i, '');
		const cookie = Object.entries(headers)
			.find(([name]) => name.toLowerCase() === 'cookie')?.[1]
			.join(';');
		return cookie
			?.split(';')
			.map((part) => part.trim())
			.find((part) => part.startsWith('bolt_session='))
			?.slice('bolt_session='.length);
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
const checkWrittenValues = Effect.fn('Bolt.checkWrittenValues')(function* (
	collection: string,
	values: Readonly<Record<string, Schema.Json>>
) {
	const workspace = yield* Workspace.Service;
	const definition = yield* workspace.collection(collection);
	// Both faults are the same kind of thing — values this collection will not accept — so they are
	// reported the same way, through the `invalid_input` the boundary already has.
	//
	// Relation keys pass through untouched: neither check looks at a key that is not a declared
	// field, so the children of a graph are invisible here and are reached by the walk below instead.
	const invalid =
		describeGeneratedColumnWrite(definition.fields, values) ??
		describeInvalidCustomValue(definition.fields, values, workspace.definition.customTypes);
	if (invalid !== undefined)
		yield* Effect.fail(new DispatchError({ code: 'invalid_input', message: invalid }));
});

/**
 * How far the boundary follows a create graph down.
 *
 * The same bound the runtime's `flattenGraph` applies, and stated here for the same reason: the
 * relation set has cycles in it, so a body that closes one would be walked until the isolate died.
 * The two numbers are independent copies of one decision, which is tolerable only because exceeding
 * either one is a refusal rather than a difference in what gets written — this walk validates and
 * the runtime's walk is what actually refuses.
 */
const GRAPH_CHECK_DEPTH = 5;

/**
 * The same check, down every branch of a create graph.
 *
 * A nested write posts a parent and its children in one body, and the children are rows in *other*
 * collections — so checking only the top level would let a generated column be written on a child
 * and report nothing, which is the failure mode the top-level check exists to end. The walk follows
 * declared `many` relations only, because those are the only keys the runtime will expand; anything
 * else is left alone here and refused by `flattenGraph`, which can say what the key should have
 * been.
 */
const checkWrittenGraph = Effect.fn('Bolt.checkWrittenGraph')(function* (
	collection: string,
	values: Readonly<Record<string, Schema.Json>>
) {
	const workspace = yield* Workspace.Service;
	const relations = workspace.definition.relations ?? [];
	// A worklist rather than recursion: the depth bound is the point of the walk, and a queue makes
	// it a value the loop carries rather than something to be reconstructed from a call stack.
	const pending: Array<{
		readonly collection: string;
		readonly values: Readonly<Record<string, Schema.Json>>;
		readonly depth: number;
	}> = [{ collection, values, depth: 0 }];
	while (pending.length > 0) {
		const node = pending.shift();
		if (node === undefined) break;
		/**
		 * A key is a key wherever it is spelled, and a create assigns none of them.
		 *
		 * Dropping the `id` field off the create body would otherwise leave one way back in: put it
		 * in `values` instead. On the parent that would route the payload through `mutate`'s update
		 * branch, so `collections.create` would perform an update — authorized, but not the operation
		 * anybody asked for. On a child it lands in the insert's column list beside the id the graph
		 * assigned, and the statement fails on a duplicate column with nothing to say about why.
		 */
		if (Object.hasOwn(node.values, 'norbital_id'))
			yield* Effect.fail(
				new DispatchError({
					code: 'invalid_input',
					message: `A create on ${node.collection} carried a norbital_id. Ids are assigned by the server; to change an existing record use collections.update.`
				})
			);
		yield* checkWrittenValues(node.collection, node.values);
		if (node.depth >= GRAPH_CHECK_DEPTH) continue;
		for (const [key, value] of Object.entries(node.values)) {
			if (!Array.isArray(value)) continue;
			const relation = relations.find(
				(candidate) =>
					candidate.name === key &&
					candidate.source === node.collection &&
					candidate.cardinality === 'many' &&
					candidate.from?.column !== undefined
			);
			if (relation === undefined) continue;
			for (const child of value) {
				if (child === null || typeof child !== 'object' || Array.isArray(child)) continue;
				pending.push({
					collection: relation.target,
					values: child as Readonly<Record<string, Schema.Json>>,
					depth: node.depth + 1
				});
			}
		}
	}
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
const SCHEMA_READ_COMMANDS: ReadonlySet<string> = new Set([
	'schema.plan',
	'schema.fingerprint',
	'schema.validate',
	'schema.verify'
]);
// Only a `Command` reaches here at all: `authorizeInvocationProvenance` has already refused the two
// credential-free tags, on which the `subject` this decodes would be whatever the payload claimed.
const authorizeSchemaCommand = Effect.fn('Bolt.authorizeSchemaCommand')(function* (
	command: string,
	commandInput: unknown
) {
	const action = SCHEMA_READ_COMMANDS.has(command) ? 'read' : 'manage';
	const input = yield* decode(Schema.Struct({ subject: Subject }), commandInput);
	yield* (yield* AccessControl.Service).authorize(input.subject, action, SCHEMA_RESOURCE);
});

/**
 * The commands that write membership, and the authority they require.
 *
 * `identity.admitFounder` had no check at all. It upserts a row by email with `status = 'admin'`, so
 * any subject holding a session in the tenant could POST it their own address and become an
 * administrator of the workspace — and `isAdministrator` short-circuits `decide`, `rowPredicate` and
 * `visibleApps`, so that is the whole workspace. It was reachable from a browser: Colony proxies
 * `/api/bolt/command/<name>` and bolt-server serves `/_bolt/command/<name>`, and neither restricts
 * which name.
 *
 * Gated on `manage`/`identity` rather than on `isAdministrator` directly, so that provisioning has a
 * way in that is not "be an administrator": `colony system` enumerates exactly this grant, which is
 * how a host admits the first founder into a workspace that has none. An administrator passes by
 * short-circuit, and everybody else is refused unless the workspace deliberately authored a policy
 * over the `identity` resource — the same vocabulary, and the same author's choice, that `secrets`
 * and `schema` already have.
 *
 * A map rather than a prefix test, because `identity.` is mostly sign-in and session traffic that
 * must stay reachable. It is checked in one place before the switch, so a second membership-writing
 * command is gated by adding a line here rather than by remembering to write a check inside a case.
 */
const IDENTITY_RESOURCE = 'identity';
/**
 * The `teams.*` commands join it, and they are membership writes in exactly the same sense.
 *
 * Administration is a status on the person — `bolt_auth_user.status` — and `decide` short-circuits
 * on it before it consults a policy, so an administrator passes this gate and that is how these are
 * meant to be reached. They are gated on `manage`/`identity` rather than on `isAdministrator`
 * directly for the reason stated above: provisioning needs a way in that is not "be an
 * administrator", and `colony system` enumerates precisely this grant.
 *
 * What no entry here can do is change what a team may *do*. The policies a team holds are compiled
 * into the release, so the reachable surface is the tree's shape and who is in it — a `teams.*`
 * command has no policy argument, and the service it calls has no column to put one in.
 */
const MEMBERSHIP_COMMANDS: ReadonlyMap<string, string> = new Map([
	['identity.admitFounder', 'manage'],
	['teams.create', 'manage'],
	['teams.update', 'manage'],
	['teams.delete', 'manage'],
	['teams.assign', 'manage']
]);
const authorizeMembershipCommand = Effect.fn('Bolt.authorizeMembershipCommand')(function* (
	action: string,
	commandInput: unknown
) {
	const input = yield* decode(Schema.Struct({ subject: Subject }), commandInput);
	yield* (yield* AccessControl.Service).authorize(input.subject, action, IDENTITY_RESOURCE);
});

/**
 * Commands only the host may run, checked against the subject rather than against a policy.
 *
 * `identity.bootstrapFounder` is deliberately *not* an entry in `MEMBERSHIP_COMMANDS` beside
 * `admitFounder`, and the difference is the whole reason this set exists. `admitFounder` writes a
 * row; this one writes a row and hands back a **live session credential** for the address it was
 * given. Gated on `manage`/`identity`, any existing administrator could therefore POST it an
 * arbitrary address and receive a working session as that person — which is a strictly worse
 * primitive than the unchecked `admitFounder` that made `MEMBERSHIP_COMMANDS` necessary in the
 * first place.
 *
 * `subject.system` is the narrower thing to gate on because it has exactly one constructor:
 * `SystemPrincipal.systemSubject`, minted only after `verifySystemSignature` accepts a digest over
 * the timestamp, the command, the tenant and the arguments. It cannot be decoded from a payload —
 * `subject` is a `MINTED_IDENTITY` field, refused on every other path — so there is no route from a
 * row, a cookie or an authored policy to holding it. An administrator is not enough, and an
 * administrator being not enough is the point.
 */
const SYSTEM_ONLY_COMMANDS: ReadonlySet<string> = new Set([
	'identity.bootstrapFounder',
	/**
	 * The inbound channel port, which would otherwise be the widest hole in this runtime.
	 *
	 * `channels.receive` no longer decodes a `Subject` — it resolves the requestor itself from the
	 * channel's declared policy — and that removal is exactly what makes this entry necessary. A
	 * command that names no identity is a command the credential path admits without one, so without
	 * this line anybody who could reach the port could post a JSON body and make a workspace's agent
	 * run a turn, as that workspace's channel principal, against that workspace's data. The sender
	 * address in the payload is attacker-chosen, so they could also choose *whose* assignments the
	 * turn narrowed to.
	 *
	 * Gating it on the gateway signature is the honest expression of what a channel message is: proof
	 * that a message came from WhatsApp requires WhatsApp's credential, which the tenant does not
	 * hold, so the host authenticates the wire and says so with a signature over the timestamp, the
	 * command, the tenant and the arguments. Nothing else can assert that a message arrived.
	 */
	'channels.receive'
]);

/** The prefix a spent founder claim is filed under, so it cannot collide with a sign-in code's row. */
const FOUNDER_CLAIM_IDENTIFIER = 'founder-claim:';

/**
 * How long a spent claim stays on the ledger: a day, against a signature that is stale in five
 * minutes.
 *
 * The number only has to exceed `SIGNATURE_LIFETIME_MILLIS`, because after that a replayed
 * invocation is refused by arithmetic and needs no row to refuse it. A day is that with three
 * orders of magnitude of headroom for clock skew and for a founder who left the tab open.
 */
const FOUNDER_CLAIM_LEDGER_MILLIS = 86_400_000;

const authorizeSystemCommand = Effect.fn('Bolt.authorizeSystemCommand')(function* (
	command: string,
	commandInput: unknown
) {
	const input = yield* decode(Schema.Struct({ subject: Subject }), commandInput);
	if (input.subject.system === true) return;
	return yield* new AccessControl.AccessDenied({
		action: 'manage',
		resource: command,
		reason: `${command} mints a session, so it is reachable only by the host proving itself per invocation; an administrator's own authority is not enough`
	});
});

/**
 * A team on the wire, with nulls where the row has none.
 *
 * Spelled out rather than spread, so a column added to `bolt_team` cannot reach a client by
 * accident — and so the shape is stable whether the team has a parent or not, which is what lets the
 * settings surface read it with one decoder.
 */
const teamJson = (team: Identity.TeamRecord): Schema.Json => ({
	id: team.id,
	name: team.name,
	parentId: team.parentId ?? null,
	description: team.description ?? null
});

/**
 * How a team write's answer reaches the caller.
 *
 * Every refusal these produce is the caller naming a state that is not there — a team that does not
 * exist, a name somebody already holds, a team that still has members — so they are reported through
 * the `invalid_input` this boundary already has, which `app.ts` maps to 400. Reusing it is the point:
 * a new failure type would need a new arm in that match, and until somebody wrote one these would
 * report as 500s telling the caller to retry a request that cannot succeed.
 */
const teamAnswer = Effect.fn('Bolt.teamAnswer')(function* (
	outcome: Identity.TeamOutcome | Identity.TeamAssignment
) {
	if (outcome._tag === 'Refused')
		return yield* new DispatchError({ code: 'invalid_input', message: outcome.reason });
	return outcome._tag === 'Team'
		? json({ team: teamJson(outcome.team) })
		: json({
				memberId: outcome.memberId,
				team: outcome.team === undefined ? null : teamJson(outcome.team)
			});
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
/** The one command a host's timer sends, named once so the gate and the router cannot disagree. */
const TICK_COMMAND = 'tasks.tick';

const ENQUEUED_COMMANDS: ReadonlySet<string> = new Set([
	'integrations.pull',
	'integrations.flush',
	// A delegated turn. `sandbox-tools.ts` has enqueued this since delegation was written, and it was
	// never listed here — harmless only for as long as nothing executed the queue. The first tick
	// would have refused every subagent, and the refusal would have named the provenance gate rather
	// than the missing entry.
	'agents.turn',
	'agents.resume',
	'collections.resume',
	'collections.discard',
	// The tick itself, which is the only command a host's timer ever sends. It takes no input and
	// carries no identity, and everything it goes on to run is checked against the derived set below.
	TICK_COMMAND
]);

/**
 * What a *task row* may name, which is not the same set as what a host invocation may name.
 *
 * The difference is one command and it is the important one. A host's timer must be able to invoke
 * `tasks.tick`; a row inside `bolt_task` must not, because the command that runs other commands is
 * not itself one of them. Left in, a row naming `tasks.tick` would pass the runner's check and a
 * tick would run a tick — bounded rather than infinite, since each level hides what it takes, but it
 * nests the invocation budget for nothing and grants a capability nobody intended.
 *
 * Derived rather than written out a second time, and named rather than expressed as a `.delete()`
 * somewhere, so the asymmetry between the two gates is visible at both of them.
 */
const TASK_RUNNABLE_COMMANDS: ReadonlySet<string> = new Set(
	[...ENQUEUED_COMMANDS].filter((command) => command !== TICK_COMMAND)
);

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
/**
 * Whether a command belongs to a set the runtime enqueues, resolving authored automations by name.
 *
 * `automations.<name>` is checked against the declared automations rather than matched on the
 * prefix, because `automations.start`, `.register`, `.runStep`, `.status` and `.cancel` share it and
 * are host commands rather than enqueued ones.
 */
const isRunnable = Effect.fn('Bolt.isRunnable')(function* (
	command: string,
	allowed: ReadonlySet<string>
) {
	if (allowed.has(command)) return true;
	return (yield* Workspace.Service).definition.automations.some(
		({ name }) => `automations.${name}` === command
	);
});

const authorizeInvocationProvenance = Effect.fn('Bolt.authorizeInvocationProvenance')(function* (
	tag: Invocation['_tag'],
	command: string
) {
	const enqueued = tag === 'Task' && (yield* isRunnable(command, ENQUEUED_COMMANDS));
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
const MINTED_IDENTITY = [
	'subject',
	'actor',
	'userId',
	'tenantId',
	'invitedBy',
	'impersonatedTeam'
] as const;

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
const collectionPage = Effect.fn('Bolt.collectionPage')(function* (
	effectId: EffectId,
	input: typeof CollectionFindInput.Type
) {
	const query = DispatchValues.collectionQuery(input);
	const workspace = yield* Workspace.Service;
	const definition = yield* workspace.collection(input.collection);
	const collections = yield* Collections.Service;
	const rows = yield* collections.findMany(effectId, input.subject, {
		...query,
		limit: query.limit + 1
	});
	const page = rows.slice(0, query.limit);
	const last = page[page.length - 1];
	// Compiled the same way the seek predicate was, so the tuple the cursor carries is the tuple the
	// next page's seek compares against — including the primary key `compileOrderTerms` appends.
	const ordering = compileOrderTerms(
		input.orderBy,
		makeWhereContext(input.collection, definition.fields, workspace.definition)
	);
	return json({
		rows: page,
		nextCursor:
			rows.length > query.limit && last !== undefined
				? Collections.encodeCollectionCursor(ordering, last)
				: null
	});
});

/**
 * The rows a write is answered with, filtered to what this subject may read.
 *
 * The write path reads its rows back *elevated* — it has to, because the row it just wrote may sit
 * behind a visibility predicate the writer cannot see past, and an `after` hook still has to be
 * handed the record. That is right inside the runtime and wrong on the way out of it: a response is
 * a disclosure, and a field this subject may not read must not arrive because they wrote the row
 * rather than queried it. So the same `mask` a read applies is applied here, at the boundary, which
 * leaves `mutate` returning the whole row to the authored code that needs it.
 *
 * A subject with no read grant at all is masked down to `{}` rather than refused: the write
 * happened, and the id is still reported beside these records.
 *
 * A row that is not JSON is a failure rather than an empty object. The host's database facility is
 * required to hand back JSON — a `Date` that survived the seam is the recurring form of that being
 * broken — and a mask cannot be applied to a value whose fields it cannot read. Answering `{}` there
 * would report a successful write that stored nothing, which reads exactly like a legitimately empty
 * row and is therefore the version of this nobody would ever look into.
 */
const maskStoredRecords = Effect.fn('Bolt.maskStoredRecords')(function* (
	subject: Identity.Subject,
	collection: string,
	rows: ReadonlyArray<Readonly<Record<string, unknown>>>
) {
	const access = yield* AccessControl.Service;
	const masked: Array<Readonly<Record<string, Schema.Json>>> = [];
	for (const row of rows) {
		if (!Schema.is(StoredRecord)(row))
			return yield* new DispatchError({
				code: 'invalid_stored_record',
				message: `A stored ${collection} row came back in a shape that is not JSON, so it cannot be filtered for this caller. The database facility is required to return JSON values.`
			});
		masked.push(access.mask(subject, 'read', collection, row));
	}
	return masked;
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
		if (new URL(invocation.url, 'http://bolt.invalid').pathname === '/health')
			return json({ status: 'ok' });
		const credential = credentialFromHeaders(invocation.headers);
		if (credential === undefined || credential === '')
			return yield* new DispatchError({
				code: 'unauthorized',
				message: 'Missing authorization credential'
			});
		const identity = yield* Identity.Service;
		const subject = yield* identity.authenticate(EffectId.make(invocation.id), credential);
		if (subject.tenantId !== invocation.scope.tenantId)
			return yield* new DispatchError({
				code: 'tenant_mismatch',
				message: 'Authenticated subject is outside the invocation tenant'
			});
		const access = yield* AccessControl.Service;
		return json({ subject, apps: access.visibleApps(subject) });
	}
	if (invocation._tag === 'Realtime') {
		if (invocation.event._tag === 'Open')
			return { status: 200, headers: {}, realtime: { frames: [], nextCursor: '0' } };
		if (invocation.event._tag === 'Input') {
			const cursor = String(invocation.event.frame.sequence);
			return {
				status: 200,
				headers: {},
				realtime: {
					frames: [
						{ cursor, kind: invocation.event.frame.kind, bytes: invocation.event.frame.bytes }
					],
					nextCursor: cursor
				}
			};
		}
		return {
			status: 200,
			headers: {},
			realtime: {
				frames: [],
				...(invocation.event._tag === 'Close' || invocation.event._tag === 'Cancel'
					? {
							close: {
								code: invocation.event._tag === 'Close' ? invocation.event.code : 1000,
								reason: invocation.event.reason
							}
						}
					: {})
			}
		};
	}
	if (invocation._tag !== 'Command' && invocation._tag !== 'Plugin' && invocation._tag !== 'Task') {
		return yield* new DispatchError({
			code: 'unsupported_invocation',
			message: 'Unsupported Bolt invocation'
		});
	}
	const effectId = EffectId.make(invocation.id);
	if (invocation._tag === 'Plugin' && invocation.plugin === 'data-browser') {
		if (invocation.command !== 'query')
			return yield* new DispatchError({
				code: 'unknown_plugin_command',
				message: `Unknown Data Browser command: ${invocation.command}`
			});
		const input = yield* decode(DataBrowserInput, invocation.input);
		const context = yield* decode(PluginContext, invocation.trustedContext);
		// The same credential the `Command` path reads, authenticated the same way, because the Data
		// Browser is a read of tenant data and there is no weaker thing it could be. Refused when it is
		// absent rather than downgraded to an empty role set: a silent empty result reads as "this
		// workspace has no rows" and sends the operator looking for the wrong fault.
		const credential = credentialFromHeaders(invocation.headers);
		if (credential === undefined || credential === '') {
			return yield* new AccessControl.AccessDenied({
				action: 'read',
				resource: input.collection,
				reason:
					'a Plugin invocation must present a credential before its trustedContext is honoured'
			});
		}
		const identity = yield* Identity.Service;
		const actor = yield* identity.authenticate(effectId, credential);
		if (actor.tenantId !== invocation.scope.tenantId)
			return yield* new DispatchError({
				code: 'tenant_mismatch',
				message: 'Plugin actor is outside the invocation tenant'
			});
		const subject = yield* Effect.gen(function* () {
			if (context.impersonatedSubject === undefined) return actor;
			const target = yield* identity.resolveSubject(
				effectId,
				'colony',
				context.impersonatedSubject
			);
			if (target.tenantId !== invocation.scope.tenantId)
				return yield* new DispatchError({
					code: 'tenant_mismatch',
					message: 'Plugin target is outside the invocation tenant'
				});
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
		return json(
			yield* Effect.provideService(
				collections.findMany(effectId, subject, {
					collection: input.collection,
					...(limit === undefined ? {} : { limit })
				}),
				Identity.CurrentSubject,
				subject
			)
		);
	}
	const authenticated = yield* Effect.gen(function* () {
		const fields =
			typeof invocation.input === 'object' &&
			invocation.input !== null &&
			!Array.isArray(invocation.input)
				? invocation.input
				: {};
		if (invocation._tag !== 'Command') {
			yield* authorizeInvocationProvenance(invocation._tag, invocation.command);
			// Refused, not stripped: a payload that names a subject is asking to run as somebody, and
			// answering `invalid_input` would report that as a malformed request rather than as the claim
			// it is. A task that names nobody passes here and fails to decode in its own case, which is
			// the same refusal by the schema each case already declares.
			const claimed = MINTED_IDENTITY.find((name) => name in fields);
			if (claimed !== undefined) {
				return yield* new AccessControl.AccessDenied({
					action: 'authenticate',
					resource: invocation.command,
					reason: `a ${invocation._tag} invocation carries no credential, so the ${claimed} its payload claims is refused`
				});
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
		// question, answered in front of the forward by whatever gates the host puts there.
		if (SIGN_IN_COMMANDS.has(invocation.command)) {
			const claimed = MINTED_IDENTITY.find((name) => name in fields);
			if (claimed !== undefined) {
				return yield* new AccessControl.AccessDenied({
					action: 'authenticate',
					resource: invocation.command,
					reason: `a sign-in carries no credential, so the ${claimed} its payload claims is refused`
				});
			}
			return { input: { ...fields, tenantId: invocation.scope.tenantId }, subject: undefined };
		}
		/**
		 * The host, provisioning a workspace nobody belongs to yet.
		 *
		 * Checked before the credential is demanded, for the same structural reason a sign-in is: there
		 * is nobody to hold a credential. A freshly created database has no tables, so it has no
		 * `bolt_auth_user` to be an administrator in and no `bolt_auth_session` to authenticate
		 * against — and `schema.migrate` is the command that would create both. The authority to break
		 * that deadlock cannot come from the workspace's own membership.
		 *
		 * What it comes from instead is possession of `COLONY_GATEWAY_SECRET`, proved per invocation
		 * over the timestamp, the command, the tenant and the arguments. The subject that produces is
		 * an ordinary one carrying one role, and `COLONY_SYSTEM_POLICY` — merged into every workspace
		 * definition by `withSystemCollections` — is what that role matches. So this is not a branch
		 * that skips access control; it is the only constructor for one particular subject, which then
		 * goes through `decide` like everybody else and is refused everything the policy does not
		 * enumerate.
		 *
		 * The previous arrangement is what this replaces, rather than joins: the host used to write a
		 * `bolt_auth_user` row and a `bolt_auth_session` row straight into the tenant database over
		 * `pg`, then hand bolt the token. That made provisioning authority a *row* — created before it
		 * was needed, deleted afterwards if nothing crashed, and indistinguishable at the point of
		 * decision from a person's. Nothing is written here and nothing needs revoking; the authority
		 * exists for the length of one invocation and the signature that carries it is stale in five
		 * minutes.
		 *
		 * Logged rather than audited, and deliberately: `bolt_audit` is a table that does not exist yet
		 * during the migration this authorises, so a row would fail exactly when it mattered most. The
		 * line names `colony system` so an operator reading "who migrated this schema" sees the host and
		 * not a person; anything downstream that records a subject id records `colony-system` too.
		 */
		if (
			yield* SystemPrincipal.verifySystemSignature({
				headers: invocation.headers,
				command: invocation.command,
				tenantId: invocation.scope.tenantId,
				input: invocation.input,
				now: Date.now()
			})
		) {
			// Annotated rather than inferred, so the absence of `admin` is checked here rather than
			// discovered downstream: a system principal that ever gained that key would short-circuit
			// `decide`, `rowPredicate` and `visibleApps` and stop being the enumerated thing it is.
			const subject: Subject = SystemPrincipal.systemSubject(invocation.scope.tenantId);
			yield* Effect.log(
				`bolt.dispatch: ${invocation.command} authorized as colony system for ${invocation.scope.tenantId}`
			);
			// The same minting the credential path does, so no payload field survives to be read as
			// identity. `actor` is the system principal itself: nobody is impersonating anybody, and a
			// preview header is dropped rather than honoured — `subjectAsTeam` refuses a non-administrator
			// anyway, and a system principal must never be narrowed into a workspace role.
			return {
				input: {
					...fields,
					subject,
					actor: subject,
					userId: subject.userId,
					tenantId: invocation.scope.tenantId,
					invitedBy: subject.userId,
					impersonatedTeam: null
				},
				subject
			};
		}
		const credential = credentialFromHeaders(invocation.headers);
		if (credential === undefined || credential === '')
			return yield* new DispatchError({
				code: 'unauthorized',
				message: 'Missing command credential'
			});
		const actor = yield* (yield* Identity.Service).authenticate(effectId, credential);
		if (actor.tenantId !== invocation.scope.tenantId)
			return yield* new DispatchError({
				code: 'tenant_mismatch',
				message: 'Authenticated subject is outside the invocation tenant'
			});
		/**
		 * The one place a team preview changes what this invocation is.
		 *
		 * It substitutes the *subject* rather than filtering any particular answer, which is the whole
		 * point: `visibleApps` decides what the sidebar offers, but the row predicate is what decides
		 * whether a read is served, and both read the subject's team. Narrowing the subject once here moves
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
		const subject =
			team === undefined ? actor : yield* (yield* AccessControl.Service).subjectAsTeam(actor, team);
		return {
			input: {
				...fields,
				subject,
				actor,
				userId: actor.userId,
				tenantId: actor.tenantId,
				invitedBy: actor.userId,
				impersonatedTeam: team ?? null
			},
			subject
		};
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
	/**
	 * The workspace's own rate policy, applied after identity is settled and before the command runs.
	 *
	 * Here rather than at the edge because this is the first point at which the three facts a real
	 * limit is written in terms of all exist: which command was called, which tenant it belongs to,
	 * and who is behind it. A reverse proxy sees none of them — behind Traefik it does not reliably
	 * see even the client IP, which is how one Colony bucket keyed on `getClientAddress()` came to be
	 * shared by every visitor to the host.
	 *
	 * After authentication, so a signed-in person is counted as themselves rather than pooled with
	 * every other anonymous caller; before the command body, so a refusal costs a map lookup rather
	 * than the work it was protecting.
	 */
	yield* (yield* RateLimits.Service).admit(invocation.command, {
		tenantId: String(invocation.scope.tenantId),
		...(authenticated.subject === undefined ? {} : { userId: authenticated.subject.userId }),
		...(rateLimitAddress(invocation.input) === undefined
			? {}
			: { address: rateLimitAddress(invocation.input) as string })
	});
	const invoked =
		invocation.command === TICK_COMMAND
			? runTick(effectId)
			: runCommand(invocation.command, effectId, authenticated.input);
	return yield* authenticated.subject === undefined
		? invoked
		: Effect.provideService(invoked, Identity.CurrentSubject, authenticated.subject);
});

/**
 * One tick of the tenant's own scheduler, and the only command a host's timer ever sends.
 *
 * It lives beside the switch rather than inside it, and that is a type-level fact before it is a
 * design one: a `case` that re-enters `runCommand` makes `runCommand` referenced in its own
 * initializer, so TypeScript cannot infer its type and answers `any` — taking every one of the
 * ninety-odd cases below it with it. Lifting the one command that *runs other commands* out of the
 * set of commands is also the more honest shape, because that is exactly what makes it different.
 *
 * Everything it goes on to run is checked against `ENQUEUED_COMMANDS` again, here, one task at a
 * time. That second check is not belt and braces: `authorizeInvocationProvenance` gates what a
 * `Task` *invocation* may name, and this is one invocation naming one command — `tasks.tick` — that
 * then reaches the switch N more times with commands it read out of a table. Without it, anything
 * that could get a row into `bolt_task` could name `identity.startSession` and have it run with no
 * credential at all. The rows are written by the runtime, but "written by the runtime today" is not
 * a property the switch can see, and a gate has to hold on what it can.
 *
 * A refused or failed command fails its own task rather than the tick, so one bad row backs off and
 * eventually lands in `failed` instead of stopping every other task in the workspace.
 */
/**
 * Whether one row of `bolt_task` may run, checked per task rather than per invocation.
 *
 * `authorizeInvocationProvenance` gates what a `Task` *invocation* may name, and a tick is one
 * invocation naming one command that then reaches the switch N more times with commands read out of
 * a table. So the check happens again here, against the narrower set: the tick itself is invocable
 * by a host and not runnable as a row.
 */
const authorizeTaskCommand = Effect.fn('Bolt.authorizeTaskCommand')(function* (command: string) {
	if (yield* isRunnable(command, TASK_RUNNABLE_COMMANDS)) return;
	yield* new AccessControl.AccessDenied({
		action: 'invoke',
		resource: command,
		reason: `${command} is not a command the runtime enqueues, so no task row may name it`
	});
});

const runTick = Effect.fn('Bolt.runTick')(function* (effectId: EffectId) {
	const report = yield* (yield* TaskQueue.Service).tick(effectId, (task, attemptEffectId) =>
		authorizeTaskCommand(task.command).pipe(
			Effect.andThen(() => runCommand(task.command, EffectId.make(attemptEffectId), task.input)),
			Effect.match({
				onSuccess: (response) =>
					response.status >= 200 && response.status < 300
						? ({ _tag: 'Done', task, result: response.value ?? null } as const)
						: ({
								_tag: 'Failed',
								task,
								// A code and a short reason. Never the value: a command's body is where a
								// partner's data and a person's record are, and `bolt_task.error` is readable by
								// anyone who can see the operations panel.
								error: `status ${response.status}`
							} as const),
				onFailure: (cause) => ({ _tag: 'Failed', task, error: describeCause(cause) }) as const
			})
		)
	);
	return json({
		ran: report.ran,
		rolled: report.rolled,
		declined: report.declined,
		nextDueAtEpochMs: report.nextDueAtEpochMs ?? null,
		// Surfaced rather than logged: a schedule that could not be read has been retired, and the only
		// place that says so is the answer to the tick that retired it.
		rejections: report.rejections.map((rejection) => ({ ...rejection }))
	});
});

/**
 * The address a payload names, for a limit keyed on one.
 *
 * Read off the raw payload rather than a decoded one because it is needed before the command's own
 * schema has run — the point of an `address` limit is to bound anonymous traffic, and anonymous
 * traffic is exactly what has no subject to key on. Read defensively for the same reason: this is
 * untrusted input, and a payload that carries something other than a string simply keys on nothing
 * and shares the fallback bucket.
 *
 * It is a *key*, never an authorisation. Naming an address here says nothing about who the caller
 * is; it only decides which counter they spend from, and a caller who varies it is spending from a
 * fresh counter each time — which is why an address limit exists to protect what sending to that
 * address costs, and never to establish identity.
 */
const rateLimitAddress = (payload: unknown): string | undefined => {
	if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
	for (const field of ['address', 'email']) {
		const value = Reflect.get(payload, field);
		if (typeof value === 'string' && value.trim() !== '') return value;
	}
	return undefined;
};

/**
 * Everything a command does once its identity is settled, which is why it is a function.
 *
 * The switch used to be the tail of `dispatchInvocation`, and there was nowhere to stand between
 * "the credential has been checked" and "the command runs" — authentication happens inside the
 * block that builds the command input. Splitting the body out gives the subject a scope to be
 * provided over, so a facility called from any of the ninety-odd cases below carries it without
 * one of them being edited.
 */
const runCommand = Effect.fn('Bolt.runCommand')(function* (
	command: string,
	effectId: EffectId,
	commandInput: unknown
) {
	if (command.startsWith('invoke.')) {
		const values = yield* decode(
			Schema.Struct({ subject: Subject, input: Schema.Json }),
			commandInput
		);
		return json(
			yield* (yield* RemoteRegistry).invoke(
				command.slice('invoke.'.length),
				values.input,
				values.subject,
				effectId
			)
		);
	}
	// Gated before the switch, not case by case: the five schema commands were each written without a
	// check, and one gate on the prefix is the only form a sixth cannot be added past.
	if (command.startsWith('schema.')) yield* authorizeSchemaCommand(command, commandInput);
	const membership = MEMBERSHIP_COMMANDS.get(command);
	if (membership !== undefined) yield* authorizeMembershipCommand(membership, commandInput);
	if (SYSTEM_ONLY_COMMANDS.has(command)) yield* authorizeSystemCommand(command, commandInput);
	switch (command) {
		case 'health':
			return json({ status: 'ok' });
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
			yield* (yield* Secrets.Service).write(
				effectId,
				input.name,
				input.value,
				input.subject.userId
			);
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
			return json({
				subject: yield* access.impersonate(input.actor, input.target),
				apps: access.visibleApps(input.target)
			});
		}
		/**
		 * What the sidebar needs to render the picker: may this actor impersonate, what may they
		 * become, and what are they right now.
		 *
		 * A command rather than something stamped onto the document, for the same reason `apps.visible`
		 * is one: the answer is this tenant's own `bolt_team` rows crossed with the credential's
		 * standing, and only the tenant runtime holds both.
		 */
		case 'access.impersonation': {
			const input = yield* decode(ImpersonationStateInput, commandInput);
			const access = yield* AccessControl.Service;
			// Awaited, because the teams are rows now rather than a projection of the policy list.
			const teams = yield* access.impersonationTeams();
			return json({
				isAdmin: access.mayImpersonate(input.actor),
				isActive: input.impersonatedTeam !== null,
				activeTeamIds: input.impersonatedTeam === null ? [] : [input.impersonatedTeam],
				teams
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
			const decision =
				command === 'access.predicate'
					? access.predicate(input.subject, input.action, input.resource)
					: access.explain(input.subject, input.action, input.resource);
			return json({ allowed: decision.allowed, reason: decision.reason });
		}
		case 'access.mask': {
			const input = yield* decode(AccessMaskInput, commandInput);
			return json(
				(yield* AccessControl.Service).mask(
					input.subject,
					input.action,
					input.resource,
					input.value
				)
			);
		}
		case 'identity.authenticate': {
			const input = yield* decode(IdentityAuthenticateInput, commandInput);
			return json(yield* (yield* Identity.Service).authenticate(effectId, input.credential));
		}
		case 'identity.resolveSubject': {
			const input = yield* decode(IdentityResolveInput, commandInput);
			return json(
				yield* (yield* Identity.Service).resolveSubject(effectId, input.provider, input.externalId)
			);
		}
		case 'identity.admitFounder': {
			const input = yield* decode(IdentityAdmitFounderInput, commandInput);
			const definition = (yield* Workspace.Service).definition;
			/**
			 * The founder is an administrator, not a person holding every role at once.
			 *
			 * This used to derive `roles` from every policy the workspace declares, plus a synthetic
			 * `impersonator`. That made the first administrator simultaneously an employee, a
			 * supervisor, a manager and an HR controller — which is not a description of anybody, and
			 * which made their authority a function of the ladder: adding a policy changed what an
			 * administrator was, and anything that stopped supplying roles removed the workspace from
			 * them entirely. Authority is now the `admin` status on their own row, and
			 * `AccessControl.decide` short-circuits on it before it consults a policy at all.
			 *
			 * `roles` is therefore empty. There is nothing for it to hold: `admin` is not a role, and
			 * assigning the six real ones would be a lie about what this person does in the workspace.
			 *
			 * They are placed in no team, and that is the whole of the change here.
			 *
			 * This used to *derive* a teams array by walking every policy, every grant and every approval
			 * step in the workspace and collecting each `approvers` name — because `admin` does not
			 * bypass approvals, so a founder who administers everything could still raise an
			 * approval-gated record that nobody was eligible to decide. With no team rows and no place
			 * to manage them, guessing was the only defence available.
			 *
			 * Teams are rows now and an operator puts people in them, so the guess goes. The consequence
			 * is deliberate and visible rather than silently pre-empted: immediately after provisioning
			 * the founder administers everything and can decide nothing that is gated, and the fix is to
			 * put them in a team.
			 */
			// `tenantId` is stamped onto every command input from the invocation scope, never read from
			// the payload — so a caller cannot admit a founder into somebody else's workspace.
			const founderId = yield* (yield* Identity.Service).admit(
				effectId,
				input.tenantId,
				input.email,
				null,
				ADMIN_STATUS
			);
			return json({ admitted: true, userId: founderId, admin: true });
		}
		/**
		 * The founder, admitted and signed in, on the strength of a proof the host holds.
		 *
		 * ## What each side owns
		 *
		 * Colony proved an inbox. That proof is not an identity — no user, no session, no directory
		 * row — and Colony has no way to turn it into one, which is the property the whole split
		 * exists to preserve. This command is where the proven address becomes a person: `admit`
		 * writes the administrator row and `startSession` mints the credential, both inside the
		 * workspace that owns them. Bolt remains the only session issuer on the platform.
		 *
		 * Bolt does not verify the code, the challenge or the claim. It cannot — it never saw the
		 * mail. What it verifies is that the invocation is the *host*, proved per invocation by a
		 * signature over the timestamp, the command, the tenant and these arguments, and refused
		 * outright for everybody else by `SYSTEM_ONLY_COMMANDS`.
		 *
		 * `tenantId` is stamped from `invocation.scope`, never read from the payload, so a caller
		 * cannot bootstrap a founder into somebody else's workspace.
		 *
		 * ## The replay ledger, and what is deliberately not in it
		 *
		 * The ledger row records `claimId -> userId`. It does **not** record the credential, and that
		 * is a decision rather than an omission: a live session token at rest in a table of
		 * short-lived verification artifacts is a secret outliving the flow that made it. An
		 * idempotent retry therefore looks the founder up and mints a *fresh* session for them.
		 *
		 * The cost is that a retried call can leave more than one live session for the founder. That
		 * is accepted, not overlooked — same person, same tenant, same status, and sessions expire.
		 * Please do not "fix" it by storing the credential.
		 *
		 * `bolt_auth_verification` is reused rather than a table added, because it already holds
		 * exactly this kind of thing and adding a collection would put a schema step in front of
		 * every existing tenant. Note what that reuse implies: Better Auth deletes every row whose
		 * `expires_at` has passed on each `findVerificationValue`, so this row is genuinely swept.
		 * That is harmless *because of the arithmetic*, and only because of it — a captured
		 * invocation is refused by `SIGNATURE_LIFETIME_MILLIS` five minutes after it was signed, so
		 * an expiry set well beyond that window means the ledger is always present for the entire
		 * period in which a replay is possible at all. Shortening the expiry below the signature
		 * lifetime would open exactly the hole this row closes.
		 */
		case 'identity.bootstrapFounder': {
			const input = yield* decode(IdentityBootstrapFounderInput, commandInput);
			const identity = yield* Identity.Service;
			const database = yield* Database.Service;
			const ledgerIdentifier = `${FOUNDER_CLAIM_IDENTIFIER}${input.claimId}`;
			const recorded = yield* database.execute(effectId, {
				_tag: 'Query',
				sql: 'select "value" from bolt_auth_verification where "identifier" = $1 limit 1',
				parameters: [ledgerIdentifier]
			});
			const ledgerRow: unknown = recorded.rows[0];
			const spentBy =
				typeof ledgerRow === 'object' && ledgerRow !== null
					? Reflect.get(ledgerRow, 'value')
					: undefined;
			if (typeof spentBy === 'string' && spentBy.length > 0) {
				const [userId, ...rest] = spentBy.split(' ');
				const boundEmail = rest.join(' ');
				/**
				 * The same claim for a different address is a replay, and is refused.
				 *
				 * The same claim for the same address is the network having been retried, and is
				 * answered — with a new session for the founder already on the row, never by
				 * admitting anybody a second time.
				 */
				if (boundEmail !== input.email || userId === undefined || userId.length === 0) {
					return yield* new AccessControl.AccessDenied({
						action: 'manage',
						resource: command,
						reason: 'this founder claim has already been spent, and not for this address'
					});
				}
				return json({
					admitted: true,
					userId,
					admin: true,
					credential: yield* identity.startSession(effectId, userId, input.tenantId)
				});
			}
			// The same admission `identity.admitFounder` performs, and for the same reason: `admin` is
			// a status on the row rather than a bundle of roles, and `AccessControl.decide`
			// short-circuits on it before it consults a policy at all.
			const founderId = yield* identity.admit(
				effectId,
				input.tenantId,
				input.email,
				null,
				ADMIN_STATUS
			);
			// Written before the session is minted, so a crash between the two leaves a claim that is
			// spent rather than one that can be spent again. The founder is already an administrator
			// at that point and signs in the ordinary way, which is the safe direction to fail.
			yield* database.execute(effectId, {
				_tag: 'Query',
				// `"expiresAt"` is quoted camelCase because that is the column the collection declares and
				// the migration creates — `bolt_auth_*` follows Better Auth's own naming, not the
				// snake_case the rest of the schema uses. An unquoted or snake_cased name here is a
				// statement that fails only in the tenant database, at signup, in production.
				sql: 'insert into bolt_auth_verification ("identifier", "value", "expiresAt") values ($1, $2, $3)',
				parameters: [
					ledgerIdentifier,
					`${founderId} ${input.email}`,
					new Date(Date.now() + FOUNDER_CLAIM_LEDGER_MILLIS).toISOString()
				]
			});
			return json({
				admitted: true,
				userId: founderId,
				admin: true,
				credential: yield* identity.startSession(effectId, founderId, input.tenantId)
			});
		}
		case 'identity.invite': {
			const input = yield* decode(IdentityInviteInput, commandInput);
			return json({
				invitationId: yield* (yield* Identity.Service).invite(
					effectId,
					input.tenantId,
					input.email,
					input.invitedBy
				)
			});
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
			return json({
				credential: yield* (yield* Identity.Service).verifyCode(
					effectId,
					input.email,
					input.code,
					input.tenantId
				)
			});
		}
		case 'identity.startSession': {
			const input = yield* decode(IdentitySessionInput, commandInput);
			return json({
				credential: yield* (yield* Identity.Service).startSession(
					effectId,
					input.userId,
					input.tenantId
				)
			});
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
		/**
		 * The four writes behind the `teams` array `identity.workspaceAccess` returns.
		 *
		 * They sit here, beside that projection, because they are the other half of one surface: the
		 * read lists every team including the empty ones, and these are how an operator makes one, moves
		 * it, retires it, and puts somebody in it. Without them the read was a list nobody could act on
		 * — and an empty team, which is exactly what a newly declared `approvers` name reconciles into,
		 * would be visible and permanently unfillable.
		 *
		 * All four are gated once, before this switch, by `MEMBERSHIP_COMMANDS`.
		 *
		 * `subject.userId` is the person the audit row names. Under a team preview `subjectAsTeam`
		 * substitutes the team and the policies but keeps the actor's own identity, so this is the real
		 * credential holder either way — and a preview drops `admin`, so a previewing administrator is
		 * refused by the gate above before reaching any of this.
		 *
		 * `tenantId` is minted from the invocation scope, never read from the payload.
		 */
		case 'teams.create': {
			const input = yield* decode(TeamCreateInput, commandInput);
			return yield* teamAnswer(
				yield* (yield* Identity.Service).createTeam(
					effectId,
					input.tenantId,
					input.subject.userId,
					{
						name: input.name,
						...(input.parentId === undefined ? {} : { parentId: input.parentId }),
						...(input.description === undefined ? {} : { description: input.description })
					}
				)
			);
		}
		case 'teams.update': {
			const input = yield* decode(TeamUpdateInput, commandInput);
			return yield* teamAnswer(
				yield* (yield* Identity.Service).updateTeam(
					effectId,
					input.tenantId,
					input.subject.userId,
					input.teamId,
					{
						...(input.name === undefined ? {} : { name: input.name }),
						...(input.parentId === undefined ? {} : { parentId: input.parentId }),
						...(input.description === undefined ? {} : { description: input.description })
					}
				)
			);
		}
		case 'teams.delete': {
			const input = yield* decode(TeamDeleteInput, commandInput);
			return yield* teamAnswer(
				yield* (yield* Identity.Service).deleteTeam(
					effectId,
					input.tenantId,
					input.subject.userId,
					input.teamId
				)
			);
		}
		case 'teams.assign': {
			const input = yield* decode(TeamAssignInput, commandInput);
			return yield* teamAnswer(
				yield* (yield* Identity.Service).assignTeam(
					effectId,
					input.tenantId,
					input.subject.userId,
					input.memberId,
					input.teamId
				)
			);
		}
		case 'approvals.request': {
			const input = yield* decode(ApprovalRequestInput, commandInput);
			const approvals = yield* Approvals.Service;
			return json(
				yield* approvals.request(effectId, input.subject, input.requestId, input.operation)
			);
		}
		case 'approvals.decide': {
			const input = yield* decode(ApprovalDecideInput, commandInput);
			const approvals = yield* Approvals.Service;
			return json(
				yield* approvals.decide(effectId, input.subject, input.state, input.decision, input.reason)
			);
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
			return json(
				yield* (yield* Sync.Service).snapshot(
					effectId,
					input.subject,
					input.collection,
					input.after,
					input.limit ?? 500
				)
			);
		}
		case 'sync.compact': {
			const input = yield* decode(SyncCompactInput, commandInput);
			return json(yield* (yield* Sync.Service).compact(effectId, input.retentionDays ?? 30));
		}
		case 'sync.schema':
			return json((yield* Sync.Service).schema());
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
			return json(
				yield* agents.turn(
					effectId,
					input.subject,
					input.agent,
					input.conversationId,
					input.message
				)
			);
		}
		case 'agents.title': {
			const input = yield* decode(AgentTitleInput, commandInput);
			const agents = yield* Agents.Service;
			return json({ title: yield* agents.title(effectId, input.conversationId) });
		}
		case 'agents.start': {
			const input = yield* decode(AgentStartInput, commandInput);
			yield* (yield* Agents.Service).start(
				effectId,
				input.subject,
				input.agent,
				input.conversationId
			);
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
			if (input.agent === undefined)
				return yield* new DispatchError({
					code: 'invalid_input',
					message: 'Agent name is required'
				});
			return json(yield* (yield* Agents.Service).listSkills(input.agent));
		}
		case 'agents.readSkill': {
			const input = yield* decode(SkillInput, commandInput);
			if (input.name === undefined)
				return yield* new DispatchError({
					code: 'invalid_input',
					message: 'Skill name is required'
				});
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
			const readable = definition.collections.filter(
				({ name }) => access.predicate(input.subject, 'read', name).allowed
			);
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
					...(collection.approvalLock === undefined
						? {}
						: { approvalLock: collection.approvalLock }),
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
					relations: definition.relations
						.filter((relation) => relation.source === collection.name)
						.map(({ name, target, cardinality }) => ({ name, target, cardinality }))
				})),
				apps: definition.apps.map(({ name, label }) => ({ name, label })),
				policies: definition.policies.map((policy) => ({
					name: policy.name,
					grants: policy.grants?.length ?? 0
				})),
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
				channels: definition.channels.map(
					({ name, agent, transport, audience, description, groupMessages }) => ({
						name,
						agent,
						transport,
						audience,
						description,
						...(groupMessages === undefined ? {} : { groupMessages })
					})
				),
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
			return json(
				(yield* (yield* Collections.Service).findFirst(
					effectId,
					input.subject,
					collectionQuery(input)
				)) ?? null
			);
		}
		case 'collections.count': {
			const input = yield* decode(CollectionFindInput, commandInput);
			return json({
				count: yield* (yield* Collections.Service).count(
					effectId,
					input.subject,
					collectionQuery(input)
				)
			});
		}
		case 'collections.history': {
			const input = yield* decode(CollectionRecordInput, commandInput);
			return json(
				yield* (yield* Collections.Service).history(
					effectId,
					input.subject,
					input.collection,
					input.id
				)
			);
		}
		/**
		 * A create over the wire, which is a batch of one and takes the batch's path.
		 *
		 * `mutate` rather than `create` for three things at once, none of which the old call could
		 * do. It assigns the id, so the browser stops minting one for a row that does not exist yet.
		 * It runs the graph through `flattenGraph`, so a body carrying a parent and its children
		 * commits as one transaction instead of being refused or silently flattened to the parent.
		 * And it returns the rows from the read-back it already performs, so the answer is what the
		 * database holds rather than what the caller submitted — which, once a default, a generated
		 * column and a `create.before` hook have run, are not the same record.
		 */
		case 'collections.create': {
			const input = yield* decode(CollectionCreateInput, commandInput);
			yield* checkWrittenGraph(input.collection, input.values);
			const collections = yield* Collections.Service;
			const written = yield* collections.mutate(effectId, input.subject, input.collection, [
				input.values
			]);
			const stored = written[0];
			if (stored === undefined)
				return yield* new DispatchError({
					code: 'write_not_stored',
					message: `A create on ${input.collection} completed without a stored record. Reporting success with no row is what made a client cache a record the database never held.`
				});
			const records = yield* maskStoredRecords(input.subject, input.collection, [stored]);
			// Read off the unmasked row: the id identifies what this caller just created, so it is
			// theirs to know even where a field policy would keep the column out of `records`.
			const assignedId = Reflect.get(stored, 'norbital_id');
			return json({
				created: true,
				norbital_id: typeof assignedId === 'string' ? assignedId : null,
				records
			});
		}
		case 'collections.createMany': {
			const input = yield* decode(CollectionCreateManyInput, commandInput);
			const records = input.records.map((record) => ({ ...record, subject: input.subject }));
			for (const record of records) yield* checkWrittenValues(record.collection, record.values);
			yield* (yield* Collections.Service).createMany(effectId, input.subject, records);
			return json({
				created: records.length,
				ids: records.map(({ id }) => id),
				norbital_ids: records.map(({ id }) => id)
			});
		}
		/**
		 * An update answers with the row too, for the same reason a create does.
		 *
		 * It costs one read that the old shape did not make, and it is not a read the caller was
		 * avoiding: a client that was handed back its own submission had to invalidate and refetch to
		 * find out what the row actually became, so this replaces a round trip rather than adding
		 * one. The read goes through `findFirst`, so it is filtered and masked exactly as the same
		 * caller's own query would be — no separate disclosure path.
		 */
		case 'collections.update': {
			const input = yield* decode(CollectionUpdateInput, commandInput);
			yield* checkWrittenValues(input.collection, input.values);
			const collections = yield* Collections.Service;
			yield* collections.update(effectId, input.subject, input);
			const stored = yield* collections.findFirst(effectId, input.subject, {
				collection: input.collection,
				where: { norbital_id: { in: [input.id] } }
			});
			return json({
				updated: true,
				id: input.id,
				records: stored === undefined ? [] : [stored]
			});
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
			return json({
				imported: yield* (yield* Collections.Service).import(effectId, input.subject, records)
			});
		}
		case 'collections.export': {
			const input = yield* decode(CollectionFindInput, commandInput);
			return json(
				yield* (yield* Collections.Service).export(effectId, input.subject, collectionQuery(input))
			);
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
					...plan.steps
						.filter(({ id }) => id.startsWith('bolt:'))
						.map(({ id, sql }) => ({ id, sql })),
					...[...(workspace.definition.migrations ?? [])]
						.toSorted((left, right) => left.tag.localeCompare(right.tag))
						.flatMap((entry) =>
							entry.statements.map((sql, index) => ({ id: `lineage:${entry.tag}:${index}`, sql }))
						),
					...plan.steps
						.filter(({ id }) => !id.startsWith('bolt:'))
						.map(({ id, sql }) => ({ id, sql }))
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
			return json({
				fingerprint: plan.fingerprint,
				steps: plan.steps.map(({ id, sql }) => ({ id, sql }))
			});
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
			return json({
				taskId: yield* automations.start(effectId, input.subject, input.name, input.input)
			});
		}
		case 'automations.register': {
			const input = yield* decode(NamedInput, commandInput);
			yield* (yield* Automations.Service).register(input.name);
			return json({ registered: true });
		}
		case 'automations.runStep': {
			const input = yield* decode(AutomationStartInput, commandInput);
			return json({
				taskId: yield* (yield* Automations.Service).runStep(
					effectId,
					input.subject,
					input.name,
					input.input
				)
			});
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
			return json(yield* channels.receive(effectId, input.channel, input.delivery));
		}
		case 'channels.register': {
			const input = yield* decode(ChannelNameInput, commandInput);
			yield* (yield* Channels.Service).register(effectId, input.channel);
			return json({ registered: true });
		}
		case 'channels.reply': {
			const input = yield* decode(ChannelReplyInput, commandInput);
			yield* (yield* Channels.Service).reply(
				effectId,
				input.channel,
				input.recipient,
				input.payload
			);
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
			if (command === 'integrations.install') {
				yield* integrations.install(effectId, input.name);
				return json({ installed: true });
			}
			if (command === 'integrations.reconcile') {
				yield* integrations.reconcile(effectId, input.name);
				return json({ reconciled: true });
			}
			if (command === 'integrations.disable') {
				yield* integrations.disable(effectId, input.name);
				return json({ disabled: true });
			}
			return json(yield* integrations.status(effectId, input.name));
		}
		case 'integrations.receive': {
			const input = yield* decode(IntegrationReceiveInput, commandInput);
			// Deliberately *not* added to `ENQUEUED_COMMANDS`: a webhook is not something the runtime
			// posts to itself, so it stays a `Command` and the host relaying it must present its own
			// credential. That is one of the two independent checks a delivery passes — the host proves it
			// is the host, and the HMAC proves the source is the source. Listing it as enqueued would drop
			// the first of those and re-open a credential-free route into a collection write.
			return json(
				yield* (yield* Integrations.Service).receive(effectId, input.name, input.binding, {
					headers: input.headers,
					body: input.body
				})
			);
		}
		case 'integrations.flush': {
			const input = yield* decode(IntegrationFlushInput, commandInput);
			return json(
				yield* (yield* Integrations.Service).flush(effectId, input.name, input.input ?? null)
			);
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
			return json(
				yield* (yield* Notifications.Service).list(effectId, input.recipient, input.unreadOnly)
			);
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
					const ops = makeBoundAuthoringOps(
						effectId,
						input.bolt_run_as,
						collections,
						ai,
						files,
						yield* Automations.Service
					);
					const api = makeAuthoringApi(ops);
					const output = yield* runAuthoredHandler(() =>
						automation.handler(api, { args: input.args, scope: input.scope ?? {} })
					);
					return json(output as Schema.Json);
				}
			}
			return yield* new DispatchError({
				code: 'unknown_command',
				message: `Unknown Bolt command: ${command}`
			});
	}
});
