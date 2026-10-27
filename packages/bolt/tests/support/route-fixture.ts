// Inline fixture manifests exercise the real routes without pretending to augment the generated Names index.
import { Context, Effect, Layer, Option, Schema } from 'effect';
import * as NodeCrypto from '@effect/platform-node/NodeCrypto';
import { HttpServerRequest, HttpServerResponse } from 'effect/http';
import { Live } from '../../src/engine/services.ts';
import type { Authority } from '../../src/engine/contracts.ts';
import { ActRefused, ReadFailed } from '../../src/decl/errors.ts';
import { filesRoutes } from '../../src/protocol/files.ts';
import { ImagePreviewsLive } from '../../src/protocol/image-previews.ts';
import {
	AgentCallTable,
	AgentTurns,
	boltRoutes,
	dispatchAct,
	RateLimits,
	SessionAuthority
} from '../../src/protocol/http.ts';
import {
	ActReply,
	QReply,
	WireError,
	type ActBody,
	type QBody
} from '../../src/protocol/schema.ts';
import { KitInvalid, TestWorkspace, type WorkspaceServices } from '../../src/test/effect.ts';

export const json = (response: Response): Effect.Effect<unknown, KitInvalid> =>
	Effect.tryPromise({
		try: () => response.json(),
		catch: (error) => new KitInvalid({ message: String(error) })
	});

export const routeFixture = (workspace: Context.Context<TestWorkspace | WorkspaceServices>) =>
	Effect.gen(function* () {
		const context = yield* Layer.build(
			Layer.mergeAll(
				NodeCrypto.layer,
				AgentCallTable.layer.pipe(Layer.provideMerge(AgentTurns.layer)),
				RateLimits.layer,
				ImagePreviewsLive
			).pipe(Layer.provideMerge(Layer.succeedContext(workspace)))
		);
		const handle = (
			authority: Authority | null,
			request: Request,
			options: { address?: string } = {}
		): Effect.Effect<Response> =>
			Effect.gen(function* () {
				const incoming = HttpServerRequest.fromWeb(request).modify({
					remoteAddress: Option.some(options.address ?? '203.0.113.7')
				});
				const result = yield* filesRoutes(incoming).pipe(
					Effect.flatMap((file) =>
						Option.isSome(file) ? Effect.succeed(file) : boltRoutes(incoming)
					),
					Effect.provideService(SessionAuthority, {
						of: () => Effect.succeed(Option.fromNullishOr(authority))
					}),
					Effect.provide(context)
				);
				return Option.isSome(result)
					? HttpServerResponse.toWeb(result.value, { context })
					: new Response(null, { status: 404 });
			});
		const dispatch = (...args: Parameters<typeof dispatchAct>) =>
			dispatchAct(...args).pipe(Effect.provide(context));
		return {
			handle,
			dispatch,
			settled: Effect.andThen(
				Context.get(context, AgentTurns).settled,
				Context.get(context, Live).settled
			)
		};
	});
export type FixtureRoute = Effect.Success<ReturnType<typeof routeFixture>>;

export const actReply = (
	route: FixtureRoute,
	authority: Authority,
	body: ActBody,
	headers: Record<string, string> = {},
	options: { address?: string } = {}
) =>
	Effect.gen(function* () {
		const response = yield* route.handle(
			authority,
			new Request('http://cell/__bolt/act', {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'Idempotency-Key': crypto.randomUUID(),
					...headers
				},
				body: JSON.stringify(body)
			}),
			options
		);
		const raw = yield* json(response),
			refused = Schema.decodeUnknownOption(WireError)(raw);
		if (Option.isSome(refused)) {
			const { _tag, ...fields } = ActRefused.fields;
			void _tag;
			const failure = yield* Schema.decodeUnknownEffect(
				Schema.Struct({ error: Schema.Struct(fields) })
			)(raw);
			return yield* Effect.fail(new ActRefused(failure.error));
		}
		return yield* Schema.decodeUnknownEffect(ActReply)(raw);
	});
export const qReply = (route: FixtureRoute, authority: Authority, body: QBody) =>
	Effect.gen(function* () {
		const response = yield* route.handle(
			authority,
			new Request('http://cell/__bolt/q', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body)
			})
		);
		const raw = yield* json(response),
			refused = Schema.decodeUnknownOption(WireError)(raw);
		if (Option.isSome(refused)) return yield* Effect.fail(new ReadFailed(refused.value.error));
		return yield* Schema.decodeUnknownEffect(QReply)(raw);
	});
