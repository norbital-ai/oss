// repository-health:allow SEM_PARALLEL -- services consumes database's binding/invocation port
// (CallContext, invokeBinding) over the #lib alias, so the pair is linked, not parallel.
import { Context, Effect, Layer, Ref, Schema } from 'effect';
import { AIMessageProgress, compactSyncChanges, EffectId } from '@norbital-ai/bolt-protocol';
import type {
	AIRequest,
	AIResponse,
	CommunicationRequest,
	CommunicationResponse,
	ConnectorRequest,
	ConnectorResponse,
	FacilityBinding,
	FileRequest,
	FileResponse,
	HostToolRequest,
	HostToolResponse,
	IdentityHookRequest,
	IdentityHookResponse,
	SyncChange,
	SyncCommitRequest,
	SyncCommitResponse,
	TaskRequest,
	TaskResponse,
	TransportRequest,
	TransportResponse
} from '@norbital-ai/bolt-protocol';
import {
	type CallContext,
	FacilityError as BoundFacilityError,
	invokeBinding
} from '#lib/runtime/facilities/database.js';

type AICatalogRequest = Extract<AIRequest, { readonly _tag: 'Catalog' }>;
type AIGenerateRequest = Extract<AIRequest, { readonly _tag: 'Generate' }>;
type AIEmbedRequest = Extract<AIRequest, { readonly _tag: 'Embed' }>;
type AICatalogResponse = Extract<AIResponse, { readonly _tag: 'Catalog' }>;
type AIGeneratedResponse = Extract<AIResponse, { readonly _tag: 'Generated' }>;
type AIEmbeddedResponse = Extract<AIResponse, { readonly _tag: 'Embedded' }>;

/** AI capability bound by the host for one invocation context. */
export type AIInterface = Readonly<{
	readonly catalog: (
		effectId: EffectId,
		request: AICatalogRequest
	) => Effect.Effect<AICatalogResponse, BoundFacilityError>;
	readonly generate: <ProgressError = never>(
		effectId: EffectId,
		request: AIGenerateRequest,
		onProgress?: (progress: AIMessageProgress) => Effect.Effect<void, ProgressError>
	) => Effect.Effect<AIGeneratedResponse, BoundFacilityError>;
	readonly embed: (
		effectId: EffectId,
		request: AIEmbedRequest
	) => Effect.Effect<AIEmbeddedResponse, BoundFacilityError>;
}>;
/** Identifies the facilities service in Effect's context so dependency wiring remains explicit and type checked. */
const AIService = Context.Service<AIInterface>('@norbital-ai/bolt/AI');
const AILayers = {
	make: (binding: FacilityBinding<AIRequest, AIResponse> | undefined, context: CallContext) =>
		Layer.succeed(
			AIService,
			(() => {
				const invoke = (id: EffectId, request: AIRequest) =>
					invokeBinding('ai', binding, context, id, request);
				const unexpected = (expected: AIResponse['_tag'], actual: AIResponse['_tag']) =>
					new BoundFacilityError({
						operation: 'ai',
						code: 'invalid_ai_response',
						message: `AI facility returned ${actual}; ${expected} was required`,
						retryable: false,
						outcome: 'known'
					});
				return AIService.of({
					catalog: Effect.fn('AI.catalog')((id, request) =>
						invoke(id, request).pipe(
							Effect.flatMap((response) =>
								response._tag === 'Catalog'
									? Effect.succeed(response)
									: Effect.fail(unexpected('Catalog', response._tag))
							)
						)
					),
					generate: Effect.fn('AI.generate')(function* (id, request, onProgress) {
						const services = yield* Effect.context<never>();
						return yield* invokeBinding(
							'ai',
							binding,
							context,
							id,
							request,
							onProgress === undefined
								? undefined
								: (event, signal) =>
										Effect.runPromiseWith(services)(
											Schema.decodeUnknownEffect(AIMessageProgress)(event).pipe(
												Effect.flatMap(onProgress)
											),
											{ signal }
										)
						).pipe(
							Effect.flatMap((response) =>
								response._tag === 'Generated'
									? Effect.succeed(response)
									: Effect.fail(unexpected('Generated', response._tag))
							)
						);
					}),
					embed: Effect.fn('AI.embed')((id, request) =>
						invoke(id, request).pipe(
							Effect.flatMap((response) =>
								response._tag === 'Embedded'
									? Effect.succeed(response)
									: Effect.fail(unexpected('Embedded', response._tag))
							)
						)
					)
				});
			})()
		)
};
export const AI = Object.freeze({ Service: AIService, layer: AILayers.make });

