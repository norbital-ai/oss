import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Effect, Schema } from 'effect';
import {
	ConnectorRequest,
	INTEGRATION_HTTP_OPERATION,
	IntegrationHttpRequest,
	WEB_PAGE_BYTE_LIMIT,
	failure,
	makeWireError,
	success,
	type ConnectorResponse,
	type FacilityBinding
} from '@norbital-ai/bolt-protocol';
import { isPublicWebAddress, makeRequestPage, makeWebConnectorBinding } from './web.js';

const json = Schema.decodeUnknownExit(Schema.fromJsonString(Schema.Json));
const requestPage = makeRequestPage();
const failed = () =>
	failure(
		makeWireError(
			'connection.request_failed',
			'Managed HTTP request failed; check the connection, credential and provider availability.',
			{ retryable: false, outcome: 'known' }
		)
	);
/**
 * A connection or timeout failure: the provider may be back in a minute, so the caller may retry.
 * It may also have received a write before the socket died, hence `unknown`.
 */
const unreachable = () =>
	failure(
		makeWireError(
			'connection.unreachable',
			'Managed HTTP request did not complete; the provider was unreachable or too slow.',
			{ retryable: true, outcome: 'unknown' }
		)
	);
/** A request this binding will never send, however often it is asked. */
class Refused extends Error {}
const reservedHeaders = new Set([
	'host',
	'connection',
	'content-length',
	'transfer-encoding',
	'upgrade',
	'te',
	'trailer',
	'accept-encoding'
]);
const MAX_REDIRECTS = 5;

/** `localhost`, `*.localhost` and the loopback literals: a development host's own machine. */
const isLoopbackName = (hostname: string): boolean =>
	hostname === 'localhost' ||
	hostname.endsWith('.localhost') ||
	hostname === '127.0.0.1' ||
	hostname === '::1';
const isLoopbackAddress = (address: string): boolean =>
	address === '::1' || address.startsWith('127.');

/**
 * Managed API request: public DNS pinned to the checked addresses, two MiB, thirty seconds.
 *
 * Every integration method is performed — a send binding's `POST`/`PUT`/`PATCH`/`DELETE` is the
 * reason the method is in the request at all, and refusing it here made every outbound binding on
 * a managed host a dead letter. A JSON body is serialized once and sent as `application/json`.
 *
 * Redirects are followed, at most five, each hop re-checked exactly as the first. A cross-origin hop
 * drops every caller header, because the binding cannot know which of them is the credential; a
 * `301`/`302`/`303` answer to a write continues as a bodiless `GET`, which is what every browser and
 * every provider that answers a write with a redirect (Google Apps Script) expects.
 *
 * `allowLoopback` admits plain-HTTP requests to this machine's own names — a development host
 * reaching another workspace it serves on `*.localhost`. Nothing else private is ever reachable.
 */
