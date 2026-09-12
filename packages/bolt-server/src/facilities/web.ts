import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';
import { Schema } from 'effect';
import { getErrorMessage } from '@norbital-ai/std';
import { extractDocumentText } from './documents.js';
import {
	ConnectorRequest,
	failure,
	makeWireError,
	success,
	type ConnectorResponse,
	type FacilityBinding
} from '@norbital-ai/bolt-protocol';
import {
	WebPageRequest,
	WEB_PAGE_BYTE_LIMIT,
	WEB_READ_OPERATION
} from '@norbital-ai/bolt-protocol';

const excluded = new BlockList();
for (const [network, prefix] of [
	['0.0.0.0', 8],
	['10.0.0.0', 8],
	['100.64.0.0', 10],
	['127.0.0.0', 8],
	['169.254.0.0', 16],
	['172.16.0.0', 12],
	['192.0.0.0', 24],
	['192.0.2.0', 24],
	['192.168.0.0', 16],
	['198.18.0.0', 15],
	['198.51.100.0', 24],
	['203.0.113.0', 24],
	['224.0.0.0', 3]
] as const)
	excluded.addSubnet(network, prefix, 'ipv4');
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
for (const [network, prefix] of [
	['2001::', 32],
	['2001:db8::', 32],
	['2002::', 16]
] as const)
	excluded.addSubnet(network, prefix, 'ipv6');

export const isPublicWebAddress = (address: string): boolean => {
	const family = isIP(address);
	return family === 4
		? !excluded.check(address, 'ipv4')
		: family === 6 && globalV6.check(address, 'ipv6') && !excluded.check(address, 'ipv6');
};

type Address = Awaited<ReturnType<typeof lookup>>;
const isString = Schema.is(Schema.String);
const unzipPage = promisify(gunzip);
type PageResponse = Readonly<{
	status: number;
	location?: string;
	contentType: string;
	headers?: Readonly<Record<string, string>>;
	body: string | Uint8Array;
}>;

/**
 * Failures raised while the socket is still being connected. One of these on an address means the
 * next resolved address is tried; anything else (TLS, reset mid-response, the byte limit) is final.
 */
const CONNECT_PHASE_CODES: ReadonlySet<string> = new Set([
	'ENETUNREACH',
	'EHOSTUNREACH',
	'EADDRNOTAVAIL',
	'ECONNREFUSED',
	'ETIMEDOUT'
]);

const errorCode = (cause: unknown): string | undefined => {
	const code = cause instanceof Error ? Reflect.get(cause, 'code') : undefined;
	return isString(code) ? code : undefined;
};

/** IPv4 first, then IPv6, each family in resolver order: the container may have no IPv6 route. */
const orderAddresses = (addresses: readonly Address[]): readonly Address[] => [
	...addresses.filter((entry) => entry.family === 4),
	...addresses.filter((entry) => entry.family !== 4)
];

/** A connect-phase failure on one address; the next address is still worth trying. */
class ConnectFailure extends Error {
	readonly address: Address;
	override readonly cause: Error;
	constructor(address: Address, cause: Error) {
		super(`${address.address}: ${cause.message}`);
		this.address = address;
		this.cause = cause;
	}
}

/**
 * One attempt against one pinned address, retaining the hostname for TLS and Host.
 *
 * `error` is attached before the request can fail, and the pinned `lookup` answers on a later
 * macrotask rather than synchronously: `http` attaches its own socket listeners on the tick after
 * `connect`, so a connect that fails inside a synchronous callback emitted `error` on a socket
 * nobody was listening to yet, and that is a process-level uncaught exception, not a failed call.
 */
const attemptPage = (
	request: typeof httpsRequest,
	url: URL,
	address: Address,
	signal: AbortSignal,
	headers: Readonly<Record<string, string>>
): Promise<PageResponse> =>
	new Promise((resolve, reject) => {
		let connected = false;
		const req = request(
			url,
			{
				method: 'GET',
				signal,
				family: address.family,
				agent: false,
				lookup: (_hostname, _options, callback) => {
					setImmediate(() => callback(null, address.address, address.family));
				},
				headers: {
					accept: 'text/html,application/pdf,application/json,text/plain,application/xml',
					'accept-encoding': 'identity',
					'user-agent': 'Norbital-Public-Page-Reader/1.0',
					...headers
				}
			},
			(response) => {
				connected = true;
				const status = response.statusCode ?? 0;
				const location = response.headers.location;
				const responseHeaders = Object.fromEntries(
					Object.entries(response.headers).map(([name, value]) => [
						name.toLowerCase(),
						Array.isArray(value) ? value.join(', ') : (value ?? '')
					])
				);
				if (status >= 300 && status < 400) {
					response.destroy();
					resolve({
						status,
						...(location ? { location } : {}),
						headers: responseHeaders,
						contentType: '',
						body: ''
					});
					return;
				}
				const chunks: Buffer[] = [];
				let bytes = 0;
				response.on('data', (chunk: Buffer) => {
					bytes += chunk.byteLength;
					if (bytes > WEB_PAGE_BYTE_LIMIT)
						response.destroy(new Error('Public page exceeds the 2 MiB limit.'));
					else chunks.push(chunk);
				});
				response.on('error', reject);
				response.on('end', () => {
					const body = Buffer.concat(chunks);
					// Some official sites send gzip even when Accept-Encoding is identity.
					const decoded =
						response.headers['content-encoding'] === 'gzip'
							? unzipPage(body, { maxOutputLength: WEB_PAGE_BYTE_LIMIT })
							: Promise.resolve(body);
					decoded.then(
						(body) =>
							resolve({
								status,
								headers: responseHeaders,
								contentType: response.headers['content-type'] ?? '',
								body
							}),
						reject
					);
				});
			}
		);
		req.on('error', (cause: Error) => {
			const code = errorCode(cause);
			reject(
				!connected && code !== undefined && CONNECT_PHASE_CODES.has(code)
					? new ConnectFailure(address, cause)
					: cause
			);
		});
		req.on('socket', (socket) => socket.once('connect', () => (connected = true)));
		req.end();
	});

