// An integration instance's Effects and status Stream, decoded at the browser boundary.
import { Cause, Effect, Option, Queue, Schema, Stream } from 'effect';
import { ActRefused, ProtocolFailed } from '../decl/errors.ts';
import type { Json } from '../decl/values.ts';
import {
	decodeStatus,
	type ImportStartInput,
	type InstanceStatus
} from '../protocol/instance-status.ts';
import { IntegrationOffer, WireError } from '../protocol/schema.ts';
import { browserTransport } from '../protocol/client.ts';

type Options = { fetch?: typeof fetch; base?: string };
const BASE = '/__bolt/integrations/';
/** One integration route's `value`, its refusal as `ActRefused`. */
const answer = (options: Options, method: 'GET' | 'POST', url: string, body?: Json) =>
	browserTransport(options.fetch === undefined ? {} : { fetch: options.fetch })
		.request(method, url, body)
		.pipe(
			Effect.flatMap((response): Effect.Effect<Json, ActRefused | ProtocolFailed> => {
				const refusal = Schema.decodeUnknownOption(WireError)(response.body);
				if (response.status >= 400)
					return Effect.fail(
						new ActRefused({
							code: Option.isSome(refusal) ? refusal.value.error.code : 'refused',
							message:
								response.status === 401
									? 'Sign in to manage this integration.'
									: response.status === 403
										? 'You do not have access to this integration.'
										: Option.isSome(refusal)
											? refusal.value.error.message
											: 'The integration request failed. Try again.'
						})
					);
				return Schema.decodeUnknownEffect(Schema.Struct({ value: Schema.Json }))(
					response.body
				).pipe(
					Effect.map((answer) => answer.value),
					Effect.mapError(
						() =>
							new ProtocolFailed({ message: 'The host returned an invalid integration answer.' })
					)
				);
			})
		);

/** Every definition with the providers this host offers for it (`GET /__bolt/integrations/`). */
export const integrationOffers = (options: Options = {}) =>
	answer(options, 'GET', options.base ?? BASE).pipe(
		Effect.flatMap((value) =>
			Schema.decodeUnknownEffect(Schema.Array(IntegrationOffer))(value).pipe(
				Effect.mapError(
					() => new ProtocolFailed({ message: 'The host returned invalid integrations.' })
				)
			)
		)
	);

export function integrationClient(instance: string, options: Options = {}) {
	const url = (verb: string) =>
		`${options.base ?? BASE}${encodeURIComponent(instance)}${verb === '' ? '' : `/${verb}`}`;
	const call = (method: 'GET' | 'POST', verb: string, body?: Json) =>
		answer(options, method, url(verb), body);
	const status = (value: Json) => {
		const decoded = decodeStatus(value);
		return decoded !== null && decoded.instance === instance
			? Effect.succeed(decoded)
			: Effect.fail(
					new ProtocolFailed({
						message: 'The host answered something that is not this integration’s status.'
					})
				);
	};
	return {
		instance,
		status: () => call('GET', '').pipe(Effect.flatMap(status)),
		pair: (input: Json = {}) => call('POST', 'pair', input).pipe(Effect.flatMap(status)),
		importStart: (input: ImportStartInput) =>
			call('POST', 'import-start', input).pipe(Effect.flatMap(status)),
		unpair: () => call('POST', 'unpair', {}).pipe(Effect.flatMap(status)),
		test: (input: Json = {}) => call('POST', 'test', input).pipe(Effect.flatMap(status)),
		discover: () =>
			call('GET', 'discover').pipe(
				Effect.flatMap((value) =>
					Schema.decodeUnknownEffect(
						Schema.Array(Schema.Struct({ id: Schema.String, label: Schema.String }))
					)(value).pipe(
						Effect.mapError(
							() =>
								new ProtocolFailed({ message: 'The host returned invalid integration resources.' })
						)
					)
				)
			),
		watch: (): Stream.Stream<InstanceStatus, ProtocolFailed> =>
			Stream.callback((queue) =>
				Effect.acquireRelease(
					Effect.try({
						try: () => new EventSource(url('stream')),
						catch: () =>
							new ProtocolFailed({ message: 'The integration status stream could not be opened.' })
					}),
					(source) => Effect.sync(() => source.close())
				).pipe(
					Effect.flatMap((source) =>
						Effect.sync(() => {
							source.onmessage = (event) => {
								const parsed = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json))(
									event.data
								);
								const decoded = Option.isSome(parsed) ? decodeStatus(parsed.value) : null;
								if (decoded !== null && decoded.instance === instance)
									Queue.offerUnsafe(queue, decoded);
								else
									Queue.failCauseUnsafe(
										queue,
										Cause.fail(
											new ProtocolFailed({
												message: 'The integration status stream returned an invalid frame.'
											})
										)
									);
							};
							source.onerror = () =>
								Queue.failCauseUnsafe(
									queue,
									Cause.fail(
										new ProtocolFailed({
											message: 'The integration status stream was interrupted.'
										})
									)
								);
						})
					)
				)
			)
	};
}
export type IntegrationClient = ReturnType<typeof integrationClient>;

/** One shell's instance watchers share a status socket; the last watcher closes it. */
export function integrationClients(options: Options = {}) {
	type Subscriber = {
		readonly instance: string;
		readonly send: (status: InstanceStatus) => void;
		readonly fail: (error: ProtocolFailed) => void;
	};
	const subscribers = new Set<Subscriber>();
	let source: EventSource | null = null;
	const open = () => {
		const opened = new EventSource(`${options.base ?? BASE}?stream=1`);
		opened.onmessage = (event) => {
			const parsed = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json))(event.data);
			const status = Option.isSome(parsed) ? decodeStatus(parsed.value) : null;
			if (status === null) {
				const error = new ProtocolFailed({
					message: 'The integration status stream returned an invalid frame.'
				});
				for (const subscriber of subscribers) subscriber.fail(error);
			} else
				for (const subscriber of subscribers)
					if (subscriber.instance === status.instance) subscriber.send(status);
		};
		opened.onerror = () => {
			const error = new ProtocolFailed({
				message: 'The integration status stream was interrupted.'
			});
			for (const subscriber of subscribers) subscriber.fail(error);
		};
		return opened;
	};
	return (instance: string): IntegrationClient => ({
		...integrationClient(instance, options),
		watch: () =>
			Stream.callback<InstanceStatus, ProtocolFailed>((queue) =>
				Effect.acquireRelease(
					Effect.try({
						try: () => {
							source ??= open();
							const subscriber: Subscriber = {
								instance,
								send: (status) => {
									Queue.offerUnsafe(queue, status);
								},
								fail: (error) => {
									Queue.failCauseUnsafe(queue, Cause.fail(error));
								}
							};
							subscribers.add(subscriber);
							return subscriber;
						},
						catch: () =>
							new ProtocolFailed({ message: 'The integration status stream could not be opened.' })
					}),
					(subscriber) =>
						Effect.sync(() => {
							subscribers.delete(subscriber);
							if (subscribers.size === 0) {
								source?.close();
								source = null;
							}
						})
				)
			)
	});
}
