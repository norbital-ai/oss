import { Schema } from 'effect';
import { Prompt, Response } from 'effect/unstable/ai';
import { HostScheduleOccurrence } from './host.js';
import { InvocationScope } from './invocation.js';
import { PushSubscription, Transport } from './channels.js';
import { ChangeBatch } from './sync.js';
import { EffectId, FacilityCall, FacilityResult, ReleaseId } from './wire.js';

export const DatabaseRequest = Schema.TaggedUnion({
	Query: { sql: Schema.NonEmptyString, parameters: Schema.Array(Schema.Json) },
	Transaction: {
		statements: Schema.Array(
			Schema.Struct({ sql: Schema.NonEmptyString, parameters: Schema.Array(Schema.Json) })
		)
	}
});
export type DatabaseRequest = typeof DatabaseRequest.Type;
export const DatabaseResponse = Schema.Struct({
	rows: Schema.Array(Schema.Json),
	affectedRows: Schema.Number
});
export interface DatabaseResponse extends Schema.Schema.Type<typeof DatabaseResponse> {}

/** One statement of a `DatabaseRequest.Transaction`, as the wire carries it. */
export type TransactionStatement = Extract<
	DatabaseRequest,
	{ readonly _tag: 'Transaction' }
>['statements'][number];

/**
 * One `Transaction` request is one database round trip, and this is the one place a binding turns
 * its statements into that call.
 *
 * `submit` must hand each statement to a connection that writes without waiting for an earlier
 * statement's answer — a node-postgres client constructed with `pipeline: true` does — because the
 * helper submits `begin`, every statement, and `commit` in one synchronous burst and only then
 * awaits. A driver that answers each statement before the next one is written turns a request of N
 * statements into N round trips; the conformance test beside this package measures that with an
 * instrumented transport that counts write bursts.
 *
 * Results are one per statement, in request order; the transaction-control results are not
 * returned. A failed statement rolls the transaction back and rejects with the driver's reason.
 */
export const runTransactionInOneRoundTrip = async <Result>(
	submit: (sql: string, parameters: ReadonlyArray<Schema.Json>) => Promise<Result>,
	statements: ReadonlyArray<TransactionStatement>
): Promise<ReadonlyArray<Result>> => {
	const settled = await Promise.allSettled([
		submit('begin', []),
		...statements.map((statement) => submit(statement.sql, statement.parameters)),
		submit('commit', [])
	]);
	const failed = settled.find((outcome) => outcome.status === 'rejected');
	if (failed?.status === 'rejected') {
		await submit('rollback', []).catch(() => undefined);
		throw failed.reason;
	}
	return settled
		.slice(1, -1)
		.flatMap((outcome) => (outcome.status === 'fulfilled' ? [outcome.value] : []));
};

// `Write` carried a `contentType` until it was noticed that nothing could ever honour it: no binding
// persisted it, and `FileResponse` has no field to return it in, so the media type of a stored object
// was unrecoverable by construction. Persisting it would mean a second field here, a matching field
// on `FileResponse`, and a per-object metadata sidecar invented in all three bindings — a storage
// convention that does not exist yet, to serve one consumer that already has a working answer:
// `api/files/[...key]` derives the media type from the key's extension and sends `nosniff`, which is
// safer than echoing a caller-supplied type anyway. A wire field no implementation can satisfy is a
// promise to consumers, so it is deleted rather than left to look supported.
export const FileRequest = Schema.TaggedUnion({
	Read: { key: Schema.NonEmptyString },
	Write: { key: Schema.NonEmptyString, bytes: Schema.Uint8Array },
	Delete: { key: Schema.NonEmptyString },
	List: { prefix: Schema.String }
});
export type FileRequest = typeof FileRequest.Type;
export const FileResponse = Schema.Struct({
	key: Schema.optionalKey(Schema.String),
	bytes: Schema.optionalKey(Schema.Uint8Array),
	keys: Schema.optionalKey(Schema.Array(Schema.String)),
	etag: Schema.optionalKey(Schema.String)
});
export interface FileResponse extends Schema.Schema.Type<typeof FileResponse> {}

const UUID = Schema.String.check(Schema.isUUID());

