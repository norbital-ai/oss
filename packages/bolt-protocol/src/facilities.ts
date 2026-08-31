import { Schema } from 'effect';
import { InvocationScope } from './invocation.js';
import { SyncChange } from './sync.js';
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

/** Provider-neutral controls for a model-operated web search. */
export const AIWebSearch = Schema.Struct({
	maxResults: Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 25 })),
	allowedDomains: Schema.optionalKey(Schema.Array(Schema.NonEmptyString))
});
export interface AIWebSearch extends Schema.Schema.Type<typeof AIWebSearch> {}

/**
 * One workspace-owned image that the trusted host resolves immediately before an AI provider call.
 *
 * The object-store key is deliberately carried instead of the bytes. Tenant code runs behind a
 * bounded facility bridge; base64-expanding a photograph inside that bridge both spends isolate CPU
 * and turns an ordinary 1 MiB JPEG into a request larger than the bridge's 1 MiB ceiling. The host
 * already owns the tenant scope and the file facility, so it is the only correct place to resolve
 * the key and construct the provider's data URL.
 */
export const AIImageAsset = Schema.Struct({
	key: Schema.NonEmptyString,
	name: Schema.NonEmptyString,
	mimeType: Schema.NonEmptyString,
	size: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
	detail: Schema.optionalKey(Schema.Literals(['auto', 'low', 'high']))
});
export interface AIImageAsset extends Schema.Schema.Type<typeof AIImageAsset> {}

/** Provider-neutral content part expanded by the host before the request reaches an AI adapter. */
export const AIImageAssetPart = Schema.Struct({
	type: Schema.Literal('image_asset'),
	image_asset: AIImageAsset
});
export interface AIImageAssetPart extends Schema.Schema.Type<typeof AIImageAssetPart> {}

export const AIRequest = Schema.TaggedUnion({
	Models: {},
	Turn: {
		model: Schema.NonEmptyString,
		/** Pinned TanStack ModelMessage values plus mechanical system-prompt wire entries. */
		messages: Schema.Array(Schema.Json),
		tools: Schema.Array(Schema.Json),
		maxOutputTokens: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
		webSearch: Schema.optionalKey(AIWebSearch),
		responseSchema: Schema.optionalKey(Schema.Json)
	},
	/**
	 * One embedding call over multimodal inputs.
	 *
	 * `inputs` carries OpenAI-compatible content-part arrays — a `text` part, an `image_url` part
	 * with a `data:` URL, or both — so one request can embed a photograph, a caption, or the two
	 * jointly. `dimensions` asks the provider for a truncated vector when the model supports
	 * Matryoshka output; the provider's default dimensionality is used when it is absent.
	 */
	Embed: {
		model: Schema.NonEmptyString,
		inputs: Schema.Array(Schema.Json),
		dimensions: Schema.optionalKey(Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)))
	}
});
export type AIRequest = typeof AIRequest.Type;

/**
 * What one model call consumed, as the host that paid for it reported.
 *
 * Provider adapters normalise their dialect before crossing the facility boundary. The wire uses
 * this schema directly, so every consumer receives the same typed record and no downstream caller
 * has to repair an `unknown` provider response.
 *
 * `costUsd` is the provider's own charge, never a figure derived from token counts and a price list:
 * a number a reader takes for a bill has to be the bill. Token counts travel beside it because they
 * are what makes the charge auditable, and because the panel needs input tokens to say how much of
 * the context window a conversation is occupying.
 */
