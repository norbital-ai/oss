import {
	ConnectorRequest,
	ConnectorResponse,
	makeWireError,
	type FacilityBinding
} from '@norbital-ai/bolt-protocol';
import { Schema } from 'effect';
import { INTEGRATION_HTTP_OPERATION, IntegrationHttpRequest } from './http.js';

/**
 * A host-side connector binding that performs `http.request`, and nothing else.
 *
 * This is the only file in Bolt that touches a network, and it is not reachable from the runtime:
 * nothing under `src/runtime` imports it. It is exported from `@norbital-ai/bolt/host` for a host to
 * *bind* — the same relationship `bolt-server`'s database and file bindings have with the runtime
 * that calls them. Bolt states the request; whoever runs Bolt decides whether it is sent.
 *
 * `allowedHosts` is the reason a host would want this one rather than writing its own: an
 * integration's `baseUrl` comes out of a workspace's source, and a host that runs other people's
 * workspaces should be able to say which origins they may reach. Omit it and every origin is
 * allowed, which is the right default for a self-hosted single-tenant deployment and the wrong one
 * for a shared host.
 */
export const makeHttpConnectorBinding = (
	options: {
		readonly fetch?: typeof globalThis.fetch;
		readonly allowedHosts?: ReadonlyArray<string>;
		/** Refuses a body larger than this rather than buffering whatever a source decides to send. */
		readonly maxResponseBytes?: number;
	} = {}
): FacilityBinding<ConnectorRequest, ConnectorResponse> => {
	const perform = options.fetch ?? globalThis.fetch;
	const maxResponseBytes = options.maxResponseBytes ?? 8 * 1024 * 1024;
	return {
		call: async (_metadata, unsafeInput, signal) => {
			const decoded = Schema.decodeUnknownExit(ConnectorRequest)(unsafeInput);
			if (decoded._tag !== 'Success') {
				return { _tag: 'Failure', error: makeWireError('connector.invalid_request', 'Connector request is malformed') };
			}
			const input = decoded.value;
			if (input.operation !== INTEGRATION_HTTP_OPERATION) {
				return {
					_tag: 'Failure',
					error: makeWireError('connector.unsupported_operation', `This connector performs ${INTEGRATION_HTTP_OPERATION} only, not ${input.operation}`)
				};
			}
			const request = Schema.decodeUnknownExit(IntegrationHttpRequest)(input.input);
			if (request._tag !== 'Success') {
				return { _tag: 'Failure', error: makeWireError('connector.invalid_request', 'HTTP request descriptor is malformed') };
			}
			const { method, url, headers, body } = request.value;
			const target = URL.parse(url);
			if (target === null || (target.protocol !== 'https:' && target.hostname !== 'localhost' && target.hostname !== '127.0.0.1')) {
				return { _tag: 'Failure', error: makeWireError('connector.refused', 'Integration requests must be HTTPS outside localhost') };
			}
			if (options.allowedHosts !== undefined && !options.allowedHosts.includes(target.host)) {
				return { _tag: 'Failure', error: makeWireError('connector.refused', `${target.host} is not an allowed integration host`) };
			}
			const sends = body !== undefined && method !== 'GET';
			try {
				const response = await perform(target.toString(), {
					method,
					// `content-type` is stated by whoever serialises, which is this function — an outbound
					// delivery that posted JSON without saying so is a delivery most receivers answer 415 to,
					// and a 415 is a 4xx, so it would never be retried. Both defaults sit before the declared
					// headers so a binding that names either one still wins.
					headers: { accept: 'application/json', ...(sends ? { 'content-type': 'application/json' } : {}), ...headers },
					...(sends ? { body: JSON.stringify(body) } : {}),
					signal
				});
				const text = await response.text();
				if (text.length > maxResponseBytes) {
					return { _tag: 'Failure', error: makeWireError('connector.too_large', `Integration response exceeded ${maxResponseBytes} bytes`) };
				}
				// A non-JSON body is not a transport failure — a 502 from a proxy arrives as HTML, and the
				// runtime's retry policy needs to see the 502 rather than a decode error standing in for it.
				const parsed: Schema.Json = text === '' ? null : jsonOrText(text);
				return {
					_tag: 'Success',
					value: {
						output: {
							status: response.status,
							headers: Object.fromEntries([...response.headers].map(([name, value]) => [name.toLowerCase(), value])),
							body: parsed
						}
					}
				};
			} catch (cause) {
				return {
					_tag: 'Failure',
					error: makeWireError('connector.transport', cause instanceof Error ? cause.message : String(cause), {
						retryable: !signal.aborted,
						outcome: 'unknown'
					})
				};
			}
		}
	};
};

const jsonOrText = (text: string): Schema.Json => {
	const decoded = Schema.decodeUnknownExit(Schema.fromJsonString(Schema.Json))(text);
	return decoded._tag === 'Success' ? decoded.value : text;
};