export const ConversationId = UUID.pipe(Schema.brand('ConversationId'));
export type ConversationId = typeof ConversationId.Type;
export const PlanId = UUID.pipe(Schema.brand('PlanId'));
export type PlanId = typeof PlanId.Type;
export const MessageId = UUID.pipe(Schema.brand('ConversationMessageId'));
export type MessageId = typeof MessageId.Type;
export const TurnId = UUID.pipe(Schema.brand('TurnId'));
export type TurnId = typeof TurnId.Type;
export const WorkbenchId = Schema.NonEmptyString.pipe(Schema.brand('AgentWorkbenchId'));
export type WorkbenchId = typeof WorkbenchId.Type;
export const SubjectId = Schema.NonEmptyString.pipe(Schema.brand('AgentSubjectId'));
export type SubjectId = typeof SubjectId.Type;
export const AgentId = Schema.NonEmptyString.pipe(Schema.brand('AgentId'));
export type AgentId = typeof AgentId.Type;
export const ModelId = Schema.NonEmptyString.pipe(Schema.brand('AgentModelId'));
export type ModelId = typeof ModelId.Type;
export const ProviderCallId = Schema.NonEmptyString.pipe(Schema.brand('AgentProviderCallId'));
export type ProviderCallId = typeof ProviderCallId.Type;

export const ConversationAudience = Schema.Literals(['personal', 'workbench']);
export type ConversationAudience = typeof ConversationAudience.Type;
/**
 * There is no `waiting`. A parent parked on a subagent was the only thing that produced it, and a
 * parent runs its children itself now: the child is a frame on the parent's own stack, so there is
 * no state in which a conversation is stopped and expecting something else to restart it.
 */
export const ConversationStatus = Schema.Literals([
	'ready',
	'running',
	'stopped',
	'attention',
	'done',
	'failed'
]);
export type ConversationStatus = typeof ConversationStatus.Type;
export const PlanStatus = Schema.Literals([
	'draft',
	'active',
	'verified',
	'stalled',
	'superseded',
	'discarded'
]);
export type PlanStatus = typeof PlanStatus.Type;
export const PlanAction = Schema.Struct({
	action: Schema.Literals(['execute', 'revise', 'delete']),
	planId: PlanId
});
export type PlanAction = typeof PlanAction.Type;
export const DirectiveMode = Schema.Literals(['agent', 'plan', 'compact']);
export type DirectiveMode = typeof DirectiveMode.Type;
export const DirectivePriority = Schema.Literals(['normal', 'steer']);
export type DirectivePriority = typeof DirectivePriority.Type;
export const DirectiveState = Schema.Literals(['queued', 'claimed', 'settled', 'cancelled']);
export type DirectiveState = typeof DirectiveState.Type;
export const RunPhase = Schema.Literals(['model', 'tool', 'children', 'verify']);
export type RunPhase = typeof RunPhase.Type;
export const RunStatus = Schema.Literals(['running', 'succeeded', 'stopped', 'failed']);
export type RunStatus = typeof RunStatus.Type;

/** Descriptor-sized binary evidence. Only the trusted host resolves and verifies its bytes. */
export const FileAsset = Schema.Struct({
	key: Schema.NonEmptyString,
	name: Schema.NonEmptyString,
	mimeType: Schema.NonEmptyString,
	size: Schema.Natural
});
export interface FileAsset extends Schema.Schema.Type<typeof FileAsset> {}
export const ImageAsset = Schema.Struct({
	...FileAsset.fields,
	detail: Schema.optionalKey(Schema.Literals(['auto', 'low', 'high']))
});
export interface ImageAsset extends Schema.Schema.Type<typeof ImageAsset> {}

/**
 * One embedding input: the text and/or images the model embeds as a single vector.
 *
 * A request carries an array of these, so a batch of records is one provider call with one input
 * per record instead of one call per record. Which images belong to which input is structural, not
 * positional, so a record with several images needs no pairing rule.
 */
export const EmbeddingInput = Schema.Struct({
	text: Schema.optionalKey(Schema.String),
	imageAssets: Schema.optionalKey(Schema.Array(ImageAsset))
});
export interface EmbeddingInput extends Schema.Schema.Type<typeof EmbeddingInput> {}

/** Named exact billable units emitted by an adapter when Effect usage is insufficient. */
const ProviderUsage = Schema.Struct({
	billableUnits: Schema.Record(Schema.NonEmptyString, Schema.BigIntFromString)
});
export const ProviderUsageEncoded = Schema.toEncoded(ProviderUsage);
export interface ProviderUsageEncoded extends Schema.Schema.Type<typeof ProviderUsageEncoded> {}