export const AIUsage = Schema.Struct({
	// Non-exact optional so the normaliser can hold an absent field as an explicit `undefined`; the
	// wire never carries those, and it is the normaliser that decides presence, not the reader.
	model: Schema.optional(Schema.String),
	inputTokens: Schema.optional(Schema.Natural),
	cachedInputTokens: Schema.optional(Schema.Natural),
	outputTokens: Schema.optional(Schema.Natural),
	reasoningTokens: Schema.optional(Schema.Natural),
	totalTokens: Schema.optional(Schema.Natural),
	costUsd: Schema.optional(
		Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0))
	),
	/**
	 * What the host will charge its tenant for this call, in millionths of one major currency unit.
	 *
	 * Separate from `costUsd` because they are different facts. `costUsd` is what the provider took;
	 * this is what the tenant owes, and a host billing in another currency does not make them the
	 * same number — showing the provider's figure to the person paying understates it silently.
	 * Micro-units rather than cents because one agent turn routinely costs a fraction of a cent.
	 *
	 * Absent when the host has no rate card of its own, in which case the provider charge is the only
	 * honest figure there is and consumers fall back to it.
	 */
	costMicroUnits: Schema.optional(Schema.Natural),
	/** ISO 4217 code the charge above is denominated in. Meaningless without the micro-unit amount. */
	costCurrency: Schema.optional(Schema.NonEmptyString)
});
export interface AIUsage extends Schema.Schema.Type<typeof AIUsage> {}

/** First finite non-negative number among the spellings one provider field is known by. */
const usageNumber = (
	source: Readonly<Record<string, unknown>>,
	keys: ReadonlyArray<string>
): number | undefined => {
	for (const key of keys) {
		const value = source[key];
		if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
	}
	return undefined;
};

const usageNatural = (
	source: Readonly<Record<string, unknown>>,
	keys: ReadonlyArray<string>
): number | undefined => {
	const value = usageNumber(source, keys);
	return value !== undefined && Number.isSafeInteger(value) ? value : undefined;
};

const usageRecord = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
	typeof value === 'object' && value !== null && !Array.isArray(value)
		? (value as Readonly<Record<string, unknown>>)
		: undefined;

/**
 * Normalises a provider response to the canonical record above.
 *
 * Providers spell the same three numbers at least three ways each, and OpenAI-compatible endpoints
 * nest them under `usage` while some gateways hoist them to the top level. Normalising here is what
 * lets the runtime, the meter, and the panel agree on one record instead of each learning the
 * dialects separately. Only the provider adapter calls this; the facility wire itself is typed.
 *
 * Returns `undefined` when nothing usage-shaped is present. That is not zero: a turn whose usage was
 * never reported is a turn whose cost is unknown, and the two must not read alike.
 */
export const readAIUsage = (value: unknown): AIUsage | undefined => {
	const outer = usageRecord(value);
	if (outer === undefined) return undefined;
	const inner = usageRecord(outer['usage']) ?? outer;
	const details =
		usageRecord(inner['prompt_tokens_details']) ?? usageRecord(inner['inputTokensDetails']);
	const completion =
		usageRecord(inner['completion_tokens_details']) ?? usageRecord(inner['outputTokensDetails']);
	const inputTokens = usageNatural(inner, [
		'inputTokens',
		'input_tokens',
		'promptTokens',
		'prompt_tokens'
	]);
	const outputTokens = usageNatural(inner, [
		'outputTokens',
		'output_tokens',
		'completionTokens',
		'completion_tokens'
	]);
	const computedTotal = (inputTokens ?? 0) + (outputTokens ?? 0);
	const totalTokens = usageNatural(inner, ['totalTokens', 'total_tokens']) ??
		(inputTokens === undefined && outputTokens === undefined || !Number.isSafeInteger(computedTotal)
			? undefined
			: computedTotal);
	const cachedInputTokens =
		usageNatural(inner, ['cachedInputTokens', 'cached_input_tokens']) ??
		(details === undefined ? undefined : usageNatural(details, ['cachedTokens', 'cached_tokens']));
	const reasoningTokens =
		usageNatural(inner, ['reasoningTokens', 'reasoning_tokens']) ??
		(completion === undefined
			? undefined
			: usageNatural(completion, ['reasoningTokens', 'reasoning_tokens']));
	const costUsd = usageNumber(inner, ['costUsd', 'cost_usd', 'cost', 'totalCost', 'total_cost']);
	// Read only under its canonical name: no provider reports what *this host* charges, so a dialect
	// list here would be inviting some field of the provider's to be mistaken for the tenant's bill.
	const reportedCostMicroUnits = usageNatural(inner, ['costMicroUnits']);
	const costCurrency =
		typeof inner['costCurrency'] === 'string' && inner['costCurrency'].length > 0
			? inner['costCurrency']
			: undefined;
	const costMicroUnits = costCurrency === undefined ? undefined : reportedCostMicroUnits;
	const model =
		typeof inner['model'] === 'string'
			? inner['model']
			: typeof outer['model'] === 'string'
				? outer['model']
				: undefined;
	const usage: AIUsage = {
		model,
		inputTokens,
		cachedInputTokens,
		outputTokens,
		reasoningTokens,
		totalTokens,
		costUsd,
		costMicroUnits,
		// The charge's denomination is only meaningful beside the charge itself; without a rate card
		// there is nothing to label.
		costCurrency: costMicroUnits === undefined ? undefined : costCurrency
	};
	return Object.values(usage).every((value) => value === undefined) ? undefined : usage;
};