/** Tries the checked addresses in order, IPv4 before IPv6, moving on after a connect-phase failure. */
export const makeRequestPage =
	(request: typeof httpsRequest = httpsRequest) =>
	async (
		url: URL,
		addresses: readonly Address[],
		signal: AbortSignal,
		headers: Readonly<Record<string, string>> = {}
	): Promise<PageResponse> => {
		let last: ConnectFailure | undefined;
		for (const address of orderAddresses(addresses)) {
			signal.throwIfAborted();
			try {
				// repository-health:allow A6 -- Addresses are fallbacks for one another; the second is tried only after the first fails to connect.
				return await attemptPage(request, url, address, signal, headers);
			} catch (cause) {
				if (!(cause instanceof ConnectFailure)) throw cause;
				last = cause;
			}
		}
		throw new Error(
			last === undefined
				? 'Public page has no address to connect to.'
				: `Public page could not be reached on any address; last ${last.address.address}: ${last.cause.message}`
		);
	};

const requestPage = makeRequestPage();

/** Portable host binding: public HTTPS GET only, bounded bodies, pinned DNS and checked redirects. */
export const makeWebConnectorBinding = (
	options: {
		readonly resolve?: (hostname: string) => Promise<readonly Address[]>;
		readonly request?: typeof requestPage;
	} = {}
): FacilityBinding<ConnectorRequest, ConnectorResponse> => ({
	call: async (_metadata, input, signal) => {
		try {
			const decoded = Schema.decodeUnknownSync(ConnectorRequest)(input);
			if (decoded.connector !== 'web' || decoded.operation !== WEB_READ_OPERATION)
				throw new Error('This binding only reads public web pages.');
			const { url } = Schema.decodeUnknownSync(WebPageRequest)(decoded.input);
			const bounded = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
			let target = new URL(url);
			for (let redirects = 0; redirects <= 5; redirects++) {
				bounded.throwIfAborted();
				if (
					target.protocol !== 'https:' ||
					target.username ||
					target.password ||
					(target.port && target.port !== '443')
				)
					throw new Error('Public pages require HTTPS without credentials or custom ports.');
				const hostname = target.hostname.replace(/^\[|\]$/g, '');
				const addresses = isIP(hostname)
					? [{ address: hostname, family: isIP(hostname) }]
					: await (options.resolve ?? ((host) => lookup(host, { all: true })))(hostname); // repository-health:allow A6 -- Each redirect's response supplies the next hostname; DNS must be checked sequentially.
				if (addresses.length === 0 || addresses.some((entry) => !isPublicWebAddress(entry.address)))
					throw new Error('Public-page retrieval cannot reach private or reserved networks.');
				bounded.throwIfAborted();
				// repository-health:allow A6 -- Redirect responses decide the next URL; requests must remain sequential to validate each destination.
				const response = await (options.request ?? requestPage)(target, addresses, bounded);
				if (response.status >= 300 && response.status < 400 && response.location) {
					target = new URL(response.location, target);
					continue;
				}
				if (response.status < 200 || response.status >= 300)
					throw new Error(`Public page returned HTTP ${response.status}.`);
				const bytes = isString(response.body)
					? new TextEncoder().encode(response.body)
					: response.body;
				if (bytes.byteLength > WEB_PAGE_BYTE_LIMIT)
					throw new Error('Public page exceeds the 2 MiB limit.');
				// repository-health:allow A6 -- Decode only the final accepted redirect response, then return; no pages can be decoded in parallel here.
				const document = await extractDocumentText(bytes, response.contentType, bounded);
				return success({
					output: { url: target.toString(), contentType: response.contentType, ...document }
				});
			}
			throw new Error('Public page exceeded five redirects.');
		} catch (cause) {
			return failure(
				makeWireError('web.read_failed', getErrorMessage(cause), {
					retryable: false,
					outcome: 'known'
				})
			);
		}
	}
});