export const UsageObservation = Schema.Union([
	Schema.toEncoded(Response.Usage),
	ProviderUsageEncoded
]);
export type UsageObservation = typeof UsageObservation.Type;

export const ExactCharge = Schema.Struct({
	currency: Schema.NonEmptyString,
	coefficient: Schema.BigIntFromString,
	scale: Schema.Natural
});
export interface ExactCharge extends Schema.Schema.Type<typeof ExactCharge> {}

export const ProviderObservation = Schema.Struct({
	callId: ProviderCallId,
	provider: Schema.NonEmptyString,
	model: Schema.NonEmptyString,
	operation: Schema.Literals(['language', 'embedding']),
	usage: Schema.optionalKey(UsageObservation),
	charge: Schema.optionalKey(ExactCharge),
	chargeSource: Schema.optionalKey(Schema.Literals(['provider', 'price-table'])),
	pricingVersion: Schema.optionalKey(Schema.NonEmptyString)
});
export interface ProviderObservation extends Schema.Schema.Type<typeof ProviderObservation> {}

/**
 * One model a host will run, and how much it can be given.
 *
 * `contextWindowTokens` is required, not optional. A host that registers a model knows its window —
 * it is the first thing any provider states about one — and the alternative is the runtime guessing.
 * It used to guess: compaction fired at a fixed 64 KB of projected prompt bytes, the same number for
 * every model, which is both wrong for a 32k model and wasteful for a 1M one, and bytes are not
 * tokens in any case. The catalog is the only place that can answer this, so it must.
 */
export const ModelCatalogEntry = Schema.Struct({
	id: ModelId,
	contextWindowTokens: Schema.Natural.check(Schema.isGreaterThan(0))
});
export interface ModelCatalogEntry extends Schema.Schema.Type<typeof ModelCatalogEntry> {}

export const PlanVerdict = Schema.Struct({
	complete: Schema.Boolean,
	summary: Schema.NonEmptyString,
	gaps: Schema.Array(Schema.NonEmptyString)
});
export interface PlanVerdict extends Schema.Schema.Type<typeof PlanVerdict> {}

const JsonObject = Schema.Record(Schema.String, Schema.Json);
export const AIToolDefinition = Schema.Struct({
	name: Schema.NonEmptyString,
	description: Schema.NonEmptyString,
	inputSchema: JsonObject
});
export interface AIToolDefinition extends Schema.Schema.Type<typeof AIToolDefinition> {}
export const AIGenerationOutput = Schema.TaggedUnion({
	Message: { tools: Schema.optionalKey(Schema.Array(AIToolDefinition)) },
	PlanVerdict: {},
	Object: {
		objectName: Schema.NonEmptyString,
		jsonSchema: JsonObject
	}
});
export type AIGenerationOutput = typeof AIGenerationOutput.Type;

export const AIGenerationResult = Schema.TaggedUnion({
	Message: { message: Schema.toEncoded(Prompt.Message) },
	PlanVerdict: { verdict: PlanVerdict },
	Object: { value: Schema.Json }
});
export type AIGenerationResult = typeof AIGenerationResult.Type;

/** Part-boundary snapshots: start placeholders and completed parts, never token deltas. */
export const AIMessageProgress = Schema.Struct({
	callId: ProviderCallId,
	sequence: Schema.Natural,
	message: Schema.toEncoded(Prompt.Message),
	activeParts: Schema.Array(Schema.Natural)
});
export type AIMessageProgress = typeof AIMessageProgress.Type;

/** Awaiting the receiver provides backpressure and acknowledges durable progress delivery. */
export type FacilityProgress = (event: Schema.Json) => Promise<void>;