export const makeManagedHttpConnectorBinding = (
	options: {
		readonly resolve?: (hostname: string) => Promise<readonly Awaited<ReturnType<typeof lookup>>[]>;
		readonly request?: typeof requestPage;
		readonly allowLoopback?: boolean;
	} = {}
): FacilityBinding<ConnectorRequest, ConnectorResponse> => ({
	call: (_metadata, input, signal) =>
		Effect.runPromise(
			Effect.tryPromise({
				try: async (cancelled) => {
					const decoded = Schema.decodeUnknownExit(ConnectorRequest)(input);
					if (decoded._tag !== 'Success') throw new Refused('Malformed connector request.');
					if (decoded.value.operation !== INTEGRATION_HTTP_OPERATION)
						throw new Refused('Unsupported managed HTTP operation.');
					const described = Schema.decodeUnknownExit(IntegrationHttpRequest)(decoded.value.input);
					if (described._tag !== 'Success') throw new Refused('Malformed HTTP request descriptor.');
					const descriptor = described.value;
					if (
						Object.keys(descriptor.headers).some(
							(name) =>
								reservedHeaders.has(name.toLowerCase()) || name.toLowerCase().startsWith('proxy-')
						)
					)
						throw new Refused('Managed connections cannot override transport headers.');
					const bounded = AbortSignal.any([signal, cancelled]);
					let target = new URL(descriptor.url);
					let method: string = descriptor.method;
					let body =
						descriptor.body === undefined || method === 'GET' || method === 'DELETE'
							? undefined
							: JSON.stringify(descriptor.body);
					let headers: Record<string, string> = {
						accept: 'application/json',
						...(body === undefined ? {} : { 'content-type': 'application/json' }),
						...descriptor.headers
					};
					for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
						bounded.throwIfAborted();
						const hostname = target.hostname.replace(/^\[|\]$/g, '');
						const loopback = options.allowLoopback === true && isLoopbackName(hostname);
						if (
							target.username ||
							target.password ||
							(!loopback &&
								(target.protocol !== 'https:' || (target.port && target.port !== '443'))) ||
							(target.protocol !== 'https:' && target.protocol !== 'http:')
						)
							throw new Refused('Managed connections require public HTTPS.');
						const addresses = isIP(hostname)
							? [{ address: hostname, family: isIP(hostname) }]
							: // repository-health:allow A6 -- Each redirect decides the next hostname; DNS is checked hop by hop.
								await (options.resolve ?? ((host) => lookup(host, { all: true })))(hostname);
						if (
							addresses.length === 0 ||
							addresses.some((entry) =>
								loopback ? !isLoopbackAddress(entry.address) : !isPublicWebAddress(entry.address)
							)
						)
							throw new Refused('Managed connections cannot reach private or reserved networks.');
						bounded.throwIfAborted();
						// repository-health:allow A6 -- A redirect's answer decides the next request; hops are sequential.
						const response = await (options.request ?? requestPage)(
							target,
							addresses,
							bounded,
							headers,
							method === 'GET' ? undefined : { method, ...(body === undefined ? {} : { body }) }
						);
						bounded.throwIfAborted();
						if (response.status >= 300 && response.status < 400 && response.location) {
							const next = new URL(response.location, target);
							if (next.origin !== target.origin) headers = { accept: 'application/json' };
							if (response.status !== 307 && response.status !== 308) {
								method = 'GET';
								body = undefined;
								delete headers['content-type'];
							}
							target = next;
							continue;
						}
						const bytes =
							typeof response.body === 'string'
								? new TextEncoder().encode(response.body)
								: response.body;
						if (bytes.byteLength > WEB_PAGE_BYTE_LIMIT)
							throw new Refused('Managed HTTP response exceeds two MiB.');
						const text = new TextDecoder().decode(bytes);
						const parsed = json(text);
						return success({
							output: {
								status: response.status,
								headers: response.headers ?? {},
								body: text === '' ? null : parsed._tag === 'Success' ? parsed.value : text
							}
						});
					}
					throw new Refused('Managed HTTP request exceeded five redirects.');
				},
				catch: (cause) => cause
			}).pipe(
				Effect.timeout('30 seconds'),
				Effect.catch((cause) =>
					Effect.succeed(cause instanceof Refused ? failed() : unreachable())
				)
			),
			{ signal }
		).catch(failed)
});

/** The portable defaults: public pages, and every integration request through the managed binding. */
export const makeDefaultConnectorBinding = (
	options: { readonly allowLoopback?: boolean } = {}
): FacilityBinding<ConnectorRequest, ConnectorResponse> => {
	const web = makeWebConnectorBinding();
	const http = makeManagedHttpConnectorBinding(options);
	return {
		// An integration names its connector after itself; the operation is what says it is HTTP.
		call: (metadata, input, signal) =>
			input.operation === INTEGRATION_HTTP_OPERATION
				? http.call(metadata, input, signal)
				: web.call(metadata, input, signal)
	};
};
