import type { ImportStart } from '../../src/protocol/schema.ts';
// Type corpus for the engine service contracts (K2): each pinned member's parameters and answer, exactly. Never run,
// only checked (`tsgo -p tests/tsconfig.json`): a Shape that drifts from its pin is a type error on its line.
import type { Effect, Option, Result, Stream } from 'effect';
import type { Json } from '../../src/decl/values.ts';
import type { FacilityFailure, Unavailable } from '../../src/decl/errors.ts';
import type { Frame } from '../../src/protocol/schema.ts';
import type { Pred } from '@norbital-ai/store';
import type { ReadIR } from '../../src/protocol/reads.ts';
import type {
	AiRequest,
	AiResponse,
	Authority,
	Bindings,
	Captured,
	CronEntry,
	CronFired,
	CrossAnswer,
	DriverEvent,
	GuestOutcome,
	Invocation,
	Outcome,
	QueuedRun,
	Reader
} from '../../src/engine/contracts.ts';
import type { EngineError, IdentityRefusal } from '../../src/engine/errors.ts';
import type { BoltError } from '../../src/protocol/errors.ts';
import type { EngineManifest } from '../../src/engine/manifest.ts';
import type { Holder } from '../../src/engine/access/authority.ts';
import type { DeliveryReport } from '../../src/engine/conversations/status.ts';
import type { DecisionResult } from '../../src/engine/decisions/index.ts';
import type { Chain } from '../../src/engine/write/sql.ts';
import type { Verb } from '../../src/engine/write/act.ts';
import type { DeadlineTimer, DeadlineEntry } from '../../src/engine/runs/deadlines.ts';
import type { OpenAiChat } from '../../src/engine/agent/openai-chat.ts';
import type { AiEvent } from '../../src/engine/ports.ts';
import type { PortFailure } from '../../src/engine/port.ts';
import type { Syncs, SyncsShape } from '../../src/engine/sync/index.ts';
import type {
	ActMode,
	ActRequest,
	ActResult,
	Agents,
	AgentsShape,
	Approvals,
	ApprovalsShape,
	Authenticated,
	Bridge,
	Callable,
	Callables,
	CallablesShape,
	CallResult,
	Conversations,
	ConversationsShape,
	CrossCall,
	Deadlines,
	DeadlinesShape,
	Decisions,
	DecisionsShape,
	Enqueue,
	Envoys,
	EnvoysShape,
	Facilities,
	FacilitiesShape,
	FacilityCall,
	Guest,
	GuestShape,
	Identity,
	IdentityShape,
	Links,
	LinksShape,
	Live,
	LiveShape,
	LiveView,
	Manifest,
	MessageStore,
	Outbound,
	OutboundShape,
	OwnPredSql,
	ParseCallable,
	Reads,
	ReadsShape,
	RetrySpec,
	RunHandler,
	RunHandlers,
	RunHandlersShape,
	Runs,
	RunsShape,
	RunTime,
	ShapeOf,
	Telemetry,
	TelemetryShape,
	TurnResult,
	Turns,
	TurnsShape,
	TurnVia,
	Wake,
	WakeShape,
	Writes,
	WritesShape
} from '../../src/engine/services.ts';

type Eq<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
declare const is: <T extends true>() => T;
type Args<F> = F extends (...args: infer A) => unknown ? A : never;
type Answer<F> = F extends (...args: never[]) => infer R ? R : never;

// ── every tag carries its Shape ──
is<Eq<ShapeOf<typeof Reads>, ReadsShape>>();
is<Eq<ShapeOf<typeof Writes>, WritesShape>>();
is<Eq<ShapeOf<typeof Callables>, CallablesShape>>();
is<Eq<ShapeOf<typeof Approvals>, ApprovalsShape>>();
is<Eq<ShapeOf<typeof Decisions>, DecisionsShape>>();
is<Eq<ShapeOf<typeof Identity>, IdentityShape>>();
is<Eq<ShapeOf<typeof Live>, LiveShape>>();
is<Eq<ShapeOf<typeof Runs>, RunsShape>>();
is<Eq<ShapeOf<typeof RunHandlers>, RunHandlersShape>>();
is<Eq<ShapeOf<typeof Deadlines>, DeadlinesShape>>();
is<Eq<ShapeOf<typeof Wake>, WakeShape>>();
is<Eq<ShapeOf<typeof Conversations>, ConversationsShape>>();
is<Eq<ShapeOf<typeof Envoys>, EnvoysShape>>();
is<Eq<ShapeOf<typeof Turns>, TurnsShape>>();
is<Eq<ShapeOf<typeof Agents>, AgentsShape>>();
is<Eq<ShapeOf<typeof Links>, LinksShape>>();
is<Eq<ShapeOf<typeof Syncs>, SyncsShape>>();
is<Eq<ShapeOf<typeof Outbound>, OutboundShape>>();
is<Eq<ShapeOf<typeof Facilities>, FacilitiesShape>>();
is<Eq<ShapeOf<typeof Guest>, GuestShape>>();
is<Eq<ShapeOf<typeof Telemetry>, TelemetryShape>>();
is<Eq<ShapeOf<typeof Manifest>, EngineManifest>>();

