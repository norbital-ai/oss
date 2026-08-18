import { Context, Effect, Layer, Ref } from 'effect';
import type {
	AIRequest,
	AIResponse,
	CommunicationRequest,
	CommunicationResponse,
	ConnectorRequest,
	ConnectorResponse,
	EffectId,
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
} from './database.js';

/** AI capability bound by the host for one invocation context. */
export namespace AI {
	export type Interface = Readonly<{
		readonly execute: (
			effectId: EffectId,
			request: AIRequest
		) => Effect.Effect<AIResponse, BoundFacilityError>;
	}>;
	/** Identifies the facilities service in Effect's context so dependency wiring remains explicit and type checked. */
	export const Service = Context.Service<Interface>('@norbital-ai/bolt/AI');
	/**
	 * The distinct effect id one model call is made under, given the id its caller asked for.
	 *
	 * A facility effect id is not a label: the host uses it as the provider idempotency key and as the
	 * identity of the usage meter that call writes. Two model calls sharing one is therefore two
	 * failures at once — the second is answered with the first one's completion, and it is billed to
	 * an observation that already exists, so nobody pays for it.
	 *
	 * Callers do reuse one. `api.infer` is handed the invocation's effect id verbatim, so a hook that
	 * infers twice, or a before-hook and an after-hook on the same write, collided by construction.
	 * Fixing it at each call site means every future caller has to know the rule; the service that
	 * hands out the ids is the one place that can hold it. The suffix is a count of prior uses rather
	 * than a random value, so a replayed invocation issuing the same calls in the same order issues
	 * the same ids and stays idempotent.
	 */
	const Layers = {
		make: (binding: FacilityBinding<AIRequest, AIResponse> | undefined, context: CallContext) =>
			Layer.effect(
				Service,
				Effect.gen(function* () {
					const issued = yield* Ref.make<ReadonlyMap<string, number>>(new Map());
					const distinct = (id: EffectId) =>
						Ref.modify(issued, (current) => {
							const used = current.get(id) ?? 0;
							return [
								used === 0 ? id : (`${id}#${used}` as EffectId),
								new Map(current).set(id, used + 1)
							] as const;
						});
					return Service.of({
						execute: Effect.fn('AI.execute')((id, request) =>
							distinct(id).pipe(
								Effect.flatMap((unique) => invokeBinding('ai', binding, context, unique, request))
							)
						)
					});
				})
			)
	};
	export const layer = Layers.make;
}

/** Outbound and inbound communication capability bound by the host. */
export namespace Communication {
	export type Interface = Readonly<{
		readonly execute: (
			effectId: EffectId,
			request: CommunicationRequest
		) => Effect.Effect<CommunicationResponse, BoundFacilityError>;
	}>;
	/** Identifies the facilities service in Effect's context so dependency wiring remains explicit and type checked. */
	export const Service = Context.Service<Interface>('@norbital-ai/bolt/Communication');
	/** Owns layer behavior at the facilities boundary so validation and typed semantics stay consistent for every caller. */
	const Layers = {
		make: (
			binding: FacilityBinding<CommunicationRequest, CommunicationResponse> | undefined,
			context: CallContext
		) =>
			Layer.succeed(
				Service,
				Service.of({
					execute: Effect.fn('Communication.execute')((id, request) =>
						invokeBinding('communication', binding, context, id, request)
					)
				})
			)
	};
	export const layer = Layers.make;
}

/** Provider connector capability bound by the host. */
export namespace Connector {
	export type Interface = Readonly<{
		readonly execute: (
			effectId: EffectId,
			request: ConnectorRequest
		) => Effect.Effect<ConnectorResponse, BoundFacilityError>;
	}>;
	/** Identifies the facilities service in Effect's context so dependency wiring remains explicit and type checked. */
	export const Service = Context.Service<Interface>('@norbital-ai/bolt/Connector');
	/** Owns layer behavior at the facilities boundary so validation and typed semantics stay consistent for every caller. */
	const Layers = {
		make: (
			binding: FacilityBinding<ConnectorRequest, ConnectorResponse> | undefined,
			context: CallContext
		) =>
			Layer.succeed(
				Service,
				Service.of({
					execute: Effect.fn('Connector.execute')((id, request) =>
						invokeBinding('connector', binding, context, id, request)
					)
				})
			)
	};
	export const layer = Layers.make;
}