/** Thin Effect-message/model boundary. It owns no queue, provider dialect, or usage accumulator. */
export const AGENT_TOOL_OUTPUT_LIMIT = 16_384;
export const AIRequest = Schema.TaggedUnion({
	Catalog: {},
	Generate: {
		callId: ProviderCallId,
		/** Stable conversation identity for provider cache affinity across turns and checkpoints. */
		sessionId: Schema.optionalKey(ConversationId),
		toolOutputLimit: Schema.optionalKey(Schema.Literal(AGENT_TOOL_OUTPUT_LIMIT)),
		/** Summarize completed work without spending the summary allowance on optional reasoning. */
		purpose: Schema.optionalKey(Schema.Literal('compaction')),
		modelId: ModelId,
		messages: Schema.Array(Schema.toEncoded(Prompt.Message)),
		/**
		 * A context-fit reservation, not a provider cap.
		 *
		 * The host neither sends `max_tokens` nor truncates a turn to this: a model must be free to
		 * reason and then answer in the same call. The runtime uses it only to reserve space against
		 * the context window when deciding whether a prompt fits.
		 */
		maxOutputTokens: Schema.optionalKey(
			Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0))
		),
		output: AIGenerationOutput,
		imageAssets: Schema.optionalKey(Schema.Array(ImageAsset)),
		fileAssets: Schema.optionalKey(Schema.Array(FileAsset))
	},
	Embed: {
		callId: ProviderCallId,
		modelId: ModelId,
		/** One vector per input, in this order; a batch is one call, not one call per record. */
		inputs: Schema.Array(EmbeddingInput),
		dimensions: Schema.optionalKey(Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)))
	}
});
export type AIRequest = typeof AIRequest.Type;

export const AIResponse = Schema.TaggedUnion({
	Catalog: {
		languageModels: Schema.Array(ModelCatalogEntry),
		defaultLanguageModelId: ModelId,
		embeddingModels: Schema.Array(ModelCatalogEntry),
		defaultEmbeddingModelId: ModelId
	},
	Generated: {
		result: AIGenerationResult,
		observation: ProviderObservation
	},
	Embedded: {
		embeddings: Schema.Array(Schema.Array(Schema.Number)),
		observation: ProviderObservation
	}
});
export type AIResponse = typeof AIResponse.Type;

/**
 * What the runtime asks a host's transport adapters to do.
 *
 * `Send` hands one typed outbound message to the adapter for `transport`, on the binding the host
 * provisioned for `channel`; the message was already validated against `MessageSchemas[transport]`
 * and committed to the channel outbox, so the host performs it and answers with the provider's id.
 * `outboxId` is the idempotency key: a retry of the same outbox row is the same send.
 * `inReplyTo` / `references` are resolved by the runtime from the channel's own history, so an
 * email reply lands in-thread without the host keeping thread state.
 *
 * `Push` is the `inbox` transport's browser push: the runtime owns the ledger and the subscriptions,
 * the host owns the VAPID keys.
 */
export const CommunicationRequest = Schema.TaggedUnion({
	Send: {
		channel: Schema.NonEmptyString,
		transport: Transport,
		outboxId: Schema.NonEmptyString,
		message: Schema.Json,
		inReplyTo: Schema.optionalKey(Schema.NonEmptyString),
		references: Schema.optionalKey(Schema.Array(Schema.NonEmptyString))
	},
	Push: {
		subscription: PushSubscription,
		title: Schema.NonEmptyString,
		body: Schema.String,
		url: Schema.optionalKey(Schema.String)
	}
});
export type CommunicationRequest = typeof CommunicationRequest.Type;

/**
 * Transactional mail: platform mail a workspace needs to function. A host facility, never a channel.
 *
 * `kind` is a closed host union with host-owned templates. No tenant command reaches it and no
 * authored type names it; it has its own provider binding, sending domain and failure mode, apart
 * from every email channel.
 */
export const TransactionalMailKind = Schema.Literals(['sign_in_code', 'workspace_invitation']);
export type TransactionalMailKind = typeof TransactionalMailKind.Type;
export const TransactionalMailRequest = Schema.Struct({
	kind: TransactionalMailKind,
	to: Schema.NonEmptyString,
	locale: Schema.optionalKey(Schema.NonEmptyString),
	data: Schema.Record(Schema.String, Schema.Json)
});
export interface TransactionalMailRequest extends Schema.Schema.Type<
	typeof TransactionalMailRequest
> {}
export const TransactionalMailResponse = Schema.Struct({ id: Schema.optionalKey(Schema.String) });
export interface TransactionalMailResponse extends Schema.Schema.Type<
	typeof TransactionalMailResponse
> {}

/**
 * Who a notification is for: a user id, or `{ team }` — every member of that team at commit time,
 * resolved inside the write's own statement.
 */
