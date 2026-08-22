import { Context, Effect, Layer, Ref } from 'effect';
import { EffectId } from '@norbital-ai/bolt-protocol';
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

/** AI capability bound by the host for one invocation context. */
export type AIInterface = Readonly<{
	readonly execute: (
		effectId: EffectId,
		request: AIRequest
	) => Effect.Effect<AIResponse, BoundFacilityError>;
}>;
/** Identifies the facilities service in Effect's context so dependency wiring remains explicit and type checked. */
const AIService = Context.Service<AIInterface>('@norbital-ai/bolt/AI');
/**
 * Gives every model call a distinct, replay-stable effect id.
 *
 * The host uses the id as both provider idempotency key and usage-meter identity. Reusing one would
 * answer a later call with the first completion and bill neither correctly. A per-layer counter
 * suffixes repeated caller ids deterministically, so replaying the same calls in the same order
 * preserves idempotency without global state.
 */
const AILayers = {
	make: (binding: FacilityBinding<AIRequest, AIResponse> | undefined, context: CallContext) =>
		Layer.effect(
			AIService,
			Effect.gen(function* () {
				const issued = yield* Ref.make<ReadonlyMap<string, number>>(new Map());
				const distinct = (id: EffectId) =>
					Ref.modify(issued, (current) => {
						const used = current.get(id) ?? 0;
						return [
							used === 0 ? id : EffectId.make(`${id}#${used}`),
							new Map(current).set(id, used + 1)
						] as const;
					});
				return AIService.of({
					execute: Effect.fn('AI.execute')((id, request) =>
						distinct(id).pipe(
							Effect.flatMap((unique) => invokeBinding('ai', binding, context, unique, request))
						)
					)
				});
			})
		)
};
export const AI = { Service: AIService, layer: AILayers.make } as const;

/** Outbound and inbound communication capability bound by the host. */
type CommunicationInterface = Readonly<{
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
export const Communication = {
	Service: CommunicationService,
	layer: CommunicationLayers.make
} as const;

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
export const Connector = { Service: ConnectorService, layer: ConnectorLayers.make } as const;

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
export const Files = { Service: FilesService, layer: FilesLayers.make } as const;

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
export const HostTools = { Service: HostToolsService, layer: HostToolsLayers.make } as const;

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
export const IdentityHooks = {
	Service: IdentityHooksService,
	layer: IdentityHooksLayers.make
} as const;

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
const TransportLayers = {
	make: (
		binding: FacilityBinding<TransportRequest, TransportResponse> | undefined,
		context: CallContext
	) =>
		Layer.succeed(
			TransportService,
			TransportService.of({
				execute: Effect.fn('Transport.execute')((id, request) =>
					invokeBinding('transport', binding, context, id, request)
				)
			})
		)
};
export const Transport = { Service: TransportService, layer: TransportLayers.make } as const;

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
export const Tasks = { Service: TasksService, layer: TasksLayers.make } as const;
