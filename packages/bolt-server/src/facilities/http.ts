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
			'Managed HTTP GET failed; check the connection, credential and provider availability.',
			{ retryable: false, outcome: 'known' }
		)
	);
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

/** Managed API GET: public DNS pinned to the checked addresses, two MiB, thirty seconds, no redirects. */
export const makeManagedHttpConnectorBinding = (
	options: {
		readonly resolve?: (hostname: string) => Promise<readonly Awaited<ReturnType<typeof lookup>>[]>;
		readonly request?: typeof requestPage;
	} = {}
): FacilityBinding<ConnectorRequest, ConnectorResponse> => ({
	call: (_metadata, input, signal) =>
		Effect.runPromise(
			Effect.tryPromise({
				try: async (cancelled) => {
					const decoded = Schema.decodeUnknownSync(ConnectorRequest)(input);
					if (decoded.connector !== 'http' || decoded.operation !== INTEGRATION_HTTP_OPERATION)
						throw new Error('Unsupported managed HTTP operation.');
					const descriptor = Schema.decodeUnknownSync(IntegrationHttpRequest)(decoded.input);
					if (descriptor.method !== 'GET' || descriptor.body !== undefined)
						throw new Error('Managed connections accept GET only.');
					const target = new URL(descriptor.url);
					if (
						target.protocol !== 'https:' ||
						target.username ||
						target.password ||
						(target.port && target.port !== '443')
					)
						throw new Error('Managed connections require public HTTPS.');
					if (
						Object.keys(descriptor.headers).some(
							(name) =>
								reservedHeaders.has(name.toLowerCase()) || name.toLowerCase().startsWith('proxy-')
						)
					)
						throw new Error('Managed connections cannot override transport headers.');
					const bounded = AbortSignal.any([signal, cancelled]);
					bounded.throwIfAborted();
					const hostname = target.hostname.replace(/^\[|\]$/g, '');
					const addresses = isIP(hostname)
						? [{ address: hostname, family: isIP(hostname) }]
						: await (options.resolve ?? ((host) => lookup(host, { all: true })))(hostname);
					if (
						addresses.length === 0 ||
						addresses.some((entry) => !isPublicWebAddress(entry.address))
					)
						throw new Error('Managed connections cannot reach private or reserved networks.');
					bounded.throwIfAborted();
					const response = await (options.request ?? requestPage)(target, addresses, bounded, {
						accept: 'application/json',
						...descriptor.headers
					});
					bounded.throwIfAborted();
					const bytes =
						typeof response.body === 'string'
							? new TextEncoder().encode(response.body)
							: response.body;
					if (bytes.byteLength > WEB_PAGE_BYTE_LIMIT)
						throw new Error('Managed HTTP response exceeds two MiB.');
					const text = new TextDecoder().decode(bytes);
					const parsed = json(text);
					return success({
						output: {
							status: response.status,
							headers: response.headers ?? {},
							body: text === '' ? null : parsed._tag === 'Success' ? parsed.value : text
						}
					});
				},
				catch: () => new Error('Managed HTTP GET failed.')
			}).pipe(
				Effect.timeout('30 seconds'),
				Effect.catch(() => Effect.succeed(failed()))
			),
			{ signal }
		).catch(failed)
});

/** The portable defaults serve public pages and explicitly declared managed API GETs. */
export const makeDefaultConnectorBinding = (): FacilityBinding<
	ConnectorRequest,
	ConnectorResponse
> => {
	const web = makeWebConnectorBinding();
	const http = makeManagedHttpConnectorBinding();
	return {
		call: (metadata, input, signal) =>
			input.connector === 'http'
				? http.call(metadata, input, signal)
				: web.call(metadata, input, signal)
	};
};