/** Tenant file capability bound by the host. */
export namespace Files {
	export type Interface = Readonly<{
		readonly execute: (
			effectId: EffectId,
			request: FileRequest
		) => Effect.Effect<FileResponse, BoundFacilityError>;
	}>;
	/** Identifies the facilities service in Effect's context so dependency wiring remains explicit and type checked. */
	export const Service = Context.Service<Interface>('@norbital-ai/bolt/Files');
	/** Owns layer behavior at the facilities boundary so validation and typed semantics stay consistent for every caller. */
	const Layers = {
		make: (binding: FacilityBinding<FileRequest, FileResponse> | undefined, context: CallContext) =>
			Layer.succeed(
				Service,
				Service.of({
					execute: Effect.fn('Files.execute')((id, request) =>
						invokeBinding('files', binding, context, id, request)
					)
				})
			)
	};
	export const layer = Layers.make;
}

/** Colony-owned operator tool capability bound by the host. */
export namespace HostTools {
	export type Interface = Readonly<{
		readonly execute: (
			effectId: EffectId,
			request: HostToolRequest
		) => Effect.Effect<HostToolResponse, BoundFacilityError>;
	}>;
	/** Identifies the facilities service in Effect's context so dependency wiring remains explicit and type checked. */
	export const Service = Context.Service<Interface>('@norbital-ai/bolt/HostTools');
	/** Owns layer behavior at the facilities boundary so validation and typed semantics stay consistent for every caller. */
	const Layers = {
		make: (
			binding: FacilityBinding<HostToolRequest, HostToolResponse> | undefined,
			context: CallContext
		) =>
			Layer.succeed(
				Service,
				Service.of({
					execute: Effect.fn('HostTools.execute')((id, request) =>
						invokeBinding('hostTools', binding, context, id, request)
					)
				})
			)
	};
	export const layer = Layers.make;
}

/** Identity lifecycle observations the host may project. Optional: emit no-ops when unbound. */
export namespace IdentityHooks {
	export type Interface = Readonly<{
		readonly emit: (
			effectId: EffectId,
			request: IdentityHookRequest
		) => Effect.Effect<void, BoundFacilityError>;
	}>;
	/** Identifies the facilities service in Effect's context so dependency wiring remains explicit and type checked. */
	export const Service = Context.Service<Interface>('@norbital-ai/bolt/IdentityHooks');
	/** Owns layer behavior at the facilities boundary so validation and typed semantics stay consistent for every caller. */
	const Layers = {
		make: (
			binding: FacilityBinding<IdentityHookRequest, IdentityHookResponse> | undefined,
			context: CallContext
		) =>
			Layer.succeed(
				Service,
				Service.of({
					emit: Effect.fn('IdentityHooks.emit')((id, request) =>
						binding === undefined
							? Effect.void
							: invokeBinding('identityHooks', binding, context, id, request).pipe(Effect.asVoid)
					)
				})
			)
	};
	export const layer = Layers.make;
}

/** Browser SSE/WebSocket transport capability bound by the host. */
export namespace Transport {
	export type Interface = Readonly<{
		readonly execute: (
			effectId: EffectId,
			request: TransportRequest
		) => Effect.Effect<TransportResponse, BoundFacilityError>;
	}>;
	/** Identifies the facilities service in Effect's context so dependency wiring remains explicit and type checked. */
	export const Service = Context.Service<Interface>('@norbital-ai/bolt/Transport');
	/** Owns layer behavior at the facilities boundary so validation and typed semantics stay consistent for every caller. */
	const Layers = {
		make: (
			binding: FacilityBinding<TransportRequest, TransportResponse> | undefined,
			context: CallContext
		) =>
			Layer.succeed(
				Service,
				Service.of({
					execute: Effect.fn('Transport.execute')((id, request) =>
						invokeBinding('transport', binding, context, id, request)
					)
				})
			)
	};
	export const layer = Layers.make;
}

/** Durable task capability bound by the host. */
export namespace Tasks {
	export type Interface = Readonly<{
		readonly execute: (
			effectId: EffectId,
			request: TaskRequest
		) => Effect.Effect<TaskResponse, BoundFacilityError>;
	}>;
	/** Identifies the facilities service in Effect's context so dependency wiring remains explicit and type checked. */
	export const Service = Context.Service<Interface>('@norbital-ai/bolt/Tasks');
	/** Owns layer behavior at the facilities boundary so validation and typed semantics stay consistent for every caller. */
	const Layers = {
		make: (binding: FacilityBinding<TaskRequest, TaskResponse> | undefined, context: CallContext) =>
			Layer.succeed(
				Service,
				Service.of({
					execute: Effect.fn('Tasks.execute')((id, request) =>
						invokeBinding('tasks', binding, context, id, request)
					)
				})
			)
	};
	export const layer = Layers.make;
}