export const NotificationRecipient = Schema.Union([
	Schema.NonEmptyString,
	Schema.Struct({ team: Schema.NonEmptyString })
]);
export type NotificationRecipient = typeof NotificationRecipient.Type;
export const CommunicationResponse = Schema.Struct({
	/** The provider's id for what was sent: the key its events and history rows carry. */
	providerMessageId: Schema.optionalKey(Schema.NonEmptyString),
	/** The body exactly as the provider rendered it, for the outbound history row. */
	body: Schema.optionalKey(Schema.String)
});
export interface CommunicationResponse extends Schema.Schema.Type<typeof CommunicationResponse> {}

export const ConnectorRequest = Schema.Struct({
	connector: Schema.NonEmptyString,
	operation: Schema.NonEmptyString,
	input: Schema.Json
});
export interface ConnectorRequest extends Schema.Schema.Type<typeof ConnectorRequest> {}
export const ConnectorResponse = Schema.Struct({ output: Schema.Json });
export interface ConnectorResponse extends Schema.Schema.Type<typeof ConnectorResponse> {}

export const TaskRequest = Schema.TaggedUnion({
	/**
	 * Hands the host a durable callback for the life of this release.
	 *
	 * Routing, and only routing: it says the host may be handed work addressed to `command` for this
	 * release. It used to carry `schedule` and `input` as well, which is how a cron reached the host —
	 * and it is the guest that reads a release's declarations, so the host was being told a thing it
	 * could not act on without learning cron grammar. Schedules now live in the tenant's own
	 * `bolt_schedule`, so those two fields were deleted rather than left looking supported.
	 */
	Register: {
		releaseId: ReleaseId,
		command: Schema.NonEmptyString
	},
	/**
	 * "Come back to me no later than this instant."
	 *
	 * The whole of what a host is told about scheduling, and the reason the facility is a timer API
	 * rather than a queue API. Enqueueing is a row in the tenant's own database, written in the same
	 * transaction as the state change that asked for it — so there is no second place to enqueue,
	 * because the wire cannot express one.
	 *
	 * A host holds one instant per scope and keeps the earliest it has been told; a message naming a
	 * later instant costs it nothing to ignore. The guest sends this *before* the commit that creates
	 * the work, never after: a crash between the message and the commit costs a false alarm — the host
	 * wakes, finds nothing due, re-arms — while a crash the other way round costs a committed job
	 * nobody ever comes back for.
	 *
	 * With an `occurrence` the message also says "this work is already claimed; run it now". The
	 * guest has written the `bolt_task` row in the claimed state (`running`, attempt 1, a lease as
	 * long as a host tick's own deadline) and hands the host exactly what `host.schedules.discover`
	 * would have returned for it, so the host invokes the command and settles the occurrence at once
	 * instead of arming a timer, discovering, and claiming across three more guest hops. The ordering
	 * note inverts for this shape, and for the same reason: the guest writes the claimed row first
	 * and wakes after, so a crash between the two costs a delayed pickup when the lease expires and
	 * the ordinary discover path claims the row, never a lost run and never a doubled one. The
	 * instant carried beside it is that lease expiry, which is the fallback the host arms.
	 */
	Wake: {
		notLaterThanEpochMs: Schema.Number,
		occurrence: Schema.optionalKey(HostScheduleOccurrence)
	},
	/** Associates the current guest invocation with one exact durable task while it is executing. */
	Active: { taskId: Schema.NonEmptyString },
	/** Releases the host's ephemeral task-to-invocation association after the attempt settles. */
	Settled: { taskId: Schema.NonEmptyString },
	/** Accelerates a durable stop by terminating only the invocation running this task. */
	Interrupt: { taskId: Schema.NonEmptyString }
});
export type TaskRequest = typeof TaskRequest.Type;
export const TaskResponse = Schema.Struct({ output: Schema.optionalKey(Schema.Json) });
export interface TaskResponse extends Schema.Schema.Type<typeof TaskResponse> {}

export const HostToolRequest = Schema.Struct({
	tool: Schema.NonEmptyString,
	input: Schema.Json,
	sessionId: Schema.optionalKey(ConversationId)
});
export interface HostToolRequest extends Schema.Schema.Type<typeof HostToolRequest> {}
export const HostToolResponse = Schema.Struct({ output: Schema.Json });
export interface HostToolResponse extends Schema.Schema.Type<typeof HostToolResponse> {}

