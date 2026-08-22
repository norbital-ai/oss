import { Context, Effect, Layer, Schema } from 'effect';
import type { FileRef } from '#lib/authoring/models-schema.js';
import { EffectId } from '@norbital-ai/bolt-protocol';
import * as Collections from '#lib/runtime/collections/collections.js';
import { AI, Files } from '#lib/runtime/facilities/services.js';
import * as Automations from '#lib/runtime/automations/automations.js';
import type * as Identity from '#lib/runtime/identity/identity.js';
import { DispatchError } from '#lib/runtime/workspace.js';
import { AuthoredRefusal } from '#lib/authoring/refusal.js';
import {
	makeAuthoringApi,
	makeBoundAuthoringOps,
	runAuthoredHandler
} from '#lib/runtime/collections/authored.js';

type RuntimeRemoteApi = Readonly<{
	readonly db: object;
	readonly infer: (input: {
		readonly schema: Schema.Codec<unknown, unknown>;
		readonly prompt: string;
		readonly model?: string;
	}) => Promise<unknown>;
	readonly readFileAsset: (file: FileRef) => Promise<{
		readonly id: string;
		readonly name: string;
		readonly mimeType: string | null;
		readonly size: number;
		readonly bytes: Uint8Array;
	}>;
}>;

export type RuntimeRemoteHandler = ReturnType<
	() => (input: unknown, api: RuntimeRemoteApi) => unknown
>;

export const mergeRuntimeHandlers = (
	remotes: Readonly<Record<string, RuntimeRemoteHandler>>,
	tools: Readonly<Record<string, RuntimeRemoteHandler>>
): Readonly<Record<string, RuntimeRemoteHandler>> => ({ ...remotes, ...tools });

export type RuntimeRemoteRegistry = Readonly<{
	readonly invoke: (
		name: string,
		input: unknown,
		subject: Identity.Subject,
		effectId: EffectId
	) => Effect.Effect<Schema.Json, DispatchError | AuthoredRefusal>;
}>;

/** Resolves authored remote handlers through the same collection, AI, and file capabilities used by native runtime operations. */
export const RemoteRegistry = Context.Service<RuntimeRemoteRegistry>(
	'@norbital-ai/bolt/RemoteRegistry'
);

/** Builds the runtime-owned remote registry and prevents authored handlers from escaping JSON across the artifact boundary. */
const RemoteRegistries = {
	layer: (handlers: Readonly<Record<string, RuntimeRemoteHandler>>) =>
		Layer.effect(
			RemoteRegistry,
			Effect.gen(function* () {
				const collections = yield* Collections.Service;
				const ai = yield* AI.Service;
				const files = yield* Files.Service;
				const automations = yield* Automations.Service;
				return RemoteRegistry.of({
					invoke: Effect.fn('RemoteRegistry.invoke')(function* (name, input, subject, effectId) {
						const handler = handlers[name];
						if (handler === undefined)
							return yield* new DispatchError({
								code: 'unknown_remote',
								message: `Unknown workspace remote: ${name}`
							});
						// The same Effect-native api every other authoring surface receives.
						//
						// This used to be a hand-rolled Promise shim — `findMany: async (q) => Effect.runPromise(...)`
						// — while the authoring *types* declared Effect-returning methods, as hooks, pipelines and
						// automations all genuinely have. A remote written against the declared types therefore did
						// `yield* api.db.leave_requests.findMany(...)`, yielded a Promise into the fiber, and died
						// with `Fiber.runLoop: Not a valid effect: [object Promise]` — which is what the leave page's
						// seasonality heatmap was showing as "could not be loaded". The types were right and the
						// runtime was wrong, so the runtime moved.
						const ops = makeBoundAuthoringOps(
							effectId,
							subject,
							collections,
							ai,
							files,
							automations
						);
						const api = makeAuthoringApi(ops) as RuntimeRemoteApi;
						// `runAuthoredHandler` already answers an Effect and settles a value, a promise or an
						// Effect alike, so it is yielded rather than wrapped in `tryPromise` — wrapping it
						// would hand the fiber the Effect object instead of running it.
						// The refusal a remote raised is passed through untouched rather than folded into
						// `remote_failed`. A remote is authored code like any other, so `refuse` means the same
						// thing here as it does in a hook — the caller may not do this — and mapping it to a
						// dispatch failure would put it back in the 500 class this change took it out of.
						const output = yield* runAuthoredHandler(() => handler(input, api)).pipe(
							Effect.mapError((cause) =>
								cause instanceof AuthoredRefusal
									? cause
									: DispatchError.from('remote_failed', cause)
							)
						);
						return yield* Schema.decodeUnknownEffect(Schema.Json)(output).pipe(
							Effect.mapError(
								() =>
									new DispatchError({
										code: 'invalid_remote_output',
										message: `Remote ${name} returned a non-JSON value`
									})
							)
						);
					})
				});
			})
		)
};
export const remoteRegistryLayer = RemoteRegistries.layer;