// ── reads ──
is<
	Eq<
		Args<ReadsShape['run']>,
		[
			batch: readonly ReadIR[],
			reader: Reader,
			bindings: Bindings,
			from?: 'Client' | 'Server' | undefined
		]
	>
>();
is<Eq<Answer<ReadsShape['run']>, Effect.Effect<readonly Json[], EngineError>>>();

// ── writes: one request, its mode a tagged union decided once, no hook-only fields ──
is<Eq<Args<WritesShape['act']>, [request: ActRequest]>>();
is<Eq<Answer<WritesShape['act']>, Effect.Effect<ActResult, EngineError>>>();
is<Eq<ActMode['_tag'], 'Direct' | 'Sync' | 'Record'>>();
is<
	Eq<
		keyof ActRequest,
		| 'collection'
		| 'verb'
		| 'input'
		| 'mode'
		| 'key'
		| 'issuedAt'
		| 'retry'
		| 'authority'
		| 'bindings'
		| 'invocationId'
		| 'observed'
		| 'onConflict'
		| 'rate'
		| 'restored'
		| 'readGuards'
	>
>();
is<
	Eq<
		ActResult,
		{
			readonly readGuardsConsumed?: true;
			readonly outcome: Outcome;
			readonly captured: readonly Captured[];
			readonly v: number;
		}
	>
>();

// ── callables ──
is<Eq<Callable['_tag'], 'Verb' | 'Automation' | 'Sync'>>();
is<Eq<'action' extends keyof CallablesShape ? true : false, false>>();
is<
	Eq<
		Extract<Callable, { _tag: 'Verb' }>,
		{ readonly _tag: 'Verb'; readonly collection: string; readonly verb: Verb }
	>
>();
is<Eq<Answer<CallablesShape['acts']>, Effect.Effect<CallResult, EngineError>>>();
is<Eq<Answer<CallablesShape['query']>, Effect.Effect<Json, EngineError>>>();
is<
	Eq<
		ParseCallable,
		(callable: string, manifest: EngineManifest) => Result.Result<Callable, BoltError>
	>
>();

// ── identity ──
is<Eq<Args<IdentityShape['authenticate']>, [token: string]>>();
is<Eq<Answer<IdentityShape['authenticate']>, Effect.Effect<Authenticated, IdentityRefusal>>>();
is<Eq<Args<IdentityShape['authority']>, [holder: Holder, key?: string | undefined]>>();

// ── live: publish stays synchronous; a connection is a stream ──
is<Eq<LiveShape['publish'], (captured: readonly Captured[]) => number>>();
is<Eq<Answer<LiveShape['connect']>, Stream.Stream<Frame>>>();
is<Eq<Args<LiveShape['register']>, [conn: string, view: string, read: LiveView]>>();
is<Eq<Answer<LiveShape['register']>, Effect.Effect<void, EngineError>>>();
is<Eq<Answer<LiveShape['authorityOf']>, Effect.Effect<Option.Option<Authority>>>>();

// ── runs, handlers, the bottom services ──
is<Eq<WakeShape, { readonly at: (at: string) => Effect.Effect<void> }>>();
is<Eq<Args<TurnsShape['drain']>, [conversation: string, via: TurnVia]>>();
is<Eq<TurnVia, 'Agent' | 'Envoy'>>();
is<
	Eq<
		RunHandler,
		(
			input: Json,
			run: { readonly id: string; readonly starter: Holder | null }
		) => Effect.Effect<Json, EngineError>
	>
>();
is<
	Eq<
		Args<RunHandlersShape['register']>,
		[
			handlers: { readonly [name: string]: RunHandler },
			retries?: { readonly [name: string]: RetrySpec } | undefined
		]
	>
>();
is<Eq<Answer<RunHandlersShape['handler']>, Effect.Effect<Option.Option<RunHandler>>>>();
is<Eq<RunsShape['tick'], Effect.Effect<void, EngineError>>>();
is<Eq<RunsShape['crons'], Effect.Effect<readonly CronEntry[]>>>();
is<Eq<RunsShape['fire'], (id: string, slot: string) => Effect.Effect<CronFired, EngineError>>>();
is<Eq<DeadlinesShape['announce'], (notLaterThan: string) => Effect.Effect<void>>>();