/** Optional host capabilities, discovered through `capability_catalog` for the authenticated person. */
export const HostToolCatalog = Schema.Struct({
	tools: Schema.Array(
		Schema.Struct({
			name: Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_]*$/)),
			description: Schema.NonEmptyString,
			inputSchema: Schema.JsonObject,
			readOnly: Schema.Boolean
		})
	).check(Schema.isMaxLength(64))
});
export interface HostToolCatalog extends Schema.Schema.Type<typeof HostToolCatalog> {}

/**
 * Identity lifecycle the host may project, never originate.
 *
 * Bolt owns users, invitations, and sessions. Colony keeps only a user → organization map so the
 * organization selector can list workspaces a person already belongs to. These events are that
 * projection's input. They are a facility rather than a channel message because a message is for a
 * person; this is an observation the host stores.
 */
export const IdentityHookRequest = Schema.TaggedUnion({
	UserInvited: {
		invitationId: Schema.NonEmptyString,
		organizationId: Schema.NonEmptyString,
		email: Schema.NonEmptyString,
		invitedBy: Schema.NonEmptyString,
		userId: Schema.optionalKey(Schema.NonEmptyString)
	},
	UserChanged: {
		userId: Schema.NonEmptyString,
		organizationId: Schema.NonEmptyString,
		email: Schema.optionalKey(Schema.NonEmptyString),
		/**
		 * The one team this person now belongs to, or absent for nobody.
		 *
		 * Replaces a `roles` array and a `teams` array. A person holds one team; what that team may do
		 * is declared in the workspace's `+teams.ts` and is not a fact a host needs on the wire.
		 */
		team: Schema.optionalKey(Schema.NonEmptyString)
	},
	MembershipChanged: {
		userId: Schema.NonEmptyString,
		organizationId: Schema.NonEmptyString,
		email: Schema.optionalKey(Schema.NonEmptyString),
		action: Schema.Literals(['joined', 'left', 'team_changed']),
		team: Schema.optionalKey(Schema.NonEmptyString)
	}
});
export type IdentityHookRequest = typeof IdentityHookRequest.Type;
export const IdentityHookResponse = Schema.Struct({ acknowledged: Schema.Boolean });
export interface IdentityHookResponse extends Schema.Schema.Type<typeof IdentityHookResponse> {}

export const TransportFrameKind = Schema.Literals(['text', 'binary']);
export type TransportFrameKind = typeof TransportFrameKind.Type;

export const TransportFrame = Schema.Struct({
	sequence: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
	kind: TransportFrameKind,
	bytes: Schema.Uint8Array,
	cursor: Schema.optionalKey(Schema.NonEmptyString)
});
export interface TransportFrame extends Schema.Schema.Type<typeof TransportFrame> {}

export const TransportRequest = Schema.TaggedUnion({
	Open: {
		topic: Schema.optionalKey(Schema.NonEmptyString)
	},
	Send: {
		connectionId: Schema.NonEmptyString,
		kind: TransportFrameKind,
		bytes: Schema.Uint8Array
	},
	/**
	 * Addresses a topic rather than a connection, so a caller that holds neither can still reach the
	 * clients listening on one.
	 *
	 * `Send` needs a `connectionId`, which is exactly what a stateless Bolt does not have: an
	 * invocation is created for one command and disposed after it, so it never held the connection a
	 * browser opened and has nowhere to remember it. The host does hold them, and knows which belong
	 * to the tenant this invocation is scoped to, so naming the topic is the whole of the address.
	 *
	 * `Publish` lets any invocation fan one application-defined frame out to the clients listening on
	 * that topic. The transport does not interpret the bytes; it only performs the host-owned fan-out.
	 */
	Publish: {
		topic: Schema.NonEmptyString,
		kind: TransportFrameKind,
		bytes: Schema.Uint8Array
	},
	Pull: {
		connectionId: Schema.NonEmptyString,
		afterCursor: Schema.optionalKey(Schema.String),
		maxFrames: Schema.Number.check(
			Schema.isInt(),
			Schema.isGreaterThan(0),
			Schema.isLessThanOrEqualTo(256)
		)
	},
	Close: {
		connectionId: Schema.NonEmptyString,
		reason: Schema.optionalKey(Schema.String)
	}
});
export type TransportRequest = typeof TransportRequest.Type;