/**
 * Adds one turn's usage to a running total.
 *
 * A conversation's spend is the sum of every model call it caused, including the ones its subagents
 * made, so the accumulator is the shape that has to be depth-agnostic: callers fold child totals in
 * exactly as they fold their own turns. `model` is dropped on purpose — a total spanning two models
 * has no single model, and reporting the last one would be a lie a reader could act on.
 */
export const addAIUsage = (
	total: AIUsage | undefined,
	next: AIUsage | undefined
): AIUsage | undefined => {
	const validateUsage = (usage: AIUsage | undefined) => {
		if (usage === undefined) return;
		for (const field of ['inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningTokens',
			'totalTokens', 'costMicroUnits'] as const) {
			const value = usage[field];
			if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
				throw new TypeError(`AI usage ${field} must be a non-negative safe integer`);
			}
		}
		if (usage.costUsd !== undefined && (!Number.isFinite(usage.costUsd) || usage.costUsd < 0)) {
			throw new TypeError('AI provider cost must be a finite non-negative USD amount');
		}
		const hasAmount = usage.costMicroUnits !== undefined;
		const hasCurrency = usage.costCurrency !== undefined;
		if (hasAmount !== hasCurrency) throw new TypeError('AI tenant charge requires both amount and currency');
	};
	validateUsage(total);
	validateUsage(next);
	if (next === undefined) return total;
	if (total === undefined) return { ...next };
	const sum = (left: number | undefined, right: number | undefined): number | undefined =>
		left === undefined && right === undefined ? undefined : (left ?? 0) + (right ?? 0);
	const naturalSum = (left: number | undefined, right: number | undefined): number | undefined => {
		const value = sum(left, right);
		if (value !== undefined && !Number.isSafeInteger(value)) {
			throw new TypeError('AI usage total exceeds the exact integer range');
		}
		return value;
	};
	const inputTokens = naturalSum(total.inputTokens, next.inputTokens);
	const cachedInputTokens = naturalSum(total.cachedInputTokens, next.cachedInputTokens);
	const outputTokens = naturalSum(total.outputTokens, next.outputTokens);
	const reasoningTokens = naturalSum(total.reasoningTokens, next.reasoningTokens);
	const totalTokens = naturalSum(total.totalTokens, next.totalTokens);
	const costUsd = sum(total.costUsd, next.costUsd);
	const costMicroUnits = naturalSum(total.costMicroUnits, next.costMicroUnits);
	if (total.costCurrency !== undefined && next.costCurrency !== undefined &&
		total.costCurrency !== next.costCurrency) {
		throw new TypeError(`Cannot add AI tenant charges in ${total.costCurrency} and ${next.costCurrency}`);
	}
	const costCurrency =
		total.costCurrency ?? next.costCurrency;
	return {
		inputTokens,
		cachedInputTokens,
		outputTokens,
		reasoningTokens,
		totalTokens,
		costUsd,
		costMicroUnits,
		costCurrency: costMicroUnits === undefined ? undefined : costCurrency
	};
};

export const AIResponse = Schema.Struct({
	output: Schema.Json,
	usage: Schema.optionalKey(AIUsage)
});
export interface AIResponse extends Schema.Schema.Type<typeof AIResponse> {}