/** Outbound and inbound communication capability bound by the host. */
export type CommunicationInterface = Readonly<{
	readonly execute: (
		effectId: EffectId,
		request: CommunicationRequest
	) => Effect.Effect<CommunicationResponse, BoundFacilityError>;
}>;
/** Identifies the facilities service in Effect's context so dependency wiring remains explicit and type checked. */
const CommunicationService = Context.Service<CommunicationInterface>(
	'@norbital-ai/bolt/Communication'
);
/** Owns layer behavior at the facilities boundary so validation and typed semantics stay consistent for every caller. */
const CommunicationLayers = {
	make: (
		binding: FacilityBinding<CommunicationRequest, CommunicationResponse> | undefined,
		context: CallContext
	) =>
		Layer.succeed(
			CommunicationService,
			CommunicationService.of({
				execute: Effect.fn('Communication.execute')((id, request) =>
					invokeBinding('communication', binding, context, id, request)
				)
			})
		)
};
export const Communication = Object.freeze({
	Service: CommunicationService,
	layer: CommunicationLayers.make
});

/** Provider connector capability bound by the host. */
export type ConnectorInterface = Readonly<{
	readonly execute: (
		effectId: EffectId,
		request: ConnectorRequest
	) => Effect.Effect<ConnectorResponse, BoundFacilityError>;
}>;
/** Identifies the facilities service in Effect's context so dependency wiring remains explicit and type checked. */
const ConnectorService = Context.Service<ConnectorInterface>('@norbital-ai/bolt/Connector');
/** Owns layer behavior at the facilities boundary so validation and typed semantics stay consistent for every caller. */
const ConnectorLayers = {
	make: (
		binding: FacilityBinding<ConnectorRequest, ConnectorResponse> | undefined,
		context: CallContext
	) =>
		Layer.succeed(
			ConnectorService,
			ConnectorService.of({
				execute: Effect.fn('Connector.execute')((id, request) =>
					invokeBinding('connector', binding, context, id, request)
				)
			})
		)
};
export const Connector = Object.freeze({ Service: ConnectorService, layer: ConnectorLayers.make });

/** Tenant file capability bound by the host. */
export type FilesInterface = Readonly<{
	readonly execute: (
		effectId: EffectId,
		request: FileRequest
	) => Effect.Effect<FileResponse, BoundFacilityError>;
}>;
/** Identifies the facilities service in Effect's context so dependency wiring remains explicit and type checked. */
const FilesService = Context.Service<FilesInterface>('@norbital-ai/bolt/Files');
/** Owns layer behavior at the facilities boundary so validation and typed semantics stay consistent for every caller. */
const FilesLayers = {
	make: (binding: FacilityBinding<FileRequest, FileResponse> | undefined, context: CallContext) =>
		Layer.succeed(
			FilesService,
			FilesService.of({
				execute: Effect.fn('Files.execute')((id, request) =>
					invokeBinding('files', binding, context, id, request)
				)
			})
		)
};
export const Files = Object.freeze({ Service: FilesService, layer: FilesLayers.make });

/** Colony-owned operator tool capability bound by the host. */
export type HostToolsInterface = Readonly<{
	readonly execute: (
		effectId: EffectId,
		request: HostToolRequest
	) => Effect.Effect<HostToolResponse, BoundFacilityError>;
}>;
/** Identifies the facilities service in Effect's context so dependency wiring remains explicit and type checked. */
const HostToolsService = Context.Service<HostToolsInterface>('@norbital-ai/bolt/HostTools');
/** Owns layer behavior at the facilities boundary so validation and typed semantics stay consistent for every caller. */
const HostToolsLayers = {
	make: (
		binding: FacilityBinding<HostToolRequest, HostToolResponse> | undefined,
		context: CallContext
	) =>
		Layer.succeed(
			HostToolsService,
			HostToolsService.of({
				execute: Effect.fn('HostTools.execute')((id, request) =>
					invokeBinding('hostTools', binding, context, id, request)
				)
			})
		)
};
export const HostTools = Object.freeze({ Service: HostToolsService, layer: HostToolsLayers.make });

/** Identity lifecycle observations the host may project. Optional: emit no-ops when unbound. */
type IdentityHooksInterface = Readonly<{
	readonly emit: (
		effectId: EffectId,
		request: IdentityHookRequest
	) => Effect.Effect<void, BoundFacilityError>;
}>;
/** Identifies the facilities service in Effect's context so dependency wiring remains explicit and type checked. */
const IdentityHooksService = Context.Service<IdentityHooksInterface>(
	'@norbital-ai/bolt/IdentityHooks'
);
/** Owns layer behavior at the facilities boundary so validation and typed semantics stay consistent for every caller. */
const IdentityHooksLayers = {
	make: (
		binding: FacilityBinding<IdentityHookRequest, IdentityHookResponse> | undefined,
		context: CallContext
	) =>
		Layer.succeed(
			IdentityHooksService,
			IdentityHooksService.of({
				emit: Effect.fn('IdentityHooks.emit')((id, request) =>
					binding === undefined
						? Effect.void
						: invokeBinding('identityHooks', binding, context, id, request).pipe(Effect.asVoid)
				)
			})
		)
};
export const IdentityHooks = Object.freeze({
	Service: IdentityHooksService,
	layer: IdentityHooksLayers.make
});