export const TransportResponse = Schema.Struct({
	connectionId: Schema.optionalKey(Schema.NonEmptyString),
	frames: Schema.optionalKey(Schema.Array(TransportFrame)),
	closed: Schema.optionalKey(Schema.Boolean),
	/**
	 * How many connections a `Publish` reached. Zero is an ordinary answer — nobody is watching — and
	 * is reported rather than treated as a failure, because a workspace with no open tab is the common
	 * case and must not look like a broken transport.
	 */
	delivered: Schema.optionalKey(
		Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
	)
});
export interface TransportResponse extends Schema.Schema.Type<typeof TransportResponse> {}

/**
 * A durable internal mutation crossing back to the host while its originating invocation is still
 * alive. Browser mutations return their change list with the command response; long-running agent,
 * automation, and hook invocations need this commit hook so each committed step can fan out now.
 */
export const SyncCommitRequest = ChangeBatch;
export interface SyncCommitRequest extends Schema.Schema.Type<typeof SyncCommitRequest> {}
/** Completion of the facility call is the acknowledgement that host delivery settled. */
export const SyncCommitResponse = Schema.Struct({});
export interface SyncCommitResponse extends Schema.Schema.Type<typeof SyncCommitResponse> {}

/**
 * Every host facility uses this call shape. Colony and bolt-server bind physical
 * effects here; Bolt capabilities (channels, sync, automations) only invoke it.
 */
export type FacilityBinding<Input, Output> = Readonly<{
	readonly call: (
		metadata: FacilityCall,
		input: Input,
		signal: AbortSignal,
		onProgress?: FacilityProgress
		// repository-health:allow EFF2 -- Host facilities are transport adapters supplied by arbitrary runtimes; Bolt converts every call into Effect at invokeBinding.
	) => Promise<FacilityResult<Output>>;
}>;

/**
 * What the runtime may ask the host for: one configuration key.
 *
 * The runtime describes the key it needs and the host supplies the value or says it has none —
 * nothing here assumes an environment, because the bundle can run inside a sandbox that has no
 * `process` at all. The host decides which keys exist and what a read of an unknown one means;
 * the runtime asks by name and treats "no value" as the absence it already knows how to fail
 * closed on.
 */
export const ConfigRequest = Schema.Struct({ key: Schema.NonEmptyString });
export type ConfigRequest = typeof ConfigRequest.Type;
export const ConfigResponse = Schema.Struct({
	/** Absent means the host has no value for this key — not an error, but a refusal to authorize. */
	value: Schema.optionalKey(Schema.String)
});
export interface ConfigResponse extends Schema.Schema.Type<typeof ConfigResponse> {}

export type FacilityBindings = Readonly<{
	readonly scope: InvocationScope;
	readonly database?: FacilityBinding<DatabaseRequest, DatabaseResponse>;
	readonly files?: FacilityBinding<FileRequest, FileResponse>;
	readonly ai?: FacilityBinding<AIRequest, AIResponse>;
	readonly communication?: FacilityBinding<CommunicationRequest, CommunicationResponse>;
	readonly mail?: FacilityBinding<TransactionalMailRequest, TransactionalMailResponse>;
	readonly connector?: FacilityBinding<ConnectorRequest, ConnectorResponse>;
	readonly tasks?: FacilityBinding<TaskRequest, TaskResponse>;
	readonly hostTools?: FacilityBinding<HostToolRequest, HostToolResponse>;
	readonly identityHooks?: FacilityBinding<IdentityHookRequest, IdentityHookResponse>;
	readonly transport?: FacilityBinding<TransportRequest, TransportResponse>;
	/** Host-internal live-query commit hook; never an authored capability or manifest requirement. */
	readonly syncCommit?: FacilityBinding<SyncCommitRequest, SyncCommitResponse>;
	readonly config?: FacilityBinding<ConfigRequest, ConfigResponse>;
}>;

/** Owns immutable facility-call correlation metadata assembly. */
const FacilityCalls = {
	forEffect: (call: Omit<FacilityCall, 'effectId'>, effectId: EffectId): FacilityCall => ({
		...call,
		effectId
	})
};
export const facilityCallFor = FacilityCalls.forEffect;