export const CommunicationRequest = Schema.TaggedUnion({
	VerifyInbound: { channel: Schema.NonEmptyString, envelope: Schema.Json },
	Send: { channel: Schema.NonEmptyString, recipient: Schema.NonEmptyString, payload: Schema.Json },
	Notify: { recipient: Schema.NonEmptyString, payload: Schema.Json },
	Wake: { topic: Schema.NonEmptyString }
});
export type CommunicationRequest = typeof CommunicationRequest.Type;
/**
 * The payload shape a workspace puts on a *channel* send, so the host reads the same field nobody
 * has to guess: the text, and the provider key of the message this one rewrites in place.
 *
 * Email keeps `Schema.Json` — its rendering is the host mailer's business, and the OTP mail it
 * re-templates has its own shapes.
 */
export const ChannelSendPayload = Schema.Struct({
	text: Schema.NonEmptyString,
	updateOf: Schema.optionalKey(Schema.NonEmptyString),
	/**
	 * An action link the host renders against its public origin.
	 *
	 * Bolt owns the claim and its lifetime; Colony owns the address at which its browser surface is
	 * served. Keeping those two facts separate prevents a tenant bundle from guessing a deployment
	 * hostname while still preventing the host from minting or extending a claim.
	 */
	registration: Schema.optionalKey(
		Schema.Struct({
			claimId: Schema.NonEmptyString,
			expiresInMinutes: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0))
		})
	)
});
export type ChannelSendPayload = Schema.Schema.Type<typeof ChannelSendPayload>;
export const CommunicationResponse = Schema.Struct({ receipt: Schema.optionalKey(Schema.Json) });
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
	 */
	Wake: { notLaterThanEpochMs: Schema.Number },
	/** Associates the current guest invocation with one exact durable task while it is executing. */
	Active: { taskId: Schema.NonEmptyString },
	/** Releases the host's ephemeral task-to-invocation association after the attempt settles. */
	Settled: { taskId: Schema.NonEmptyString },
	/** Accelerates a durable stop by terminating only the invocation running this task. */
	Interrupt: { taskId: Schema.NonEmptyString },
	/**
	 * Runs one already-admitted delegated agent turn through a fresh host Conductor invocation.
	 * The host learns no agent semantics; it routes these two durable coordinates to the typed
	 * `host.agents.executeChild` command and returns that command's JSON answer.
	 */
	Delegate: {
		conversationId: Schema.NonEmptyString,
		turnId: Schema.NonEmptyString
	}
});
export type TaskRequest = typeof TaskRequest.Type;
export const TaskResponse = Schema.Struct({ output: Schema.optionalKey(Schema.Json) });
export interface TaskResponse extends Schema.Schema.Type<typeof TaskResponse> {}

export const HostToolRequest = Schema.Struct({ tool: Schema.NonEmptyString, input: Schema.Json });
export interface HostToolRequest extends Schema.Schema.Type<typeof HostToolRequest> {}
export const HostToolResponse = Schema.Struct({ output: Schema.Json });
export interface HostToolResponse extends Schema.Schema.Type<typeof HostToolResponse> {}

/**
 * Identity lifecycle the host may project, never originate.
 *
 * Bolt owns users, invitations, and sessions. Colony keeps only a user → organization map so the
 * organization selector can list workspaces a person already belongs to. These events are that
 * projection's input. They are a facility rather than `Communication.Notify` because Notify is a
 * message to a person; this is an observation the host stores.
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
export const SyncCommitRequest = Schema.Struct({ changes: Schema.Array(SyncChange) });
export interface SyncCommitRequest extends Schema.Schema.Type<typeof SyncCommitRequest> {}
export const SyncCommitResponse = Schema.Struct({ accepted: Schema.Boolean });
export interface SyncCommitResponse extends Schema.Schema.Type<typeof SyncCommitResponse> {}

/**
 * Every host facility uses this call shape. Colony and bolt-server bind physical
 * effects here; Bolt capabilities (channels, sync, automations) only invoke it.
 */
export type FacilityBinding<Input, Output> = Readonly<{
	readonly call: (
		metadata: FacilityCall,
		input: Input,
		signal: AbortSignal
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
