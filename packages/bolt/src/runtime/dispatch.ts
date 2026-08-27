import { Clock, Effect, Number as ENumber, Result, Schema } from 'effect';
import {
	CollectionMutateRequest,
	CollectionGroupedQueryRequestFields,
	CollectionQueryRequestFields,
	type CollectionMutationBaseVersion,
	type CollectionMutationGraph,
	EffectId,
	makeWireError,
	PluginTrustedContext,
	StoredRecord,
	type DispatchResponse,
	type Invocation
} from '@norbital-ai/bolt-protocol';
import * as AccessControl from '#lib/runtime/access/access-control.js';
import { AuthoredRefusal, refusalOf } from '#lib/authoring/refusal.js';
import { WEB_AGENT_NAME, type WorkspaceDefinition } from '#lib/authoring/workspace-schema.js';
import { AutomationProgression } from '#lib/authoring/automations-schema.js';
import {
	reconcileMutationSchema,
	replicaProvisioningSteps
} from '#lib/compiler/schema-plan.js';
import * as SystemPrincipal from '#lib/runtime/access/system-principal.js';
import * as Agents from '#lib/runtime/agents/agents.js';
import { ChatDocumentRef } from '#lib/runtime/agents/chat-messages.js';
import {
	AI,
	Files,
	type AIInterface,
	type FilesInterface
} from '#lib/runtime/facilities/services.js';
import * as Approvals from '#lib/runtime/approvals/approvals.js';
import { ApprovalState } from '#lib/runtime/approvals/approvals.js';
import * as Automations from '#lib/runtime/automations/automations.js';
import * as Envoys from '#lib/runtime/envoys/envoys.js';
import { EnvoyDelivery } from '#lib/runtime/envoys/envoys.js';
import {
	automationPrincipalId,
	envoyPrincipalId,
	SEED_PRINCIPAL_ID
} from '#lib/runtime/identity/static-identity.js';
import * as Collections from '#lib/runtime/collections/collections.js';
import { resolveWritableManyRelation } from '#lib/runtime/collections/collections.js';
import {
	canonicalizeCollectionQuery,
	normalizeCollectionHydration,
	projectCollectionQueryRecord,
	withoutCollectionQueryProjection,
	workspaceCollectionQueryMetadata
} from '#lib/runtime/collections/canonical-query.js';
import { compileOrderTerms, makeWhereContext } from '#lib/runtime/collections/where.js';
import * as Integrations from '#lib/runtime/integrations/integrations.js';
import * as Identity from '#lib/runtime/identity/identity.js';
import { ADMIN_STATUS, Subject } from '#lib/runtime/identity/identity.js';
import * as Notifications from '#lib/runtime/notifications/notifications.js';
import { Notification } from '#lib/runtime/notifications/notifications.js';
import { RemoteRegistry, type RuntimeRemoteRegistry } from '#lib/runtime/remotes.js';
import * as WorkspaceSchema from '#lib/runtime/schema/workspace-schema.js';
import { SYSTEM_COLLECTION_NAMES } from '#lib/runtime/schema/system-collections.js';
import { Secrets, type Interface as SecretsInterface } from '#lib/runtime/secrets/secrets.js';
import {
	PersonalSecrets,
	type Interface as PersonalSecretsInterface
} from '#lib/runtime/secrets/personal-secrets.js';
import {
	describeGeneratedColumnWrite,
	describeInvalidCustomValue
} from '#lib/runtime/collections/custom-values.js';
import * as SyncCompaction from '#lib/runtime/sync/compaction.js';
import * as Sync from '#lib/runtime/sync/sync.js';
import { SyncCursor } from '#lib/runtime/sync/sync.js';
import * as TenantScope from '#lib/runtime/tenant.js';
import {
	AuthoredRuntimeService,
	guardAuthoringOps,
	makeAutomationApi,
	makeAuthoringApi,
	makeBoundAuthoringOps,
	runAuthoredHandler,
	type AuthoredRuntime
} from '#lib/runtime/collections/authored.js';
import * as Workspace from '#lib/runtime/workspace.js';
import { SYSTEM_COLUMN_NAMES } from '#lib/authoring/system-row-model.js';
import { describeCause, DispatchError } from '#lib/runtime/workspace.js';
import * as RateLimits from '#lib/runtime/rate-limits.js';
import * as TaskQueue from '#lib/runtime/tasks/tasks.js';

export { DispatchError } from '#lib/runtime/workspace.js';

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
	decision: Schema.Literals(['approve', 'reject', 'request_changes', 'supersede']),
	reason: Schema.optionalKey(Schema.String)
});
/**
 * The authenticated wire shape for a partition-oriented pull.
 *
 * The exported request schema deliberately has no subject: callers cannot choose authority. This
 * boundary adds the subject minted from the credential before decoding and invoking the service.
 */
const SyncPullInput = Schema.Struct({
	subject: Subject,
	actor: Subject,
	impersonatedTeam: Schema.NullOr(Schema.String),
	...Sync.SyncPullRequest.fields
});
/** The host signature mints the outer system subject; each opaque credential is resolved in-guest. */
const SyncDistributeInput = Schema.Struct({
	subject: Subject,
	...Sync.SyncDistributeRequest.fields
});

/**
 * The commit observer one transport turn reports through.
 *
 * The turn renders its own note from the parts it committed; all this adds is the envoy hop —
 * post or rewrite the conversation's one bubble, best effort, answering the key to rewrite next.
 * A conversation that is not a transport one (the web agent's) has nothing in flight to post on
 * and answers `null`, which the turn treats as nobody watching.
 */
/** How many tool steps one turn note shows; the rest collapse into a count. */
const progressVisibleLines = 3;

/**
 * How long one note must rest before it is rewritten, and how long rewrites are tried at all.
 *
 * The interval coalesces a burst of quick tools into a few honest updates instead of a flickering
 * bubble; the window is WhatsApp's own edit horizon with margin, past which a rewrite is refused
 * by the provider and a replacement message would be exactly the noise in-place updates exist
 * to avoid.
 */
const PROGRESS_EDIT_INTERVAL_MS = 3_500;
const PROGRESS_WINDOW_MS = 13 * 60_000;

/**
 * The compact body of one turn note, read straight off the turn's own parts.
 *
 * The parts a turn commits are the only record of its tool steps — a note invents none. A part
 * with a matching result is done and carries a check; one still waiting carries a gear; everything
 * older than the newest few collapses into a count, because a turn that ran six tools does not
 * narrate six lines into somebody's chat.
 */
const renderProgress = (parts: ReadonlyArray<Agents.TurnPart>): string => {
	const done = new Set(parts.flatMap((part) => (part.kind === 'tool-result' ? [part.id] : [])));
	const steps = parts.flatMap((part) =>
		part.kind === 'tool' ? [{ name: part.name, state: done.has(part.id) }] : []
	);
	const shown = steps
		.slice(-progressVisibleLines)
		.map(({ name, state }) => `${state ? '✓' : '⚙︎'} ${name}`);
	const elided =
		steps.length > progressVisibleLines ? [`… ${steps.length - progressVisibleLines} earlier`] : [];
	return ['⚙︎ Working', ...elided, ...shown].join('\n');
};

/**
 * Builds the transport surface one turn reflects into — the envoy hop, paced and keyed here so
 * the agent service knows nothing of WhatsApp. The surface owns the bubble's provider key: the
 * first beat sends it, later beats rewrite it, and `currentKey` names it for the completion, which
 * replaces the bubble with the answer. A conversation that is not a transport one (the web
 * agent's) is learned on the first beat, and the surface goes quiet rather than visiting the
 * runtime on every commit after that.
 */
const observeProgress = (
	effectId: EffectId,
	conversationId: string,
	envoys: Envoys.Interface
): Agents.TurnSurface => {
	let beat = 0;
	let key: string | null = null;
	let lastEditAt = 0;
	const startedAt = Date.now();
	let quiet = false;
	return {
		currentKey: () => key,
		observe: (parts) =>
			Effect.suspend(() => {
				if (quiet) return Effect.void;
				const now = Date.now();
				if (now - startedAt > PROGRESS_WINDOW_MS) {
					quiet = true;
					return Effect.void;
				}
				if (key !== null && now - lastEditAt < PROGRESS_EDIT_INTERVAL_MS) return Effect.void;
				lastEditAt = now;
				return Effect.catch(
					Effect.map(
						envoys.progress(
							EffectId.make(`${effectId}:progress:${(beat += 1)}`),
							conversationId,
							renderProgress(parts),
							key
						),
						(next) => {
							if (next !== null) {
								key = next;
							} else if (key !== null) {
								// The bubble was lost between beats — the transport dropped it or the
								// session moved on. The next beat sends a fresh note instead of a ghost.
								key = null;
							} else {
								quiet = true;
							}
						}
					),
					() => Effect.void
				);
			})
	};
};

