import { Context, Effect, Fiber, FiberSet, Layer, Option, Record, Ref } from 'effect';
import type * as HttpServerRequest from 'effect/http/HttpServerRequest';
import * as HttpServerResponse from 'effect/http/HttpServerResponse';
import { Activation, Outbound, Runs } from '../engine/services.ts';
import { NOT_IN_PREVIEW, ShellConfig, ShellHandler } from '../shell/host.ts';
import { BoltError } from './errors.ts';
import { AgentCallTable, AgentTurns, boltRoutes, RateLimits } from './http.ts';
import { filesRoutes } from './files.ts';
import { ImagePreviewsLive } from './image-previews.ts';
import { hookRoutes, integrationRoutes } from './integrations.ts';

export type Handler<R = never> = (
	request: HttpServerRequest.HttpServerRequest
) => Effect.Effect<Option.Option<HttpServerResponse.HttpServerResponse>, never, R>;
type RouteRequirements =
	| Effect.Services<ReturnType<typeof boltRoutes>>
	| Effect.Services<ReturnType<typeof filesRoutes>>
	| Effect.Services<ReturnType<typeof integrationRoutes>>
	| Effect.Services<ReturnType<typeof hookRoutes>>;
export const ORDER = ['hooks', 'shell', 'integrations', 'files', 'bolt'] as const;
export class BoltHost extends Context.Service<
	BoltHost,
	{
		readonly handle: Handler;
		readonly settled: Effect.Effect<void>;
	}
>()('bolt/BoltHost') {}

/** Norbius belongs to the live workspace: in a preview environment (`ShellConfig.live`) every agent callable refuses. */
const AgentCalls = Layer.effect(
	AgentCallTable,
	Effect.gen(function* () {
		const table = yield* AgentCallTable;
		if ((yield* ShellConfig).live === undefined) return table;
		const refusal = Effect.fail(BoltError.make('forbidden', 'admission', NOT_IN_PREVIEW));
		return Record.map(table, (call) => ({ input: call.input, run: () => refusal }));
	})
).pipe(Layer.provide(AgentCallTable.layer));

/** All route state and started turns belong to the activation's scope. */
export const BoltHostLive = Layer.effect(
	BoltHost,
	Effect.gen(function* () {
		const shell = yield* ShellHandler;
		const turns = yield* AgentTurns;
		const requests = yield* FiberSet.make();
		const context = yield* Effect.context<RouteRequirements>();
		const open = yield* Ref.make(true);
		yield* Effect.addFinalizer(() => Ref.set(open, false));
		yield* (yield* Outbound).activate;
		yield* (yield* Runs).boot((yield* Activation).overran);
		const handlers: readonly Handler<RouteRequirements>[] = [
			hookRoutes,
			shell.handle,
			integrationRoutes,
			filesRoutes,
			boltRoutes
		];
		return {
			handle: (request) =>
				Effect.gen(function* () {
					if (!(yield* Ref.get(open)))
						return Option.some(
							HttpServerResponse.jsonUnsafe(
								{ error: { code: 'interrupted', message: 'The workspace generation is closed.' } },
								{ status: 500 }
							)
						);
					return yield* FiberSet.run(
						requests,
						Effect.gen(function* () {
							for (const handler of handlers) {
								const answer = yield* handler(request).pipe(Effect.provide(context));
								if (Option.isSome(answer)) return answer;
							}
							return Option.none();
						})
					).pipe(Effect.flatMap(Fiber.join));
				}),
			settled: turns.settled
		};
	})
).pipe(
	Layer.provideMerge(
		Layer.mergeAll(
			AgentCalls.pipe(Layer.provideMerge(AgentTurns.layer)),
			RateLimits.layer,
			ImagePreviewsLive
		)
	)
);
