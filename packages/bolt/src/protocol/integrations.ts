import { Context, Effect, Option, Schema, Stream } from 'effect';
import * as HttpServerRequest from 'effect/http/HttpServerRequest';
import * as HttpServerResponse from 'effect/http/HttpServerResponse';
import { BoltError } from './errors.ts';
import { HOOKS, type LinkManager } from '../engine/integrations/links.ts';
import { requestBody, requestUrl, response_error, SessionAuthority } from './http.ts';
import { sseResponse } from './sse.ts';
import { INTEGRATION_LIST, INTEGRATIONS } from './wire.ts';
import { ImportStartInput, OAUTH_CALLBACK } from '@norbital-ai/host-api';

/** No manager is needed by hosts that offer no integration providers (the test kit). */
export const IntegrationManager = Context.Reference<Option.Option<LinkManager>>(
	'bolt/IntegrationManager',
	{ defaultValue: () => Option.none() }
);
export const integration_routes = (request: HttpServerRequest.HttpServerRequest) =>
	Effect.gen(function* () {
		const url = requestUrl(request),
			path = url.pathname;
		if (path !== INTEGRATION_LIST && !path.startsWith(INTEGRATIONS))
			return Option.none<HttpServerResponse.HttpServerResponse>();
		const manager = yield* IntegrationManager;
		if (Option.isNone(manager)) return Option.none<HttpServerResponse.HttpServerResponse>();
		const session = yield* (yield* SessionAuthority).of(request);
		if (Option.isNone(session))
			return Option.some(
				HttpServerResponse.jsonUnsafe(
					{ error: { code: 'unauthenticated', message: 'Sign in first.' } },
					{ status: 401 }
				)
			);
		const authority = session.value;
		if (authority.actor.kind !== 'member' || authority.actor.external)
			return yield* Effect.fail(
				BoltError.make(
					'forbidden',
					'admission',
					'Sign in as an internal workspace member to manage integrations.'
				)
			);
		if (
			request.method === 'GET' &&
			path === INTEGRATION_LIST &&
			url.searchParams.get('stream') === '1'
		)
			return Option.some(
				sseResponse(
					manager.value
						.watch()
						.pipe(
							Stream.filterEffect((status) =>
								manager.value
									.may(authority, status.instance)
									.pipe(Effect.map((allowed) => allowed === true))
							)
						)
				)
			);
		if (request.method === 'GET' && path === INTEGRATION_LIST)
			return Option.some(HttpServerResponse.jsonUnsafe({ value: yield* manager.value.offers }));
		const [raw = '', verb = '', ...rest] = path.slice(INTEGRATIONS.length).split('/');
		const instance = yield* Effect.try({
			try: () => decodeURIComponent(raw),
			catch: () => BoltError.make('not_found', 'decode', 'No such integration route.')
		});
		if (instance === '' || rest.length !== 0)
			return yield* Effect.fail(BoltError.make('not_found', 'decode', 'No such integration route.'));
		const may = yield* manager.value.may(authority, instance);
		if (may === null)
			return yield* Effect.fail(
				BoltError.make('not_found', 'admission', `No integration instance '${instance}'.`)
			);
		if (!may)
			return yield* Effect.fail(
				BoltError.make(
					'forbidden',
					'admission',
					'Only someone who may update this integration can manage it.'
				)
			);
		if (request.method === 'GET' && verb === 'stream')
			return Option.some(sseResponse(manager.value.watch(instance)));
		if (request.method === 'GET' && verb === 'discover')
			return Option.some(
				HttpServerResponse.jsonUnsafe({ value: yield* manager.value.discover(instance) })
			);
		if (request.method === 'POST' && verb === 'import-start') {
			const body = yield* requestBody(request, ImportStartInput);
			yield* manager.value.import_start(instance, body, authority);
		} else if (request.method === 'POST' && ['pair', 'unpair', 'test'].includes(verb)) {
			const body = yield* requestBody(request, Schema.Json).pipe(
				Effect.catch(() => Effect.succeed({}))
			);
			yield* verb === 'pair'
				? manager.value.pair(instance, body, authority)
				: verb === 'unpair'
					? manager.value.unpair(instance)
					: manager.value.test(instance, body);
		} else if (request.method !== 'GET' || verb !== '')
			return yield* Effect.fail(BoltError.make('not_found', 'decode', 'No such integration route.'));
		const state = yield* manager.value.state(instance);
		if (state === undefined)
			return yield* Effect.fail(
				BoltError.make('not_found', 'admission', `No integration instance '${instance}'.`)
			);
		return Option.some(HttpServerResponse.jsonUnsafe({ value: state }));
	}).pipe(
		Effect.catch((error) =>
			// a failure that is not an engine answer reaches the client as an unnamed 500: keep its cause in the log
			(error instanceof BoltError ? Effect.void : Effect.logWarning(error)).pipe(
				Effect.as(Option.some(response_error(error)))
			)
		),
		Effect.catchCause((cause) =>
			Effect.logWarning(cause).pipe(Effect.as(Option.some(response_error(cause))))
		)
	);

export const hook_routes = (request: HttpServerRequest.HttpServerRequest) =>
	Effect.gen(function* () {
		const url = requestUrl(request),
			manager = yield* IntegrationManager;
		if (url.pathname.startsWith(HOOKS) || url.pathname === OAUTH_CALLBACK) {
			if (Option.isNone(manager)) return Option.none<HttpServerResponse.HttpServerResponse>();
			const web = yield* HttpServerRequest.toWeb(request);
			const response =
				url.pathname === OAUTH_CALLBACK
					? yield* manager.value.callback(web)
					: yield* manager.value.webhook(
							yield* Effect.try({
								try: () => decodeURIComponent(url.pathname.slice(HOOKS.length).split('/')[0] ?? ''),
								catch: () => BoltError.make('invalid', 'decode', 'Malformed integration path.')
							}),
							web
						);
			return Option.some(HttpServerResponse.fromWeb(response));
		}
		return Option.none<HttpServerResponse.HttpServerResponse>();
	}).pipe(
		Effect.catch((error) => Effect.succeed(Option.some(response_error(error)))),
		Effect.catchCause((cause) =>
			Effect.logWarning(cause).pipe(Effect.as(Option.some(response_error(cause))))
		)
	);