const AgentEnqueueInput = Schema.Struct({
	subject: Subject,
	agent: Schema.NonEmptyString,
	conversationId: Schema.NonEmptyString,
	turnId: Schema.NonEmptyString,
	message: Schema.String
});
const AgentExecuteInput = Schema.Struct({
	conversationId: Schema.NonEmptyString,
	turnId: Schema.NonEmptyString
});
const AgentDocumentBindInput = Schema.Struct({
	subject: Subject,
	conversationId: Schema.NonEmptyString,
	file: ChatDocumentRef
});
const AgentDocumentInput = Schema.Struct({
	subject: Subject,
	conversationId: Schema.NonEmptyString,
	storageKey: Schema.NonEmptyString
});
const AgentTitleInput = Schema.Struct({ conversationId: Schema.NonEmptyString });
const CollectionFindInput = Schema.Struct({
	subject: Subject,
	...CollectionQueryRequestFields
});
const CollectionGroupedInput = Schema.Struct({
	subject: Subject,
	...CollectionGroupedQueryRequestFields
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
const JsonObject = Schema.Record(Schema.String, Schema.Json);
const DataBrowserInput = Schema.Struct({
	collection: Schema.NonEmptyString,
	input: Schema.optionalKey(Schema.Struct({ limit: Schema.optionalKey(Schema.Number) }))
});
const RateLimitAddressInput = Schema.Struct({
	address: Schema.optionalKey(Schema.String),
	email: Schema.optionalKey(Schema.String)
});
const decodeJsonObject = Schema.decodeUnknownResult(JsonObject);
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
/** The protocol mutation body plus the subject minted from the authenticated credential. */
const AuthenticatedCollectionMutation = Schema.Struct({
	subject: Subject,
	actor: Subject,
	impersonatedTeam: Schema.NullOr(Schema.String)
});
const AuthenticatedSyncPartitionStatus = Schema.Struct({
	...AuthenticatedCollectionMutation.fields,
	...Sync.SyncPartitionStatusRequest.fields
});
const CollectionMutation = Schema.Struct({
	collection: Schema.NonEmptyString,
	id: Schema.NonEmptyString,
	values: Schema.Record(Schema.String, Schema.Json)
});
const CollectionImportInput = Schema.Struct({
	subject: Subject,
	records: Schema.Array(CollectionMutation)
});
/**
 * What a caller may say when starting an automation: which one, and what to hand it.
 *
 * No `subject`, and its absence is the point. It used to carry one — so the automation ran with
 * whatever authority the caller held, and an administrator tripping a nightly close ran it as an
 * administrator. An automation's authority is the policies its own declaration names, minted at the
 * enqueue point by `Automations.start`.
 */
const AutomationStartInput = Schema.Struct({
	name: Schema.NonEmptyString,
	input: Schema.Json
});
/** A lifecycle action names both the declared automation and one of its durable task ids. */
const AutomationLifecycleInput = Schema.Struct({
	name: Schema.NonEmptyString,
	taskId: Schema.NonEmptyString
});
/**
 * What a host may say about a message it took off a transport.
 *
 * `subject` is gone from this input and its absence is the point. It was a `Subject` the caller
 * supplied, which made the identity of an envoy turn something outside the runtime decided — and on
 * a `Command` the boundary overwrites `subject` from the credential anyway, so a host relaying a
 * WhatsApp message could only ever have run the turn as *itself*, an administrator. `Envoys.receive`
 * mints the subject from the release's own declarations now; the host supplies the wire's facts and
 * nothing about authority.
 */
const EnvoyReceiveInput = Schema.Struct({
	envoy: Schema.NonEmptyString,
	delivery: EnvoyDelivery
});
const EnvoyDrainInput = Schema.Struct({
	envoy: Schema.NonEmptyString,
	conversationId: Schema.NonEmptyString
});
const EnvoyCompleteInput = Schema.Struct({
	envoy: Schema.NonEmptyString,
	conversationId: Schema.NonEmptyString,
	output: Schema.Json,
	progressKey: Schema.optionalKey(Schema.NullOr(Schema.NonEmptyString))
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
	// An authored input is any schema, not only a struct. The queue preserves the decoded JSON value
	// whole and the automation's own schema narrows it immediately before the handler runs.
	args: Schema.Json,
	scope: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
	bolt_run_as: Subject,
	/** Injected by the trusted task runner, never accepted from the enqueue payload. */
	bolt_task_id: Schema.NonEmptyString
});
const AgentOpenInput = Schema.Struct({
	subject: Subject,
	agent: Schema.NonEmptyString,
	conversationId: Schema.NonEmptyString
});
const AgentContinueInput = Schema.Struct({
	conversationId: Schema.NonEmptyString,
	agentId: Schema.NonEmptyString,
	taskId: Schema.NonEmptyString
});
const AgentLaneInput = Schema.Struct({ subject: Subject, conversationId: Schema.NonEmptyString });
const AgentDequeueInput = Schema.Struct({
	subject: Subject,
	conversationId: Schema.NonEmptyString,
	taskId: Schema.NonEmptyString
});
const AgentReorderInput = Schema.Struct({
	subject: Subject,
	conversationId: Schema.NonEmptyString,
	taskIds: Schema.Array(Schema.NonEmptyString)
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
/**
 * Which skill, and for whom.
 *
 * `agent` is gone. A skill is capability, granted by a policy, so the answer to "which skills are
 * available" depends on the subject asking and not on which agent they are talking to — two people
 * on the same web agent are offered different skills, and an agent name could not express that.
 */
const SkillInput = Schema.Struct({
	subject: Subject,
	name: Schema.optionalKey(Schema.NonEmptyString)
});
const ApprovalStatusInput = Schema.Struct({
	subject: Subject,
	requestId: Schema.NonEmptyString
});
const ApprovalRequestIdInput = Schema.Struct({ requestId: Schema.NonEmptyString });
const ApprovalWithdrawInput = Schema.Struct({ subject: Subject, state: ApprovalState });
const SyncShapeInput = Schema.Struct({ subject: Subject });
/**
 * A `subject` on a command that acts on no subject's data, and that is exactly why it is here.
 *
 * Compaction deletes history for the whole workspace. It is gated by `SYSTEM_ONLY_COMMANDS`, and
 * that gate reads `subject.system` — so the field is what the check has to look at, minted by the
 * boundary from a verified gateway signature and refused when a payload claims it.
 */
const SyncCompactInput = Schema.Struct({
	subject: Subject,
	retentionDays: Schema.optional(Schema.Number)
});
const EnvoyNameInput = Schema.Struct({ envoy: Schema.NonEmptyString });
const EnvoyReplyInput = Schema.Struct({
	envoy: Schema.NonEmptyString,
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
const IdentityContinueSessionInput = Schema.Struct({
	email: Schema.NonEmptyString,
	tenantId: Schema.NonEmptyString,
	subject: Subject
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
	/**
	 * Projects one record to the JSON a wire shape accepts.
	 *
	 * A Json boundary has no `undefined` — a key the caller left absent is a key that does not exist.
	 * Collecting the optional fields first and dropping their absent values here keeps the wire shape
	 * honest instead of rebuilding it field-by-field at every caller.
	 */
	jsonObject: (
		entry: Readonly<Record<string, Schema.Json | undefined>>
	): Readonly<Record<string, Schema.Json>> => {
		const value: Record<string, Schema.Json> = {};
		for (const [key, field] of Object.entries(entry)) {
			if (field !== undefined) value[key] = field;
		}
		return value;
	},
	// The page ceiling belongs to this boundary, not the collections service: a client asks for a
	// page, while an authored server-side handler asks for the exact rows its computation needs.
	collectionQuery: (input: typeof CollectionFindInput.Type) => ({
		collection: input.collection,
		limit: ENumber.clamp({ minimum: 1, maximum: 500 })(input.limit ?? 100),
		...(input.where === undefined ? {} : { where: input.where }),
		...(input.userFilter === undefined ? {} : { userFilter: input.userFilter }),
		...(input.orderBy === undefined ? {} : { orderBy: input.orderBy }),
		...(input.with === undefined ? {} : { with: input.with }),
		...(input.search === undefined ? {} : { search: input.search }),
		...(input.after === undefined ? {} : { after: input.after })
		// Root `columns` is a read-time projection and therefore is not part of the service query.
		// Nested projections remain authored here; the authoritative page path removes them only from
		// its hydration read so the base store never receives a partial related row.
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
	const writtenSystemField = Object.keys(values).find(
		(name) => name !== 'id' && SYSTEM_COLUMN_NAMES.includes(name)
	);
	const invalid =
		(writtenSystemField === undefined
			? undefined
			: `${collection}.${writtenSystemField} is managed by Bolt and cannot be written.`) ??
		describeGeneratedColumnWrite(definition.fields, values) ??
		describeInvalidCustomValue(definition.fields, values, workspace.definition.customTypes);
	if (invalid !== undefined)
		yield* Effect.fail(new DispatchError({ code: 'invalid_input', message: invalid }));
});

/**
 * How far the boundary follows a mutation graph down.
 *
 * The same bound the runtime's `flattenGraph` applies, and stated here for the same reason: the
 * relation set has cycles in it, so a body that closes one would be walked until the isolate died.
 * The two numbers are independent copies of one decision, which is tolerable only because exceeding
 * either one is a refusal rather than a difference in what gets written — this walk validates and
 * the runtime's walk is what actually refuses.
 */
const GRAPH_CHECK_DEPTH = 5;

/** Child rows named in writable `many` relationship keys, followed to their own collections. */
const writtenGraphChildren = (
	collection: string,
	values: Readonly<Record<string, Schema.Json>>,
	definition: WorkspaceDefinition
): ReadonlyArray<{
	readonly collection: string;
	readonly values: Readonly<Record<string, Schema.Json>>;
}> => {
	const children: Array<{
		readonly collection: string;
		readonly values: Readonly<Record<string, Schema.Json>>;
	}> = [];
	for (const [key, value] of Object.entries(values)) {
		const childRows = Schema.decodeUnknownResult(Schema.Array(JsonObject))(value);
		if (Result.isFailure(childRows)) continue;
		const relation = resolveWritableManyRelation(definition, collection, key);
		if (relation === undefined) continue;
		for (const child of childRows.success) {
			children.push({
				collection: relation.childCollection,
				values: child
			});
		}
	}
	return children;
};

/**
 * The same check, down every branch of a mutation graph.
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
		const id = node.values['id'];
		if (id !== undefined && (typeof id !== 'string' || id.length === 0))
			yield* Effect.fail(
				new DispatchError({
					code: 'invalid_input',
					message: `The id of a ${node.collection} mutation must be a non-empty string.`
				})
			);
		if (typeof id === 'string' && !MUTATION_RECORD_ID.test(id))
			yield* Effect.fail(
				new DispatchError({
					code: 'invalid_input',
					message: `The id of a ${node.collection} mutation must be a UUID.`
				})
			);
		const collectionDefinition = yield* workspace.collection(node.collection);
		const unknown = Object.keys(node.values).find(
			(key) =>
				key !== 'id' &&
				!SYSTEM_COLUMN_NAMES.includes(key) &&
				!(key in collectionDefinition.fields) &&
				resolveWritableManyRelation(workspace.definition, node.collection, key) === undefined
		);
		if (unknown !== undefined)
			yield* Effect.fail(
				new DispatchError({
					code: 'invalid_input',
					message: `${node.collection} has no writable field or many relationship named "${unknown}".`
				})
			);
		yield* checkWrittenValues(node.collection, node.values);
		if (node.depth >= GRAPH_CHECK_DEPTH) continue;
		pending.push(
			...writtenGraphChildren(node.collection, node.values, workspace.definition).map((child) => ({
				...child,
				depth: node.depth + 1
			}))
		);
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
 * administrator of the workspace. That status permits membership administration and team preview;
 * it still must never grant tenant collections or apps. The command was reachable from a browser: Colony proxies
 * `/api/bolt/command/<name>` and bolt-server serves `/_bolt/command/<name>`, and neither restricts
 * which name.
 *
 * Gated on `manage`/`identity` rather than on `isAdministrator` directly, so that provisioning has a
 * way in that is not "be an administrator": `colony system` enumerates exactly this grant, which is
 * how a host admits the first founder into a workspace that has none. Administrators match an
 * explicit built-in policy selected by their status; everybody else is refused unless the workspace
 * deliberately authored a policy over the `identity` resource — the same vocabulary, and the same
 * author's choice, that `secrets` and `schema` already have.
 *
 * A map rather than a prefix test, because `identity.` is mostly sign-in and session traffic that
 * must stay reachable. It is checked in one place before the switch, so a second membership-writing
 * command is gated by adding a line here rather than by remembering to write a check inside a case.
 */
const IDENTITY_RESOURCE = 'identity';
/**
 * The `teams.*` commands join it, and they are membership writes in exactly the same sense.
 *
 * Administration is a status on the person — `user.status` — and `decide` short-circuits
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
	'identity.continueSession',
	/**
	 * The inbound envoy port, which would otherwise be the widest hole in this runtime.
	 *
	 * `envoys.receive` decodes no `Subject` — it mints one from the envoy's declared policies — and
	 * that is exactly what makes this entry necessary. A command that names no identity is a command
	 * the credential path admits without one, so without this line anybody who could reach the port
	 * could post a JSON body and make a workspace's agent run a turn, under that envoy's authority,
	 * against that workspace's data. The sender address in the payload is attacker-chosen, so they
	 * could also choose *whose* assignments the turn narrowed to.
	 *
	 * Gating it on the gateway signature is the honest expression of what an envoy message is: proof
	 * that a message came from WhatsApp requires WhatsApp's credential, which the tenant does not
	 * hold, so the host authenticates the wire and says so with a signature over the timestamp, the
	 * command, the tenant and the arguments. Nothing else can assert that a message arrived.
	 */
	'envoys.receive',
	/**
	 * Compaction, which is destructive to everybody in the workspace at once.
	 *
	 * It used to sit behind no gate at all — neither table named it, and its input decoded no
	 * `subject` — so it was reachable by any credential this boundary accepted. What that buys is not a
	 * read: `sync.compact` deletes the outbox past the retention window and moves the horizon mark over
	 * what it removed, so one call strands every replica in the workspace behind a full rebuild, and a
	 * call naming a short window strands them behind a larger one.
	 *
	 * No policy would express this correctly either. Retention is a property of the deployment rather
	 * than of the workspace's own authority model, and the host is the only party that knows when it is
	 * safe to run — after a seed, or on the maintenance tick, which now carries a bounded pass of the
	 * same work without coming through this boundary at all.
	 */
	'sync.compact',
	/** One host-authenticated admission fans many independently authenticated pulls into one read. */
	'sync.distribute'
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
		reason: `${command} is reachable only by the host proving itself per invocation; an administrator's own authority is not enough`
	});
});

/**
 * A team on the wire, with nulls where the row has none.
 *
 * Spelled out rather than spread, so a column added to `team` cannot reach a client by
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
 * machinery, `agents.continue` resumes a parent parked on a child, and `agents.execute` runs one
 * already-persisted mailbox item, while
 * `collections.resume` takes `{ requestId }` and derives its authority from the stored approval:
 * `Collections.resume` refuses a request that is not `Approved` and replays the write under the
 * subject recorded when the original create was authenticated.
 *
 * `automations.<name>` is resolved against the declared automations rather than matched on the
 * prefix, because `automations.start`, `.register`, `.runStep`, `.resume` and `.stop`
 * share it and are host commands rather than enqueued ones.
 */
/** The one command a host's timer sends, named once so the gate and the router cannot disagree. */
const TICK_COMMAND = 'tasks.tick';

const ENQUEUED_COMMANDS: ReadonlySet<string> = new Set([
	'integrations.pull',
	'integrations.flush',
	'envoys.drain',
	'envoys.complete',
	// A delegated turn. `sandbox-tools.ts` has enqueued this since delegation was written, and it was
	// never listed here — harmless only for as long as nothing executed the queue. The first tick
	// would have refused every subagent, and the refusal would have named the provenance gate rather
	// than the missing entry.
	'agents.execute',
	'agents.continue',
	'collections.resume',
	'collections.discard',
	// Better Auth persists a sign-in challenge, then posts this private courier task. It carries no
	// caller identity and can only deliver the exact code/address pair the runtime stored in the row.
	Identity.DELIVER_CODE_COMMAND,
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
 * `automations.*`, `integrations.install`/`disable`/`receive`, `envoys.register`/`reply`,
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
 * prefix, because `automations.start`, `.register`, `.runStep`, `.stop` and `.resume` share it and
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
	'impersonatedTeam',
	/**
	 * The policies a subject holds directly, which only a *declaration* may name.
	 *
	 * It is here for the same reason `system` is refused on `Subject` itself: a static identity's
	 * authority is the policies its declaration named, and if a payload could carry the field then the
	 * answer to "what can a stranger do to my database?" would stop being "read the envoy declaration"
	 * and start being "whatever they typed". There is no row that produces one either, so a subject
	 * holding policies directly is one this runtime minted and nothing else.
	 */
	'policies'
] as const;

/**
 * Answers one keyset page: the rows, and the cursor its successor should carry.
 *
 * It lives at the boundary that owns the page ceiling, so `findMany` keeps returning plain rows for
 * the callers that want exactly the rows they asked for — `export` reads a whole collection through
 * it, and an authored handler asks for a page without wanting a cursor back.
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
	const described = canonicalizeCollectionQuery(
		'findMany',
		input,
		workspaceCollectionQueryMetadata(workspace.definition),
		{ pinnedCollation: true, localRelationships: true, localSearch: true }
	);
	if (described === undefined) {
		return yield* new DispatchError({
			code: 'invalid_input',
			message: 'Collection query could not be canonicalized'
		});
	}
	/**
	 * The proof position is sampled before the page query, never after it.
	 *
	 * A row committed after this head may be present in the page, but it will also be replayed by the
	 * later pull and applied idempotently. The reverse ordering is unsafe: a post-read head could name
	 * a commit the page did not observe and let CoverageLedger claim a page current past an unseen row.
	 * The suffix is distinct because database facilities deduplicate by effect id.
	 */
	const position = yield* (yield* Sync.Service).positions(
		EffectId.make(`${effectId}:page-position`),
		input.subject,
		described.dependencies
	);
	// One visible page of lookahead keeps a mutated boundary filled without unbounded hydration.
	const retainedLimit = query.limit * 2;
	const rows = yield* collections.findMany(effectId, input.subject, {
		...query,
		...(input.with === undefined
			? {}
			: { with: withoutCollectionQueryProjection(input.with) }),
		limit: retainedLimit + 1
	});
	const retained = rows.slice(0, retainedLimit);
	const hydration = normalizeCollectionHydration(
		workspace.definition,
		input.collection,
		retained
	);
	if (Result.isFailure(hydration)) {
		return yield* new DispatchError({
			code: 'invalid_stored_record',
			message: hydration.failure.message
		});
	}
	const visible = retained.slice(0, query.limit);
	const visibleLast = visible[visible.length - 1];
	const last = retained[retained.length - 1];
	// Compiled the same way the seek predicate was, so the tuple the cursor carries is the tuple the
	// next page's seek compares against — including the primary key `compileOrderTerms` appends.
	const ordering = compileOrderTerms(
		input.orderBy,
		makeWhereContext(input.collection, definition.fields, workspace.definition)
	);
	return json({
		rows: retained,
		baseRows: hydration.success.baseRows,
		relationshipRefs: hydration.success.relationshipRefs,
		pageCursor:
			rows.length > query.limit && visibleLast !== undefined
				? Collections.encodeCollectionCursor(ordering, visibleLast)
				: null,
		nextCursor:
			rows.length > retainedLimit && last !== undefined
				? Collections.encodeCollectionCursor(ordering, last)
				: null,
		lookahead: Math.max(0, retained.length - query.limit),
		readCursor: position.cursor,
		partitionKey: position.partition.key,
		confirmedDependencies: Object.keys(position.generations).toSorted(),
		dependencyGenerations: position.generations,
		reproducibility: described.reproducibility
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

type DispatchServices =
	| AccessControl.Interface
	| Agents.Interface
	| AIInterface
	| Approvals.Interface
	| AuthoredRuntime
	| Automations.Interface
	| Collections.Interface
	| Envoys.Interface
	| FilesInterface
	| Identity.Interface
	| Integrations.Interface
	| Notifications.Interface
	| PersonalSecretsInterface
	| RateLimits.Interface
	| RuntimeRemoteRegistry
	| SecretsInterface
	| Sync.Interface
	| TaskQueue.Interface
	| TenantScope.Interface
	| Workspace.Interface
	| WorkspaceSchema.Interface;

export const dispatchInvocation: (
	invocation: Invocation
) => Effect.Effect<DispatchResponse, unknown, DispatchServices> = Effect.fn('Bolt.dispatch')(
	function* (invocation: Invocation) {
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
		if (
			invocation._tag !== 'Command' &&
			invocation._tag !== 'Plugin' &&
			invocation._tag !== 'Task'
		) {
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
			const context = yield* Schema.decodeUnknownEffect(PluginTrustedContext)(
				invocation.trustedContext
			);
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
			const limit = input.input?.limit;
			// The *effective* subject, which on an impersonated query is the target and not the actor.
			// A facility is being told who this read is on behalf of, and the whole content of an
			// impersonated read is that it is on behalf of somebody else — an operator opening a member's
			// rows must see that member's per-user state, not their own. The actor is not lost: the subject
			// `impersonate` returns carries `impersonatedBy`, and the audit row it writes names them.
			return json(
				yield* Effect.provideService(
					collections.findMany(effectId, subject, {
						collection: input.collection,
						limit
					}),
					Identity.CurrentSubject,
					subject
				)
			);
		}
		const authenticated = yield* Effect.gen(function* () {
			const fields = Result.getOrElse(decodeJsonObject(invocation.input), () => ({}));
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
			 * `user` to be an administrator in and no `session` to authenticate
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
			 * `user` row and a `session` row straight into the tenant database over
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
					now: yield* Clock.currentTimeMillis
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
				team === undefined
					? actor
					: yield* (yield* AccessControl.Service).subjectAsTeam(actor, team);
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
		yield* (yield* RateLimits.Service).admit(
			invocation.command,
			{
				tenantId: String(invocation.scope.tenantId),
				userId: authenticated.subject?.userId,
				...(rateLimitAddress(invocation.input) === undefined
					? {}
					: { address: rateLimitAddress(invocation.input) as string })
			},
			// The holder's own budget, resolved from the policies they hold. It is passed in rather than
			// looked up inside the limiter for the reason the limiter states: it counts, and something
			// that already knows who holds what decides which rule to count against.
			authenticated.subject === undefined
				? undefined
				: (yield* AccessControl.Service).limits(authenticated.subject)
		);
		const invoked =
			invocation.command === TICK_COMMAND
				? runTick(effectId)
				: runCommand(invocation.command, effectId, authenticated.input);
		return yield* authenticated.subject === undefined
			? invoked
			: Effect.provideService(invoked, Identity.CurrentSubject, authenticated.subject);
	}
);

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
			Effect.andThen(() =>
				runCommand(
					task.command,
					EffectId.make(attemptEffectId),
					task.command.startsWith('automations.') &&
						typeof task.input === 'object' &&
						task.input !== null &&
						!Array.isArray(task.input)
						? { ...task.input, bolt_task_id: task.effectId }
						: task.input
				)
			),
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
								error: `status ${response.status}`,
								retryable:
									response.status >= 500 ||
									response.status === 408 ||
									response.status === 409 ||
									response.status === 425 ||
									response.status === 429
							} as const),
				onFailure: (cause) => {
					const error = Collections.unwrapMutationPhase(cause);
					// An approval gate is a successful submission, not a broken automation attempt. The
					// mutation graph is now durable in the approval inbox and its settlement is owned by
					// `collections.resume`; retrying this task would only submit the same review again.
					if (error instanceof Collections.PendingApproval)
						return {
							_tag: 'Done',
							task,
							result: {
								status: 'awaiting_approval',
								pending: true,
								requestId: error.requestId,
								collection: error.collection,
								id: error.id,
								action: error.action
							}
						} as const;
					return {
						_tag: 'Failed',
						task,
						error: describeCause(cause),
						retryable:
							error === null ||
							typeof error !== 'object' ||
							Reflect.get(error, 'retryable') !== false
					} as const;
				}
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
	const decoded = Schema.decodeUnknownResult(RateLimitAddressInput)(payload);
	if (Result.isFailure(decoded)) return undefined;
	const value = decoded.success.address ?? decoded.success.email;
	return value === undefined || value.trim() === '' ? undefined : value;
};

/** Canonical JSON for a request digest; object insertion order must not change mutation identity. */
const canonicalJson = (value: Schema.Json): string => {
	if (value === null || typeof value !== 'object') return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
	return `{${Object.entries(value)
		.toSorted(([left], [right]) => left.localeCompare(right))
		.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
		.join(',')}}`;
};

/** Uses WebCrypto because bundle code runs in isolates and must not import `node:crypto`. */
const sha256Hex = Effect.fn('Bolt.sha256Hex')((value: string) =>
	Effect.promise(async () => {
		const digest = await globalThis.crypto.subtle.digest(
			'SHA-256',
			new TextEncoder().encode(value)
		);
		return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
	})
);

const MUTATION_RECORD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

/**
 * The stable actor/effective-subject binding for dedup and delivery.
 *
 * Team paths, administrator flags and compiled authority generations intentionally stay out. A
 * journaled mutation is retried under current policy after those facts change, but it must still
 * resolve the original ledger row rather than acquiring a second idempotency scope.
 */
const browserMutationScopeFor = (
	tenantId: string,
	environment: string,
	actor: Subject,
	subject: Subject,
	impersonatedTeam: string | null
): Collections.BrowserMutationScope => ({
	tenantId,
	environment,
	principalId: actor.userId,
	authorityId: canonicalJson({
		effectiveSubjectId: subject.userId,
		impersonationBinding:
			impersonatedTeam === null ? 'operator' : `team:${impersonatedTeam}`
	}),
	command: 'collections.mutate'
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
				entries.map((entry) =>
					DispatchValues.jsonObject({
						name: entry.name,
						label: entry.label,
						secret: entry.secret,
						configured: entry.configured,
						description: entry.description,
						default: entry.default,
						updatedAt: entry.updatedAt
					})
				)
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
				entries.map((entry) =>
					DispatchValues.jsonObject({
						name: entry.name,
						configured: entry.configured,
						updatedAt: entry.updatedAt
					})
				)
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
		 * is one: the answer is this tenant's own `team` rows crossed with the credential's
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
			/**
			 * The founder is an administrator, not a person holding every role at once.
			 *
			 * This used to derive `roles` from every policy the workspace declares, plus a synthetic
			 * `impersonator`. That made the first administrator simultaneously an employee, a
			 * supervisor, a manager and an HR controller — which is not a description of anybody, and
			 * which made their authority a function of the ladder: adding a policy changed what an
			 * administrator was, and anything that stopped supplying roles removed the workspace from
			 * them entirely. Administrative status is now explicit on their own row and bypasses
			 * authored access policy until an explicit team preview clears it.
			 *
			 * `roles` is therefore empty. There is nothing for it to hold: `admin` is not a role, and
			 * assigning the six real ones would be a lie about what this person does in the workspace.
			 *
			 * They are placed in no team, because administrator authority is not team membership.
			 *
			 * This used to *derive* a teams array by walking every policy, every grant and every approval
			 * step in the workspace and collecting each `approvers` name. A founder with no explicit
			 * tenant-data grant cannot raise an approval-gated record in the first place, and administrative
			 * status does not confer eligibility to decide one.
			 * With no team rows and no place to manage them, guessing was the only defence available.
			 *
			 * Teams are rows now and an operator puts people in them, so the guess goes. Immediately after
			 * provisioning the founder has the complete workspace; previewing a team intentionally replaces
			 * that bypass with the selected team's data and approval authority.
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
		 * `verification` is reused rather than a table added, because it already holds
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
			const ledgerIdentifier = `${FOUNDER_CLAIM_IDENTIFIER}${input.claimId}`;
			const spentBy = yield* identity.readFounderClaim(effectId, ledgerIdentifier);
			if (spentBy !== undefined) {
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
			const claimExpiresEpochMs = (yield* Clock.currentTimeMillis) + FOUNDER_CLAIM_LEDGER_MILLIS;
			// Written before the session is minted, so a crash between the two leaves a claim that is
			// spent rather than one that can be spent again. The founder is already an administrator
			// at that point and signs in the ordinary way, which is the safe direction to fail.
			yield* identity.recordFounderClaim(
				effectId,
				ledgerIdentifier,
				`${founderId} ${input.email}`,
				new Date(claimExpiresEpochMs).toISOString()
			);
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
		case Identity.DELIVER_CODE_COMMAND: {
			const delivery = yield* decode(Identity.CodeDelivery, commandInput);
			return json({
				delivered: yield* (yield* Identity.Service).deliverCode(effectId, delivery)
			});
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
		case 'identity.continueSession': {
			const input = yield* decode(IdentityContinueSessionInput, commandInput);
			return json({
				credential: yield* (yield* Identity.Service).startSessionForEmail(
					effectId,
					input.email,
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
						parentId: input.parentId,
						description: input.description
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
						name: input.name,
						parentId: input.parentId,
						description: input.description
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
		case 'approvals.capabilities': {
			const input = yield* decode(ApprovalStatusInput, commandInput);
			const visible = yield* (yield* Collections.Service).findFirst(effectId, input.subject, {
				collection: 'approval_request',
				where: { id: { eq: input.requestId } }
			});
			// Visibility is the first capability. Returning no record keeps an unreadable request
			// indistinguishable from one that does not exist, just like `approvals.status` below.
			if (visible === undefined || typeof visible !== 'object' || visible === null) return json([]);
			const status = Reflect.get(visible, 'status');
			if (typeof status !== 'string') return json([]);
			const capabilities = yield* (yield* Approvals.Service).capabilities(
				effectId,
				input.subject,
				input.requestId
			);
			return json([{ id: input.requestId, status, ...capabilities }]);
		}
		case 'approvals.status': {
			const input = yield* decode(ApprovalStatusInput, commandInput);
			const visible = yield* (yield* Collections.Service).findFirst(effectId, input.subject, {
				collection: 'approval_request',
				where: { id: { eq: input.requestId } }
			});
			if (visible === undefined) return json(null);
			return json((yield* (yield* Approvals.Service).status(effectId, input.requestId)) ?? null);
		}
		case 'approvals.timeline': {
			const input = yield* decode(ApprovalStatusInput, commandInput);
			const visible = yield* (yield* Collections.Service).findFirst(effectId, input.subject, {
				collection: 'approval_request',
				where: { id: { eq: input.requestId } }
			});
			if (visible === undefined) return json([]);
			return json(yield* (yield* Approvals.Service).timeline(effectId, input.requestId));
		}
		case 'sync.head': {
			const sync = yield* Sync.Service;
			return json(yield* sync.head(effectId));
		}
		/**
		 * The public pull half of poke/pull.
		 *
		 * The caller names only dependency collections and its one durable partition position. The guest
		 * derives the security partition, validates every subscription without an existence oracle, and
		 * returns full-row transitions or one explicit recovery move.
		 */
		case 'sync.pull': {
			const input = yield* decode(SyncPullInput, commandInput);
			const response = yield* (yield* Sync.Service).pull(effectId, input.subject, {
				collections: input.collections,
				cursor: input.cursor,
				generations: input.generations,
				...(input.rehydration === undefined ? {} : { rehydration: input.rehydration }),
				...(input.pendingMutationIds === undefined
					? {}
					: { pendingMutationIds: input.pendingMutationIds }),
				...(input.limit === undefined ? {} : { limit: input.limit }),
				...(input.maxBytes === undefined ? {} : { maxBytes: input.maxBytes })
			});
			const pendingMutationIds = input.pendingMutationIds ?? [];
			const tenant = yield* TenantScope.Service;
			const delivery = yield* (yield* Collections.Service).browserMutationDelivery(
				EffectId.make(`${effectId}:mutation-delivery`),
				browserMutationScopeFor(
					tenant.tenantId,
					tenant.environment,
					input.actor,
					input.subject,
					input.impersonatedTeam
				),
				pendingMutationIds,
				response.cursor
			);
			const ownedMutationIds = new Set(delivery.ownedMutationIds);
			return json({
				...response,
				deltas: response.deltas.map((delta) => ({
					...delta,
					mutationId:
						delta.mutationId !== null && ownedMutationIds.has(delta.mutationId)
							? delta.mutationId
							: null
				})),
				mutationConfirmations:
					response.kind === 'delta' ? delivery.confirmations : [],
				mutationRejections: delivery.rejections
			});
		}
		/**
		 * The host-only aggregation half of pull.
		 *
		 * Credentials remain opaque host-to-guest forwards. Each is authenticated against the tenant's
		 * live session rows here, so revocation and team changes cannot be bypassed by a cached host
		 * projection. Authentication and access failures are values scoped to that original request;
		 * shared database/decode failures still fail the batch because there is no unaffected read.
		 */
		case 'sync.distribute': {
			const input = yield* decode(SyncDistributeInput, commandInput);
			const identity = yield* Identity.Service;
			const access = yield* AccessControl.Service;
			type Admitted = Readonly<{
				index: number;
				requestId: string;
				actor: Subject;
				subject: Subject;
				impersonatedTeam: string | null;
				pull: Sync.SyncPullRequest;
			}>;
			const admitted: Array<Admitted> = [];
			const settled = new Map<number, Sync.SyncDistributeResult>();
			for (const [index, entry] of input.entries.entries()) {
				const authenticated = yield* Effect.result(
					identity.authenticate(
						EffectId.make(`${effectId}:authenticate:${index}`),
						entry.credential
					)
				);
				if (Result.isFailure(authenticated)) {
					if (!(authenticated.failure instanceof Identity.AuthenticationError)) {
						return yield* authenticated.failure;
					}
					settled.set(index, {
						requestId: entry.requestId,
						status: 401,
						error: makeWireError('unauthorized', 'Credential is invalid or expired', {
							httpStatus: 401
						})
					});
					continue;
				}
				const actor = authenticated.success;
				if (actor.tenantId !== input.subject.tenantId) {
					settled.set(index, {
						requestId: entry.requestId,
						status: 403,
						error: makeWireError(
							'forbidden',
							'Authenticated subject is outside the invocation tenant',
							{ httpStatus: 403 }
						)
					});
					continue;
				}
				let subject = actor;
				if (entry.impersonatedTeam !== undefined) {
					const previewed = yield* Effect.result(
						access.subjectAsTeam(actor, entry.impersonatedTeam)
					);
					if (Result.isFailure(previewed)) {
						if (!(previewed.failure instanceof AccessControl.AccessDenied)) {
							return yield* previewed.failure;
						}
						settled.set(index, {
							requestId: entry.requestId,
							status: 403,
							error: makeWireError(
								'forbidden',
								previewed.failure.message.trim() === ''
									? 'Access refused'
									: previewed.failure.message,
								{ httpStatus: 403 }
							)
						});
						continue;
					}
					subject = previewed.success;
				}
				admitted.push({
					index,
					requestId: entry.requestId,
					actor,
					subject,
					impersonatedTeam: entry.impersonatedTeam ?? null,
					pull: entry.pull
				});
			}

			if (admitted.length > 0) {
				const tenant = yield* TenantScope.Service;
				const collections = yield* Collections.Service;
				const distributed = yield* (yield* Sync.Service).distribute(
					EffectId.make(`${effectId}:outbox`),
					admitted.map(({ requestId, subject, pull }) => ({ requestId, subject, pull }))
				);
				for (const [admittedIndex, result] of distributed.entries()) {
					const source = admitted[admittedIndex];
					if (source === undefined) {
						return yield* new DispatchError({
							code: 'dispatch_failed',
							message: 'Sync distribution returned an uncorrelated result'
						});
					}
					if ('error' in result) {
						settled.set(source.index, {
							requestId: source.requestId,
							status: 403,
							error: makeWireError(
								'forbidden',
								result.error.message.trim() === '' ? 'Access refused' : result.error.message,
								{ httpStatus: 403 }
							)
						});
					} else {
						const delivery = yield* collections.browserMutationDelivery(
							EffectId.make(`${effectId}:mutation-delivery:${source.index}`),
							browserMutationScopeFor(
								tenant.tenantId,
								tenant.environment,
								source.actor,
								source.subject,
								source.impersonatedTeam
							),
							source.pull.pendingMutationIds ?? [],
							result.response.cursor
						);
						const ownedMutationIds = new Set(delivery.ownedMutationIds);
						settled.set(source.index, {
							requestId: source.requestId,
							status: 200,
							value: {
								...result.response,
								deltas: result.response.deltas.map((delta) => ({
									...delta,
									mutationId:
										delta.mutationId !== null && ownedMutationIds.has(delta.mutationId)
											? delta.mutationId
											: null
								})),
								mutationConfirmations:
									result.response.kind === 'delta' ? delivery.confirmations : [],
								mutationRejections: delivery.rejections
							}
						});
					}
				}
			}

			const results: Array<Sync.SyncDistributeResult> = [];
			for (const [index] of input.entries.entries()) {
				const result = settled.get(index);
				if (result === undefined) {
					return yield* new DispatchError({
						code: 'dispatch_failed',
						message: 'Sync distribution lost an original request'
					});
				}
				results.push(result);
			}
			return json({ results });
		}
		case 'sync.shape': {
			const input = yield* decode(SyncShapeInput, commandInput);
			return json(yield* (yield* Sync.Service).shape(input.subject));
		}
		case 'sync.compact': {
			const input = yield* decode(SyncCompactInput, commandInput);
			return json(
				yield* (yield* Sync.Service).compact(
					effectId,
					input.retentionDays ?? SyncCompaction.DEFAULT_RETENTION_DAYS
				)
			);
		}
		case 'sync.schema':
			return json((yield* Sync.Service).schema());
		/**
		 * Issues the exact physical O2 identity and settles actor-owned write-only mutations.
		 *
		 * No collection name is accepted or revealed. The optional bounded mutation ids are opaque
		 * ledger keys, and the authenticated actor/effective-subject binding scopes every answer.
		 */
		case 'sync.partition': {
			const authority = yield* decode(AuthenticatedSyncPartitionStatus, commandInput);
			const tenant = yield* TenantScope.Service;
			const sync = yield* Sync.Service;
			const identity = yield* sync.partition(
				EffectId.make(`${effectId}:partition-identity`),
				authority.subject
			);
			const collections = yield* Collections.Service;
			const registered = yield* collections.registerBrowserMutationPartition(
				EffectId.make(`${effectId}:partition-register`),
				{
					tenantId: tenant.tenantId,
					environment: tenant.environment,
					actorId: authority.actor.userId,
					effectiveSubjectId: authority.subject.userId,
					impersonationBinding:
						authority.impersonatedTeam === null
							? 'operator'
							: `team:${authority.impersonatedTeam}`
				},
				identity
			);
			const pendingMutationIds = authority.pendingMutationIds ?? [];
			const through = yield* sync.head(EffectId.make(`${effectId}:partition-status-head`));
			const delivery = yield* collections.browserMutationDelivery(
				EffectId.make(`${effectId}:partition-status-delivery`),
				browserMutationScopeFor(
					tenant.tenantId,
					tenant.environment,
					authority.actor,
					authority.subject,
					authority.impersonatedTeam
				),
				pendingMutationIds,
				through
			);
			return json({
				partition: registered,
				mutationConfirmations: delivery.confirmations,
				mutationRejections: delivery.rejections
			});
		}
		case 'sync.wakeHint': {
			const input = yield* decode(SyncCursor, commandInput);
			return json((yield* Sync.Service).wakeHint(input));
		}
		case 'agents.enqueue': {
			const input = yield* decode(AgentEnqueueInput, commandInput);
			const agents = yield* Agents.Service;
			return json(
				yield* agents.enqueue(
					effectId,
					input.subject,
					input.agent,
					input.conversationId,
					input.turnId,
					{
						kind: 'user_message',
						text: input.message
					}
				)
			);
		}
		case 'agents.execute': {
			const input = yield* decode(AgentExecuteInput, commandInput);
			return json(
				yield* (yield* Agents.Service).execute(
					effectId,
					input.conversationId,
					input.turnId,
					observeProgress(effectId, input.conversationId, yield* Envoys.Service)
				)
			);
		}
		case 'agents.documents.attach': {
			const input = yield* decode(AgentDocumentBindInput, commandInput);
			yield* (yield* Agents.Service).attachFile(
				effectId,
				input.subject,
				input.conversationId,
				input.file
			);
			return json({ attached: true });
		}
		case 'agents.documents.read': {
			const input = yield* decode(AgentDocumentInput, commandInput);
			const media = yield* (yield* Agents.Service).readMedia(
				effectId,
				input.subject,
				input.conversationId,
				input.storageKey
			);
			return json({
				file: media.file,
				bytesBase64: Buffer.from(media.bytes).toString('base64')
			});
		}
		case 'agents.documents.remove': {
			const input = yield* decode(AgentDocumentInput, commandInput);
			yield* (yield* Agents.Service).removeFile(
				effectId,
				input.subject,
				input.conversationId,
				input.storageKey
			);
			return json({ removed: true });
		}
		case 'agents.title': {
			const input = yield* decode(AgentTitleInput, commandInput);
			const agents = yield* Agents.Service;
			return json({ title: yield* agents.title(effectId, input.conversationId) });
		}
		case 'agents.open': {
			const input = yield* decode(AgentOpenInput, commandInput);
			yield* (yield* Agents.Service).open(
				effectId,
				input.subject,
				input.agent,
				input.conversationId
			);
			return json({ opened: true, conversationId: input.conversationId });
		}
		case 'agents.continue': {
			const input = yield* decode(AgentContinueInput, commandInput);
			yield* (yield* Agents.Service).continue(
				effectId,
				input.conversationId,
				input.agentId,
				input.taskId
			);
			return json({ continued: true });
		}
		case 'agents.dequeue': {
			const input = yield* decode(AgentDequeueInput, commandInput);
			yield* (yield* Agents.Service).dequeue(
				effectId,
				input.subject,
				input.conversationId,
				input.taskId
			);
			return json({ dequeued: true });
		}
		case 'agents.reorder': {
			const input = yield* decode(AgentReorderInput, commandInput);
			yield* (yield* Agents.Service).reorder(
				effectId,
				input.subject,
				input.conversationId,
				input.taskIds
			);
			return json({ reordered: true });
		}
		case 'agents.interrupt': {
			const input = yield* decode(AgentLaneInput, commandInput);
			yield* (yield* Agents.Service).interrupt(effectId, input.subject, input.conversationId);
			return json({ interrupted: true });
		}
		case 'agents.stop': {
			const input = yield* decode(AgentLaneInput, commandInput);
			yield* (yield* Agents.Service).stop(effectId, input.subject, input.conversationId);
			return json({ stopped: true });
		}
		case 'agents.resume': {
			const input = yield* decode(AgentLaneInput, commandInput);
			yield* (yield* Agents.Service).resume(effectId, input.subject, input.conversationId);
			return json({ resumed: true });
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
			return json((yield* Agents.Service).listSkills(input.subject));
		}
		case 'agents.readSkill': {
			const input = yield* decode(SkillInput, commandInput);
			if (input.name === undefined)
				return yield* new DispatchError({
					code: 'invalid_input',
					message: 'Skill name is required'
				});
			return json(yield* (yield* Agents.Service).readSkill(input.subject, input.name));
		}
		// The agent model picker asks for the models this deployment offers. Bolt does not decide that
		// — the host's AI facility does — so this forwards the question rather than answering it.
		case 'ai.models': {
			const ai = yield* AI.Service;
			return json((yield* ai.execute(effectId, { _tag: 'Models' })).output);
		}
		/**
		 * Every agent a caller can open a conversation with: the web agent, plus one per envoy.
		 *
		 * `web` is a literal rather than a declaration, because the web agent has none — it is defined
		 * entirely by who is using it. This used to answer `definition.agents`, an array that had
		 * exactly one element in every workspace that ever existed: the placeholder the compiler
		 * synthesized.
		 */
		case 'workspace.agents': {
			const definition = (yield* Workspace.Service).definition;
			return json([WEB_AGENT_NAME, ...definition.envoys.map(({ name }) => name)]);
		}
		/**
		 * Runtime consumers receive only collections they may read. Studio has a separate authoring
		 * boundary: an administrator receives every authored collection and no runtime-owned one.
		 */
		case 'workspace.manifest':
		case 'workspace.authoringManifest': {
			const input = yield* decode(VisibleAppsInput, commandInput);
			const workspace = yield* Workspace.Service;
			const access = yield* AccessControl.Service;
			const definition = workspace.definition;
			const authoring = command === 'workspace.authoringManifest';
			if (authoring && input.subject.admin !== true) {
				return yield* new AccessControl.AccessDenied({
					action: 'read',
					resource: 'workspace.authoringManifest',
					reason: 'Workspace authoring is restricted to administrators'
				});
			}
			const visible = definition.collections.filter(({ name }) =>
				authoring
					? !SYSTEM_COLLECTION_NAMES.has(name)
					: access.predicate(input.subject, 'read', name).allowed
			);
			return json({
				name: definition.name,
				version: definition.version,
				collections: visible.map((collection) => ({
					name: collection.name,
					history: collection.history,
					hooks: [...(collection.hooks ?? [])],
					// Model presentation metadata projected for Studio and the data browser.
					...DispatchValues.jsonObject({
						description: collection.description,
						icon: collection.icon,
						sourcePath: collection.sourcePath
					}),
					// Every key a field description carries, not a chosen four. The projection named
					// `name`/`type`/`required`/`generated` and dropped the rest, so a studio could not
					// offer an enum's members, could not mark a searchable column, could not resolve a
					// `custom()` renderer and could not set an upload's accept list — each of them a
					// declaration a workspace makes, and this the last hop before it would be read.
					fields: Object.entries(collection.fields).map(([field, definition]) =>
						DispatchValues.jsonObject({
							name: field,
							type: definition.type,
							required: definition.required,
							generated: definition.generated !== undefined,
							values: definition.values === undefined ? undefined : [...definition.values],
							search: definition.search,
							customType: definition.customType,
							mimeTypes: definition.mimeTypes === undefined ? undefined : [...definition.mimeTypes]
						})
					),
					relations: definition.relations
						.filter((relation) => relation.source === collection.name)
						.map(({ name, target, cardinality }) => ({ name, target, cardinality }))
				})),
				apps: definition.apps.map(({ name, label }) => ({ name, label })),
				policies: definition.policies.map((policy) => ({
					name: policy.name,
					grants: policy.grants?.length ?? 0
				})),
				automations: definition.automations.map(({ name }) => ({ name })),
				// What identifies an envoy and what shape of traffic it carries, for the same reason the
				// field projection above stopped naming four keys: a studio that is told only an envoy's
				// name cannot say which transport it arrives over, and cannot tell a public envoy from one
				// only members reach.
				//
				// `policies` and `task` are declared and deliberately not published. `task` is the envoy's
				// standing instruction and `policies` names everything its runs may do; neither manifest
				// publishes those operational instructions.
				//
				// There is no `agent` key, because there is no agent to point at. An envoy *is* one, and
				// the back-pointer this used to publish had the same value for every envoy in every
				// workspace: the single synthesized agent the compiler invented.
				envoys: definition.envoys.map(({ name, transport, audience, groupMessages }) =>
					DispatchValues.jsonObject({ name, transport, audience, groupMessages })
				),
				/**
				 * Every static identity this release can mint, with the label a surface renders it as.
				 *
				 * `bolt_audit.subject_id` and `bolt_collection_history.subject_id` are plain `text` with no
				 * foreign key, which is what lets `envoy:sales_desk` and `automation:payroll_close` be
				 * valid values with no shadow user table. What was missing was the *label*: a client
				 * holding `envoy:sales_desk` had nothing to render but the id.
				 */
				principals: [
					{ id: SystemPrincipal.SYSTEM_PRINCIPAL_ID, label: 'Colony', kind: 'host', policies: [] },
					{ id: SEED_PRINCIPAL_ID, label: 'Sample data', kind: 'seed', policies: [] },
					...definition.envoys.map((envoy) => ({
						id: envoyPrincipalId(envoy.name),
						label: envoy.name,
						kind: 'envoy',
						policies: [...envoy.policies]
					})),
					...definition.automations.map((automation) => ({
						id: automationPrincipalId(automation.name),
						label: automation.name,
						kind: 'automation',
						policies: [...automation.policies]
					}))
				],
				integrations: definition.integrations.map(({ name }) => ({ name })),
				requiredFacilities: [...definition.requiredFacilities]
			});
		}
		case 'collections.findMany': {
			const input = yield* decode(CollectionFindInput, commandInput);
			return yield* collectionPage(effectId, input);
		}
		case 'collections.findGrouped': {
			const input = yield* decode(CollectionGroupedInput, commandInput);
			const workspace = yield* Workspace.Service;
			const definition = yield* workspace.collection(input.collection);
			if (
				(!SYSTEM_COLUMN_NAMES.includes(input.group.by) &&
					!Object.hasOwn(definition.fields, input.group.by)) ||
				definition.fields[input.group.by]?.reference !== undefined ||
				definition.fields[input.group.by]?.type === 'json' ||
				input.group.by === 'sys_period'
			) {
				return yield* new DispatchError({
					code: 'invalid_input',
					message: 'Grouped queries require one persisted scalar column.'
				});
			}
			const described = canonicalizeCollectionQuery(
				'findGrouped',
				input,
				workspaceCollectionQueryMetadata(workspace.definition),
				{ pinnedCollation: true, localRelationships: true, localSearch: true }
			);
			if (described === undefined) {
				return yield* new DispatchError({
					code: 'invalid_input',
					message: 'Grouped collection query could not be canonicalized'
				});
			}
			const position = yield* (yield* Sync.Service).positions(
				EffectId.make(`${effectId}:grouped-position`),
				input.subject,
				described.dependencies
			);
			const groups = yield* (yield* Collections.Service).findGrouped(
				effectId,
				input.subject,
				{
					collection: input.collection,
					where: input.where,
					userFilter: input.userFilter,
					orderBy: input.orderBy,
					with: withoutCollectionQueryProjection(input.with),
					search: input.search,
					groupBy: input.group.by,
					lanes: input.group.lanes ?? []
				}
			);
			const hydration = normalizeCollectionHydration(
				workspace.definition,
				input.collection,
				Object.values(groups).flat()
			);
			if (Result.isFailure(hydration)) {
				return yield* new DispatchError({
					code: 'invalid_stored_record',
					message: hydration.failure.message
				});
			}
			return json({
				groups,
				baseRows: hydration.success.baseRows,
				relationshipRefs: hydration.success.relationshipRefs,
				readCursor: position.cursor,
				partitionKey: position.partition.key,
				confirmedDependencies: Object.keys(position.generations).toSorted(),
				dependencyGenerations: position.generations,
				reproducibility: described.reproducibility
			});
		}
		case 'collections.findFirst': {
			const input = yield* decode(CollectionFindInput, commandInput);
			const row = yield* (yield* Collections.Service).findFirst(
					effectId,
					input.subject,
					collectionQuery(input)
				);
			return json(
				row === undefined
					? null
					: projectCollectionQueryRecord(row, input.columns, input.with)
			);
		}
		case 'collections.count': {
			const input = yield* decode(CollectionFindInput, commandInput);
			const workspace = yield* Workspace.Service;
			const described = canonicalizeCollectionQuery(
				'count',
				input,
				workspaceCollectionQueryMetadata(workspace.definition),
				{ pinnedCollation: true, localRelationships: true, localSearch: true }
			);
			if (described === undefined) {
				return yield* new DispatchError({
					code: 'invalid_input',
					message: 'Collection count could not be canonicalized'
				});
			}
			const position = yield* (yield* Sync.Service).positions(
				EffectId.make(`${effectId}:count-position`),
				input.subject,
				described.dependencies
			);
			return json({
				count: yield* (yield* Collections.Service).count(
					effectId,
					input.subject,
					collectionQuery(input)
				),
				readCursor: position.cursor,
				partitionKey: position.partition.key,
				confirmedDependencies: Object.keys(position.generations).toSorted(),
				dependencyGenerations: position.generations,
				reproducibility: described.reproducibility
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
		/** The browser's one declarative write: a root and every relationship it explicitly owns. */
		case 'collections.mutate': {
			const authority = yield* decode(AuthenticatedCollectionMutation, commandInput);
			const input = yield* decode(CollectionMutateRequest, commandInput);
			const tenant = yield* TenantScope.Service;
			const collections = yield* Collections.Service;
			const submittedGraph: CollectionMutationGraph = input.graph;
			const submittedBaseVersions: ReadonlyArray<CollectionMutationBaseVersion> =
				input.baseVersions;
			const scope = browserMutationScopeFor(
				tenant.tenantId,
				tenant.environment,
				authority.actor,
				authority.subject,
				authority.impersonatedTeam
			);
			const registeredPartition = yield* collections.browserMutationPartition(
				EffectId.make(`${effectId}:browser-mutation:partition`),
				{
					tenantId: tenant.tenantId,
					environment: tenant.environment,
					actorId: authority.actor.userId,
					effectiveSubjectId: authority.subject.userId,
					impersonationBinding:
						authority.impersonatedTeam === null
							? 'operator'
							: `team:${authority.impersonatedTeam}`
				},
				input.partitionKey
			);
			if (
				registeredPartition === undefined ||
				registeredPartition.schemaFingerprint !== input.schemaFingerprint
			)
				return yield* new AccessControl.AccessDenied({
					action: 'mutate',
					resource: submittedGraph.collection,
					reason:
						'The mutation journal partition is not a server-issued partition for this authenticated identity and schema.'
				});
			const requestDigest = yield* sha256Hex(canonicalJson(input));
			const scopeDigest = yield* sha256Hex(
				canonicalJson({ ...scope, idempotencyKey: input.idempotencyKey })
			);
			const mutationEffectId = EffectId.make(`browser-mutation:${scopeDigest}`);
			const replayOutcome = Effect.fn('Bolt.replayBrowserMutation')(function* (
				outcome: Collections.BrowserMutationOutcome
			) {
				if (outcome._tag === 'PendingApproval') {
					return json({
						resolution: 'accepted',
						mutationId: input.idempotencyKey,
						deviceSequence: input.deviceSequence,
						schemaFingerprint: outcome.schemaFingerprint,
						records: [],
						pendingApproval: {
							requestId: outcome.requestId,
							collection: outcome.collection,
							id: outcome.id,
							action: outcome.action
						}
					});
				}
				if (outcome._tag === 'VersionConflict') {
					return json({
						resolution: 'rejected',
						mutationId: input.idempotencyKey,
						deviceSequence: input.deviceSequence,
						code: 'conflict',
						message:
							outcome.currentVersion === null
								? `${outcome.collection} ${outcome.id} no longer exists at row version ${outcome.baseVersion}.`
								: `${outcome.collection} ${outcome.id} changed from row version ${outcome.baseVersion} to ${outcome.currentVersion}.`,
						schemaFingerprint: outcome.schemaFingerprint
					});
				}
				if (outcome._tag === 'Quarantined')
					return json({
						resolution: 'quarantined',
						mutationId: outcome.idempotencyKey,
						deviceSequence: outcome.deviceSequence,
						schemaFingerprint: outcome.schemaFingerprint,
						reason: outcome.reason
					});
				if (outcome._tag === 'Rejected') {
					return json({
						resolution: 'rejected',
						mutationId: input.idempotencyKey,
						deviceSequence: input.deviceSequence,
						code: outcome.code,
						message: outcome.message,
						schemaFingerprint: outcome.schemaFingerprint
					});
				}
				const records =
					outcome.action === 'delete'
						? []
						: yield* collections
								.findMany(EffectId.make(`${mutationEffectId}:readback`), authority.subject, {
									collection: outcome.collection,
									where: { id: { in: [outcome.id] } },
									limit: 1
								})
								.pipe(Effect.catch(() => Effect.succeed([])));
				return outcome.resolution === 'accepted'
					? json({
							resolution: 'accepted',
							mutationId: input.idempotencyKey,
							deviceSequence: outcome.deviceSequence,
							schemaFingerprint: outcome.toSchemaFingerprint,
							records
						})
					: json({
							resolution: 'rebased',
							mutationId: input.idempotencyKey,
							deviceSequence: outcome.deviceSequence,
							fromSchemaFingerprint: outcome.fromSchemaFingerprint,
							toSchemaFingerprint: outcome.toSchemaFingerprint,
							records
						});
			});
			const replay = yield* collections.browserMutationOutcome(
				EffectId.make(`${effectId}:browser-mutation:lookup`),
				scope,
				input.idempotencyKey,
				requestDigest
			);
			if (replay !== undefined) return yield* replayOutcome(replay);

			const nowEpochMs = yield* Clock.currentTimeMillis;
			if (input.issuedAtEpochMs > nowEpochMs + 5 * 60 * 1000)
				return yield* new Collections.MutationRetryExpired({
					issuedAtEpochMs: input.issuedAtEpochMs
				});

			const currentSchemaFingerprint = (yield* Sync.Service).schema().fingerprint;
			const workspace = yield* Workspace.Service;
			const reconciliation = reconcileMutationSchema(workspace.definition, {
				fromSchemaFingerprint: input.schemaFingerprint,
				toSchemaFingerprint: currentSchemaFingerprint,
				ageMillis: Math.max(0, nowEpochMs - input.issuedAtEpochMs),
				graph: submittedGraph,
				baseVersions: submittedBaseVersions
			});
			const graph = reconciliation.resolution === 'quarantined' ? submittedGraph : reconciliation.graph;
			const baseVersions =
				reconciliation.resolution === 'quarantined'
					? submittedBaseVersions
					: reconciliation.baseVersions;
			let quarantineReason =
				reconciliation.resolution === 'quarantined' ? reconciliation.reason : undefined;
			if (quarantineReason === undefined) {
				const seenBaseRows = new Set<string>();
				for (const entry of baseVersions) {
					const coordinate = canonicalJson(entry.row);
					if (seenBaseRows.has(coordinate)) {
						quarantineReason = `The mutation graph carries more than one base version for ${entry.row.collection} ${entry.row.recordId}.`;
						break;
					}
					seenBaseRows.add(coordinate);
				}
			}
			const submittedId = graph.action === 'delete' ? graph.id : graph.values['id'];
			if (
				quarantineReason === undefined &&
				(typeof submittedId !== 'string' || !MUTATION_RECORD_ID.test(submittedId))
			)
				quarantineReason = `${graph.action} mutation ${graph.collection} must carry a valid client-minted UUID.`;
			if (reconciliation.resolution !== 'quarantined' && graph.action !== 'delete') {
				const checked = yield* Effect.result(checkWrittenGraph(graph.collection, graph.values));
				if (Result.isFailure(checked)) {
					quarantineReason =
						reconciliation.resolution === 'rebased'
							? `The retained compatibility adapter cannot produce a valid current-schema graph: ${describeCause(checked.failure)}`
							: `The journaled graph is not safe to apply to the current schema: ${describeCause(checked.failure)}`;
				}
			}
			const rootId = String(submittedId);
			const committed: Collections.BrowserMutationOutcome = {
				_tag: 'Committed',
				collection: graph.collection,
				id: rootId,
				action: graph.action,
				resolution: reconciliation.resolution === 'rebased' ? 'rebased' : 'accepted',
				deviceSequence: input.deviceSequence,
				fromSchemaFingerprint: input.schemaFingerprint,
				toSchemaFingerprint: currentSchemaFingerprint
			};
			const rootBaseVersion = baseVersions.find(
				(entry) => entry.row.collection === graph.collection && entry.row.recordId === rootId
			)?.rowVersion;
			if (graph.action === 'create' && rootBaseVersion !== undefined)
				quarantineReason = `The create graph carries a base version for its new root ${graph.collection} ${rootId}.`;
			const quarantined: Collections.BrowserMutationOutcome | undefined =
				quarantineReason !== undefined
					? {
							_tag: 'Quarantined',
							idempotencyKey: input.idempotencyKey,
							deviceSequence: input.deviceSequence,
							schemaFingerprint: input.schemaFingerprint,
							reason: quarantineReason
						}
					: undefined;
			const fence: Collections.BrowserMutationFence = {
				scope,
				idempotencyKey: input.idempotencyKey,
				requestDigest,
				issuedAtEpochMs: input.issuedAtEpochMs,
				deviceSequence: input.deviceSequence,
				partitionKey: input.partitionKey,
				schemaFingerprint: input.schemaFingerprint,
				currentSchemaFingerprint,
				baseVersions,
				outcome: quarantined ?? committed
			};
			const beginning = yield* collections.beginBrowserMutation(
				EffectId.make(`${effectId}:browser-mutation:begin`),
				fence
			);
			if (beginning._tag === 'Replay') return yield* replayOutcome(beginning.outcome);
			if (beginning._tag === 'InProgress')
				return yield* new Collections.MutationInProgress({
					retryAfterSeconds: beginning.retryAfterSeconds
				});
			const persistTerminalFailure = Effect.fn('Bolt.persistTerminalMutationFailure')(function* (
				fence: Collections.BrowserMutationFence,
				cause: unknown
			) {
				const error = Collections.unwrapMutationPhase(cause);
				const refusal = refusalOf(error);
				const outcome: Collections.BrowserMutationOutcome | undefined =
					refusal !== undefined
						? {
								_tag: 'Rejected',
								code: 'refused',
								message: refusal.message,
								schemaFingerprint: fence.currentSchemaFingerprint,
								...(refusal.collection === undefined ? {} : { collection: refusal.collection }),
								...(refusal.action === undefined ? {} : { action: refusal.action })
							}
						: error instanceof AccessControl.AccessDenied
							? {
									_tag: 'Rejected',
									code: 'forbidden',
									message: error.reason,
									schemaFingerprint: fence.currentSchemaFingerprint,
									collection: error.resource,
									...(error.action === 'create' ||
									error.action === 'update' ||
									error.action === 'delete'
										? { action: error.action }
										: {})
								}
							: error instanceof Collections.MutationVersionConflict
								? {
										_tag: 'VersionConflict',
										collection: error.collection,
										id: error.id,
										baseVersion: error.baseVersion,
										currentVersion: error.currentVersion,
										schemaFingerprint: fence.currentSchemaFingerprint
									}
								: error instanceof Collections.PendingApproval
									? {
											_tag: 'PendingApproval',
											requestId: error.requestId,
											collection: error.collection,
											id: error.id,
											action: error.action,
											schemaFingerprint: fence.currentSchemaFingerprint
										}
									: undefined;
				if (outcome === undefined) return undefined;
				return yield* collections.rememberBrowserMutationOutcome(
					EffectId.make(`${effectId}:browser-mutation:terminal-error`),
					fence,
					outcome
				);
			});
			if (quarantined !== undefined) {
				const durable = yield* collections.rememberBrowserMutationOutcome(
					EffectId.make(`${effectId}:browser-mutation:quarantine`),
					fence,
					quarantined
				);
				return yield* replayOutcome(durable ?? quarantined);
			}

			if (graph.action === 'delete') {
				const deletion = yield* Effect.result(
					collections.delete(mutationEffectId, authority.subject, graph.collection, graph.id, {
						...(rootBaseVersion === undefined || rootBaseVersion === null
							? {}
							: { baseVersion: rootBaseVersion }),
						browserMutation: fence
					})
				);
				if (Result.isFailure(deletion)) {
					const terminal = Collections.unwrapMutationPhase(deletion.failure);
					if (terminal instanceof Collections.MutationQuarantined)
						return yield* replayOutcome({
							_tag: 'Quarantined',
							idempotencyKey: terminal.idempotencyKey,
							deviceSequence: terminal.deviceSequence,
							schemaFingerprint: terminal.schemaFingerprint,
							reason: terminal.reason
						});
					const durable = yield* persistTerminalFailure(fence, deletion.failure);
					if (durable !== undefined) return yield* replayOutcome(durable);
					return yield* Effect.fail(deletion.failure);
				}
				return yield* replayOutcome(committed);
			}

			const mutation = yield* Effect.result(
				collections.mutate(
					mutationEffectId,
					authority.subject,
					graph.collection,
					[graph.values],
					false,
					0,
					{
						declarative: true,
						root: { id: rootId, action: graph.action },
						browserMutation: fence
					}
				)
			);
			if (Result.isFailure(mutation)) {
				const terminal = Collections.unwrapMutationPhase(mutation.failure);
				if (terminal instanceof Collections.MutationQuarantined)
					return yield* replayOutcome({
						_tag: 'Quarantined',
						idempotencyKey: terminal.idempotencyKey,
						deviceSequence: terminal.deviceSequence,
						schemaFingerprint: terminal.schemaFingerprint,
						reason: terminal.reason
					});
				const durable = yield* persistTerminalFailure(fence, mutation.failure);
				if (durable !== undefined) return yield* replayOutcome(durable);
				return yield* Effect.fail(mutation.failure);
			}
			const written = mutation.success;
			const stored = written[0];
			const id = stored?.['id'];
			// Mutation success is independent of read entitlement. Querying through the ordinary subject
			// path applies both row and field policy; a write-only subject receives an empty record list,
			// and a post-commit read failure cannot turn an already committed mutation into a retry.
			const records =
				typeof id !== 'string'
					? []
					: yield* collections
							.findMany(EffectId.make(`${mutationEffectId}:readback`), authority.subject, {
								collection: graph.collection,
								where: { id: { in: [id] } },
								limit: 1
							})
							.pipe(Effect.catch(() => Effect.succeed([])));
			return json({
				resolution: reconciliation.resolution,
				mutationId: input.idempotencyKey,
				deviceSequence: input.deviceSequence,
				...(reconciliation.resolution === 'rebased'
					? {
							fromSchemaFingerprint: input.schemaFingerprint,
							toSchemaFingerprint: currentSchemaFingerprint
						}
					: { schemaFingerprint: currentSchemaFingerprint }),
				records
			});
		}
		case 'collections.resume': {
			const input = yield* decode(ApprovalRequestIdInput, commandInput);
			yield* (yield* Collections.Service).resume(effectId, input.requestId);
			return json({ resumed: true, requestId: input.requestId });
		}
		case 'collections.discard': {
			const input = yield* decode(ApprovalRequestIdInput, commandInput);
			yield* (yield* Collections.Service).discard(effectId, input.requestId);
			return json({ discarded: true, requestId: input.requestId });
		}
		case 'collections.import': {
			const input = yield* decode(CollectionImportInput, commandInput);
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
		 * tables first, because generated columns call `bolt_date` and trigram indexes need
		 * `pg_trgm`; then the lineage, which owns every authored collection; then the plan's supplements
		 * for what Drizzle cannot express.
		 */
		case 'sync.provisioning': {
			const input = yield* decode(SyncShapeInput, commandInput);
			const workspace = yield* Workspace.Service;
			const access = yield* AccessControl.Service;
			const steps = replicaProvisioningSteps(workspace.definition);
			const schemaFingerprint =
				workspace.definition.mutationCompatibility?.currentSchemaFingerprint;
			if (schemaFingerprint === undefined)
				throw new TypeError(
					'Compiled workspace is missing its mutation compatibility fingerprint.'
				);
			// The projection is JSON by construction — every value is a string, an array of strings or
			// a decoded declaration — so the wire value is the same object after serialisation, and a
			// decode of the serialised form is the boundary check that keeps that claim honest.
			const provisioning = {
				steps,
				// O2 namespace identity and M4 compatibility use the compiler-owned logical SHA-256.
				// `migrationDigest` on sync.schema separately authenticates these exact ordered DDL bytes.
				fingerprint: schemaFingerprint,
				/**
				 * The metadata the replica needs to compile a query the way the server would.
				 *
				 * Sent rather than re-derived on the client, so the local read path and the server read
				 * path cannot disagree about what a column is. Nothing is disclosed that the DDL above
				 * does not already state — these are the same collections, spelled as declarations
				 * instead of as `create table`.
				 */
				collections: workspace.definition.collections.map(({ name, fields }) => {
					const projection = access.predicate(input.subject, 'read', name);
					return {
						name,
						fields,
						...(projection.allowed
							? { readableFields: projection.fields === undefined ? null : projection.fields }
							: {})
					};
				}),
				relations: workspace.definition.relations ?? []
			};
			return json(
				Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(JSON.stringify(provisioning))
			);
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
				taskId: yield* automations.start(effectId, input.name, input.input)
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
				taskId: yield* (yield* Automations.Service).runStep(effectId, input.name, input.input)
			});
		}
		case 'automations.stop': {
			const input = yield* decode(AutomationLifecycleInput, commandInput);
			yield* (yield* Automations.Service).stop(effectId, input.name, input.taskId);
			return json({ stopped: true });
		}
		case 'automations.resume': {
			const input = yield* decode(AutomationLifecycleInput, commandInput);
			yield* (yield* Automations.Service).resume(effectId, input.name, input.taskId);
			return json({ resumed: true });
		}
		case 'envoys.receive': {
			const input = yield* decode(EnvoyReceiveInput, commandInput);
			const envoys = yield* Envoys.Service;
			return json(yield* envoys.receive(effectId, input.envoy, input.delivery));
		}
		case 'envoys.drain': {
			const input = yield* decode(EnvoyDrainInput, commandInput);
			return json(
				yield* (yield* Envoys.Service).drain(effectId, input.envoy, input.conversationId)
			);
		}
		case 'envoys.complete': {
			const input = yield* decode(EnvoyCompleteInput, commandInput);
			return json(
				yield* (yield* Envoys.Service).complete(
					effectId,
					input.envoy,
					input.conversationId,
					input.output,
					input.progressKey ?? null
				)
			);
		}
		case 'envoys.register': {
			const input = yield* decode(EnvoyNameInput, commandInput);
			yield* (yield* Envoys.Service).register(effectId, input.envoy);
			return json({ registered: true });
		}
		case 'envoys.reply': {
			const input = yield* decode(EnvoyReplyInput, commandInput);
			yield* (yield* Envoys.Service).reply(effectId, input.envoy, input.recipient, input.payload);
			return json({ replied: true });
		}
		case 'envoys.status': {
			const input = yield* decode(EnvoyNameInput, commandInput);
			return json(yield* (yield* Envoys.Service).status(effectId, input.envoy));
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
					const automations = yield* Automations.Service;
					const guard = Automations.stoppageGuard(automations, effectId, input.bolt_task_id);
					const ops = guardAuthoringOps(
						makeBoundAuthoringOps(effectId, input.bolt_run_as, collections, ai, files, automations),
						guard
					);
					const api = makeAutomationApi(makeAuthoringApi(ops), (value) =>
						guard('progress').pipe(
							Effect.andThen(Schema.decodeUnknownEffect(AutomationProgression)(value)),
							Effect.flatMap((progression) =>
								automations.progress(effectId, input.bolt_task_id, progression)
							)
						)
					);
					const args = yield* decode(automation.input ?? Schema.Json, input.args);
					const output = yield* runAuthoredHandler(() =>
						automation.handler(api, { args, scope: input.scope ?? {} })
					);
					const declaredOutput = yield* decode(automation.output ?? Schema.Unknown, output);
					return json(yield* decode(Schema.Json, declaredOutput));
				}
			}
			return yield* new DispatchError({
				code: 'unknown_command',
				message: `Unknown Bolt command: ${command}`
			});
	}
});
