/// <reference types="node" />
// The public network guard every host-side outbound request shares (§3.3.8, L-BOLT-366): HTTPS only, DNS resolved
// once and the checked address pinned (no private, loopback or reserved network), redirects re-checked hop by hop,
// bounded bodies. `publicFetch` puts it behind a `fetch` shape for the http driver; a host's page reader uses the parts.
import { Effect, Result, Schema } from 'effect';
import { FacilityFailure } from '../decl/errors.ts';
import { Port, type PortFailure } from './port.ts';
import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP, Socket, type LookupFunction } from 'node:net';
import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';

export const WEB_PAGE_BYTE_LIMIT = 2 * 1024 * 1024;

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

export type Address = { address: string; family: number };
export type Resolve = (hostname: string) => Promise<readonly Address[]>;

/** A TCP destination is checked independently of HTTP's protocol and port restrictions. */
export const publicDestination = Effect.fn('Network.publicDestination')(function* (
	hostname: string,
	port: number,
	resolve: Resolve = (host) => lookup(host, { all: true })
) {
	const host = hostname.replace(/^\[|\]$/g, '');
	if (
		!Number.isInteger(port) ||
		port < 1 ||
		port > 65535 ||
		host === '' ||
		/[\s\/\\@%?#\x00-\x1f]/.test(host)
	)
		return yield* Effect.fail(invalid('The outbound hostname or port is invalid.'));
	const addresses = isIP(host)
		? [{ address: host, family: isIP(host) }]
		: yield* Port.attempt('network', () => resolve(host));
	if (
		addresses.some(
			(entry) => isIP(entry.address) !== entry.family || !isPublicWebAddress(entry.address)
		)
	)
		return yield* Effect.fail(
			invalid('Outbound connections cannot reach private or reserved networks.')
		);
	const address = addresses.find((entry) => entry.family === 4) ?? addresses[0];
	if (address === undefined)
		return yield* Effect.fail(invalid('The outbound hostname resolved to no addresses.'));
	return { hostname: host, port, address, addresses };
});

/** Node's connector receives only the already validated set, including Happy Eyeballs' all-address lookup. */
export const pinnedLookup =
	(addresses: readonly Address[]): LookupFunction =>
	(_host, options, callback) => {
		const family = options.family;
		const selected =
			family === 4 || family === 6
				? addresses.filter((address) => address.family === family)
				: addresses;
		queueMicrotask(() => {
			if (selected.length === 0) callback(new Error('No checked address matches this family.'), []);
			else if (options.all) callback(null, [...selected]);
			else {
				const address = selected[0];
				if (address === undefined)
					callback(new Error('No checked address matches this family.'), []);
				else callback(null, address.address, address.family);
			}
		});
	};

/** Every invocation resolves again; only checked numeric addresses reach the actual socket. */
export const connectPublic = Effect.fn('Network.connectPublic')(function* (
	hostname: string,
	port: number,
	resolve?: Resolve
) {
	const destination = yield* publicDestination(hostname, port, resolve);
	let last: FacilityFailure | undefined;
	for (const address of orderAddresses(destination.addresses)) {
		const socket = yield* Effect.acquireRelease(
			Effect.sync(() => new Socket()),
			(socket) =>
				Effect.sync(() => {
					socket.destroy();
				})
		);
		const connected = yield* Effect.callback<Socket, FacilityFailure>((resume) => {
			const ready = () => resume(Effect.succeed(socket));
			const error = (cause: Error) => resume(Effect.fail(failed(cause)));
			socket.once('connect', ready);
			socket.once('error', error);
			const started = Result.try(() =>
				socket.connect({
					host: address.address,
					port,
					family: address.family
				})
			);
			if (Result.isFailure(started)) resume(Effect.fail(failed(started.failure)));
			return Effect.sync(() => {
				socket.removeListener('connect', ready);
				socket.removeListener('error', error);
			});
		}).pipe(
			Effect.onError(() =>
				Effect.sync(() => {
					socket.destroy();
				})
			),
			Effect.onInterrupt(() =>
				Effect.sync(() => {
					socket.destroy();
				})
			),
			Effect.result
		);
		if (Result.isSuccess(connected)) return connected.success;
		last = connected.failure;
	}
	return yield* Effect.fail(last ?? failed(new Error('No public address could be connected.')));
});

const isLoopbackName = (host: string): boolean =>
	host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '::1';
const isLoopbackAddress = (address: string): boolean =>
	address === '::1' || address.startsWith('127.');

/**
 * The addresses `url` may be reached on: HTTPS on 443 without credentials, every resolved address public. `allowLoopback`
 * (a development host only, L-BOLT-366) also admits this machine's own names (`localhost`, `*.localhost`, `127.0.0.1`,
 * `::1`) over HTTP or HTTPS on any port, when every address they resolve to is loopback; nothing else private, ever.
 */
export const publicAddresses = (
	url: URL,
	resolve: Resolve = (host) => lookup(host, { all: true }),
	allowLoopback = false
) =>
	Effect.gen(function* () {
		const hostname = url.hostname.replace(/^\[|\]$/g, '');
		const loopback =
			allowLoopback &&
			isLoopbackName(hostname) &&
			(url.protocol === 'http:' || url.protocol === 'https:');
		if (
			url.username ||
			url.password ||
			(!loopback && (url.protocol !== 'https:' || (url.port && url.port !== '443')))
		)
			return yield* Effect.fail(
				invalid('Outbound requests require HTTPS without credentials or custom ports.')
			);
		if (!loopback) return (yield* publicDestination(hostname, 443, resolve)).addresses;
		const addresses = isIP(hostname)
			? [{ address: hostname, family: isIP(hostname) }]
			: yield* Port.attempt('web', () => resolve(hostname));
		if (
			addresses.length === 0 ||
			addresses.some((entry) =>
				loopback ? !isLoopbackAddress(entry.address) : !isPublicWebAddress(entry.address)
			)
		)
			return yield* Effect.fail(
				invalid('Outbound requests cannot reach private or reserved networks.')
			);
		return addresses;
	});

const invalid = (message: string) => new FacilityFailure({ kind: 'invalid', message });
const failed = (error: unknown) =>
	new FacilityFailure({
		kind: 'upstream',
		message: error instanceof Error ? error.message : 'the request failed'
	});
const unzipPage = promisify(gunzip);
type PageResponse = Readonly<{
	status: number;
	location?: string;
	contentType: string;
	headers?: Readonly<Record<string, string>>;
	body: string | Uint8Array;
}>;
export type PageWrite = Readonly<{ method: string; body?: string }>;
const CONNECT_PHASE_CODES: ReadonlySet<string> = new Set([
	'ENETUNREACH',
	'EHOSTUNREACH',
	'EADDRNOTAVAIL',
	'ECONNREFUSED',
	'ETIMEDOUT'
]);
const errorCode = (cause: unknown): string | undefined => {
	const code = cause instanceof Error ? Reflect.get(cause, 'code') : undefined;
	return typeof code === 'string' ? code : undefined;
};
const orderAddresses = (addresses: readonly Address[]): readonly Address[] => [
	...addresses.filter((entry) => entry.family === 4),
	...addresses.filter((entry) => entry.family !== 4)
];
class ConnectFailure extends Schema.TaggedError<ConnectFailure>()('ConnectFailure', {
	address: Schema.Struct({ address: Schema.String, family: Schema.Number }),
	message: Schema.String
}) {}

const attemptPage = (
	request: typeof httpsRequest,
	url: URL,
	address: Address,
	headers: Readonly<Record<string, string>>,
	write: PageWrite | undefined
) =>
	Effect.scoped(
		Effect.gen(function* () {
			const signal = yield* Effect.abortSignal;
			const raw = yield* Effect.callback<
				PageResponse & { gzip?: boolean },
				FacilityFailure | ConnectFailure
			>((resume) => {
				let connected = false;
				const req = request(
					url,
					{
						method: write?.method ?? 'GET',
						signal,
						family: address.family,
						agent: false,
						lookup: (_hostname, _options, callback) => {
							setImmediate(() => callback(null, address.address, address.family));
						},
						headers: {
							accept: 'text/html,application/pdf,application/json,text/plain,application/xml',
							'accept-encoding': 'identity',
							// the conventional compatible form, still naming the reader: CDN rules refuse a bare product token
							'user-agent':
								'Mozilla/5.0 (compatible; Norbital-Public-Page-Reader/1.0; +https://norbital.ai)',
							...headers
						}
					},
					(response) => {
						connected = true;
						const status = response.statusCode ?? 0,
							location = response.headers.location;
						const responseHeaders = Object.fromEntries(
							Object.entries(response.headers).map(([name, value]) => [
								name.toLowerCase(),
								Array.isArray(value) ? value.join(', ') : (value ?? '')
							])
						);
						if (status >= 300 && status < 400) {
							response.destroy();
							resume(
								Effect.succeed({
									status,
									...(location ? { location } : {}),
									headers: responseHeaders,
									contentType: '',
									body: ''
								})
							);
							return;
						}
						const chunks: Buffer[] = [];
						let bytes = 0;
						response.on('data', (chunk: Buffer) => {
							bytes += chunk.byteLength;
							if (bytes > WEB_PAGE_BYTE_LIMIT)
								response.destroy(new Error('The response exceeds the 2 MiB limit.'));
							else chunks.push(chunk);
						});
						response.on('error', (error) => resume(Effect.fail(failed(error))));
						response.on('end', () =>
							resume(
								Effect.succeed({
									status,
									headers: responseHeaders,
									contentType: response.headers['content-type'] ?? '',
									body: Buffer.concat(chunks),
									gzip: response.headers['content-encoding'] === 'gzip'
								})
							)
						);
					}
				);
				req.on('error', (cause: Error) => {
					const code = errorCode(cause);
					resume(
						Effect.fail(
							!connected && code !== undefined && CONNECT_PHASE_CODES.has(code)
								? new ConnectFailure({ address, message: cause.message })
								: failed(cause)
						)
					);
				});
				req.on('socket', (socket) =>
					socket.once('connect', () => {
						connected = true;
					})
				);
				req.end(write?.body);
				return Effect.sync(() => {
					req.destroy();
				});
			});
			if (raw.gzip && raw.body instanceof Uint8Array) {
				const body = raw.body;
				const bytes = yield* Port.attempt('web', () =>
					unzipPage(body, { maxOutputLength: WEB_PAGE_BYTE_LIMIT })
				);
				return { ...raw, body: new Uint8Array(bytes) };
			}
			return raw;
		})
	);

export const makeRequestPage =
	(request: typeof httpsRequest = httpsRequest) =>
	(
		url: URL,
		addresses: readonly Address[],
		headers: Readonly<Record<string, string>> = {},
		write?: PageWrite
	): Effect.Effect<PageResponse, PortFailure> =>
		Effect.gen(function* () {
			let last: ConnectFailure | undefined;
			for (const address of orderAddresses(addresses)) {
				const result = yield* attemptPage(
					url.protocol === 'http:' ? httpRequest : request,
					url,
					address,
					headers,
					write
				).pipe(Effect.catchTag('ConnectFailure', (error) => Effect.succeed(error)));
				if (result instanceof ConnectFailure) last = result;
				else return result;
			}
			return yield* Effect.fail(
				failed(
					new Error(
						last === undefined
							? 'The host has no address to connect to.'
							: `The host could not be reached on any address; last ${last.address.address}: ${last.message}`
					)
				)
			);
		});
type RequestPage = ReturnType<typeof makeRequestPage>;
const RESERVED = new Set([
	'host',
	'connection',
	'content-length',
	'transfer-encoding',
	'upgrade',
	'te',
	'trailer',
	'accept-encoding'
]);
const MAX_REDIRECTS = 5,
	TIMEOUT_MS = 30_000;

type PublicRequestOptions = { resolve?: Resolve; request?: RequestPage; allowLoopback?: boolean };

/** Guarded HTTP work composed directly by the engine; its caller owns interruption. */
export function publicRequest(
	input: Parameters<typeof fetch>[0],
	init: RequestInit = {},
	options: PublicRequestOptions = {}
): Effect.Effect<Response, PortFailure> {
	const request = options.request ?? makeRequestPage();
	return Effect.gen(function* () {
		let headers: Record<string, string> = yield* Effect.try({
			try: () =>
				Object.fromEntries(
					new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined))
				),
			catch: failed
		});
		if (Object.keys(headers).some((name) => RESERVED.has(name) || name.startsWith('proxy-')))
			return yield* Effect.fail(invalid('An http request cannot set transport headers.'));
		let target = yield* Effect.try({
			try: () => new URL(input instanceof Request ? input.url : String(input)),
			catch: () => invalid('The request URL is invalid.')
		});
		let method = (init.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
		let body =
			init.body == null
				? input instanceof Request && method !== 'GET'
					? yield* Port.attempt('web', () => input.clone().text())
					: undefined
				: String(init.body);
		for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
			const addresses = yield* publicAddresses(target, options.resolve, options.allowLoopback);
			const response = yield* request(
				target,
				addresses,
				headers,
				method === 'GET' ? undefined : { method, ...(body === undefined ? {} : { body }) }
			);
			if (response.status >= 300 && response.status < 400 && response.location) {
				const location = response.location;
				const next = yield* Effect.try({
					try: () => new URL(location, target),
					catch: failed
				});
				if (next.origin !== target.origin)
					headers = headers['accept'] === undefined ? {} : { accept: headers['accept'] };
				if (response.status !== 307 && response.status !== 308 && method !== 'GET') {
					method = 'GET';
					body = undefined;
					delete headers['content-type'];
				}
				target = next;
				continue;
			}
			return yield* Effect.try({
				try: () => {
					const empty =
						response.status === 204 || response.status === 205 || response.status === 304;
					const bytes =
						typeof response.body === 'string' ? response.body : new Uint8Array(response.body);
					return new Response(empty ? null : bytes, {
						status: response.status,
						headers: response.headers ?? {}
					});
				},
				catch: failed
			});
		}
		return yield* Effect.fail(invalid('The request exceeded five redirects.'));
	}).pipe(Port.call('web', TIMEOUT_MS));
}

/** The provider's fetch ABI runs guarded work on its already supplied scoped host runner. */
export function publicFetch(
	run: (
		effect: Effect.Effect<Response, PortFailure>,
		options?: { readonly signal?: AbortSignal | undefined }
	) => Promise<Response>,
	options: PublicRequestOptions = {}
): typeof fetch {
	return (input, init = {}) =>
		run(publicRequest(input, init, options), {
			signal: init.signal ?? (input instanceof Request ? input.signal : undefined)
		});
}