/** Browser SSE/WebSocket transport capability bound by the host. */
type TransportInterface = Readonly<{
	readonly execute: (
		effectId: EffectId,
		request: TransportRequest
	) => Effect.Effect<TransportResponse, BoundFacilityError>;
}>;
/** Identifies the facilities service in Effect's context so dependency wiring remains explicit and type checked. */
const TransportService = Context.Service<TransportInterface>('@norbital-ai/bolt/Transport');
/** Owns layer behavior at the facilities boundary so validation and typed semantics stay consistent for every caller. */
/**
 * Distinguish repeat invocations of one id inside a facility's issued-map.
 *
 * The first occurrence of an id is returned unscathed; each later one is suffixed `#1`, `#2`
 * and so on, so a facility can tell "second request with this id" from "same request again".
 * Both facility layer factories that need this behavior once carried their own copy; the arrow
 * is threshold-relevant enough to keep one definition.
 */
const distinctIdIn = (issued: Ref.Ref<ReadonlyMap<string, number>>) => (id: EffectId) =>
	Ref.modify(issued, (current) => {
		const used = current.get(id) ?? 0;
		const next: readonly [EffectId, ReadonlyMap<string, number>] = [
			used === 0 ? id : EffectId.make(`${id}#${used}`),
			new Map(current).set(id, used + 1)
		];
		return next;
	});

const TransportLayers = {
	make: (
		binding: FacilityBinding<TransportRequest, TransportResponse> | undefined,
		context: CallContext
	) =>
		Layer.effect(
			TransportService,
			Effect.map(Ref.make<ReadonlyMap<string, number>>(new Map()), (issued) => {
				const distinct = distinctIdIn(issued);
				return TransportService.of({
					execute: Effect.fn('Transport.execute')((id, request) =>
						distinct(id).pipe(
							Effect.flatMap((unique) =>
								invokeBinding('transport', binding, context, unique, request)
							)
						)
					)
				});
			})
		)
};
export const Transport = Object.freeze({ Service: TransportService, layer: TransportLayers.make });

/** Host commit hook used by long-running internal writers to fan durable changes immediately. */
type SyncCommitInterface = Readonly<{
	readonly publish: (
		effectId: EffectId,
		request: SyncCommitRequest
	) => Effect.Effect<void, BoundFacilityError>;
	readonly drainChanges: Effect.Effect<ReadonlyArray<SyncChange>>;
}>;
const SyncCommitService = Context.Service<SyncCommitInterface>('@norbital-ai/bolt/SyncCommit');
const SyncCommitLayers = {
	make: (
		binding: FacilityBinding<SyncCommitRequest, SyncCommitResponse> | undefined,
		context: CallContext
	) =>
		Layer.effect(
			SyncCommitService,
			Effect.map(Ref.make<ReadonlyArray<SyncChange>>([]), (pending) => {
				const defer = (request: SyncCommitRequest) =>
					Ref.update(pending, (current) => compactSyncChanges([...current, ...request.changes]));
				return SyncCommitService.of({
					publish: (id, request) => {
						const changes = compactSyncChanges(request.changes);
						if (changes.length === 0) return Effect.void;
						const batch = { changes };
						return binding === undefined
							? defer(batch)
							: invokeBinding('syncCommit', binding, context, id, batch).pipe(Effect.asVoid);
					},
					drainChanges: Ref.getAndSet(pending, [])
				});
			})
		)
};
export const SyncCommit = Object.freeze({
	Service: SyncCommitService,
	layer: SyncCommitLayers.make
});

/** Durable task capability bound by the host. */
type TasksInterface = Readonly<{
	readonly execute: (
		effectId: EffectId,
		request: TaskRequest
	) => Effect.Effect<TaskResponse, BoundFacilityError>;
}>;
/** Identifies the facilities service in Effect's context so dependency wiring remains explicit and type checked. */
const TasksService = Context.Service<TasksInterface>('@norbital-ai/bolt/Tasks');
/** Owns layer behavior at the facilities boundary so validation and typed semantics stay consistent for every caller. */
const TasksLayers = {
	make: (binding: FacilityBinding<TaskRequest, TaskResponse> | undefined, context: CallContext) =>
		Layer.succeed(
			TasksService,
			TasksService.of({
				execute: Effect.fn('Tasks.execute')((id, request) =>
					invokeBinding('tasks', binding, context, id, request)
				)
			})
		)
};
export const Tasks = Object.freeze({ Service: TasksService, layer: TasksLayers.make });