// ── links, syncs, outbound ──
is<Eq<keyof LinksShape, 'open' | 'close' | 'changed' | 'typing' | 'status' | 'send' | 'request'>>();
is<Eq<Answer<LinksShape['typing']>, Effect.Effect<void, FacilityFailure | Unavailable>>>();
is<Eq<keyof OutboundShape, 'deliver' | 'delivered' | 'replied' | 'activate' | 'handlers'>>();
is<
	Eq<
		Args<OutboundShape['delivered']>,
		[instance: string, providerId: string, report: DeliveryReport]
	>
>();
is<Eq<Answer<OutboundShape['delivered']>, Effect.Effect<Option.Option<Outcome>, EngineError>>>();
is<Eq<Args<SyncsShape['invalidate']>, [instance: string, sync: string, partition: string]>>();
is<Eq<keyof ApprovalsShape, 'decide' | 'view' | 'list'>>();
is<
	Eq<
		Args<ConversationsShape['receive']>,
		[
			instance: string,
			event: Exclude<DriverEvent, { kind: 'invalidate' }>,
			expectedImportStart?: ImportStart | null | undefined
		]
	>
>();
is<Eq<EnvoysShape['settled'], Effect.Effect<void>>>();
is<Eq<Answer<AgentsShape['drain']>, Effect.Effect<TurnResult, EngineError>>>();

// ── guest crossings ──
is<Eq<Args<GuestShape['invoke']>, [invocation: Invocation, bridge: Bridge]>>();
is<Eq<Answer<GuestShape['invoke']>, Effect.Effect<GuestOutcome>>>();
is<
	Eq<
		Bridge,
		{ readonly cross: (calls: readonly CrossCall[]) => Effect.Effect<readonly CrossAnswer[]> }
	>
>();
is<
	Eq<
		Exclude<CrossCall['_tag'], FacilityCall['_tag']>,
		| 'read'
		| 'act'
		| 'acts'
		| 'schedule'
		| 'notify'
		| 'send'
		| 'request'
		| 'progress'
		| 'transactionBegin'
		| 'transactionRead'
		| 'transactionAct'
		| 'transactionFinish'
		| 'transactionAbort'
	>
>();
is<
	Eq<
		FacilityCall['_tag'] extends `${'web' | 'files' | 'convert' | 'ai' | 'geo'}.${string}`
			? true
			: false,
		true
	>
>();
is<Eq<Extract<CrossCall, { _tag: 'act' }>['callable'], Callable>>();

// ── facilities, decisions ──
is<Eq<keyof FacilitiesShape, 'dispatch' | 'fileLoader' | 'loggedTransport'>>();
is<Eq<Answer<FacilitiesShape['dispatch']>, Effect.Effect<CrossAnswer>>>();
is<
	Eq<Answer<DecisionsShape['decide']>, Effect.Effect<DecisionResult, FacilityFailure | Unavailable>>
>();

// ── pinned helpers ──
is<
	Eq<Enqueue, (chain: Chain, rows: readonly QueuedRun[] | { readonly select: string }) => string>
>();
is<Eq<keyof RunTime, 'duration' | 'offsetMs' | 'dueAt' | 'backoffMs' | 'BUCKET_MS'>>();
is<Eq<RunTime['dueAt'], (now: number, at: number) => number>>();
is<
	Eq<keyof MessageStore, 'post' | 'claim' | 'stream' | 'settle' | 'cancel' | 'deliver' | 'mark'>
>();
is<Eq<OwnPredSql, (pred: Pred, row: string, chain: Chain, twoValued: boolean) => string>>();

// ── native deadline and streaming AI signatures ──
is<Eq<DeadlineTimer<string>['takeDue'], Effect.Effect<DeadlineEntry<string> | undefined>>>();
is<Eq<Answer<DeadlineTimer<string>['announce']>, Effect.Effect<boolean>>>();
// AI is a native stream; cancellation belongs to its consuming fiber.
declare const chat: OpenAiChat;
declare const request: AiRequest;
export const streamed: Stream.Stream<AiEvent, PortFailure> = chat(request);
// @ts-expect-error cancellation is native; chat exposes no Promise overload
chat(request, AbortSignal.timeout(1));
// @ts-expect-error an AI stream has no Promise facet
const promised: PromiseLike<AiResponse> = chat(request);
void promised;
