/// <reference types="node" />
// The public network guard every host-side outbound request shares: HTTPS only, DNS resolved
// once and the checked address pinned (no private, loopback or reserved network), redirects re-checked hop by hop,
// bounded bodies. `http_port` serves it to the engine (`HttpPort`); `public_fetch` puts it behind a `fetch` shape for the
// http driver; a host's page reader uses the parts.
import { Effect, Result, Schema } from 'effect';
import { FacilityFailure } from '../decl/errors.ts';
import type { HttpFetchOptions, HttpPort, HttpRequest, HttpResponse } from '../engine/contracts.ts';
import { Port, type PortFailure } from '../engine/port.ts';
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

export const is_public_web_address = (address: string): boolean => {
	const family = isIP(address);
	return family === 4
		? !excluded.check(address, 'ipv4')
		: family === 6 && globalV6.check(address, 'ipv6') && !excluded.check(address, 'ipv6');
};

export type Address = { address: string; family: number };
export type Resolve = (hostname: string) => Promise<readonly Address[]>;
const unbracket = (hostname: string) => hostname.replace(/^\[|\]$/g, '');

/** A TCP destination is checked independently of HTTP's protocol and port restrictions. */
export const public_destination = Effect.fn('Network.public_destination')(function* (
	hostname: string,
	port: number,
	resolve: Resolve = (host) => lookup(host, { all: true })
) {
	const host = unbracket(hostname);
	if (
		!Number.isInteger(port) ||
		port < 1 ||
		port > 65535 ||
		host === '' ||
		/[\s\/\\@%?#\x00-\x1f]/.test(host)
	)
		return yield* Effect.fail(FacilityFailure.invalid('The outbound hostname or port is invalid.'));
	const addresses = isIP(host)
		? [{ address: host, family: isIP(host) }]
		: yield* Port.attempt('network', () => resolve(host));
	if (
		addresses.some(
			(entry) => isIP(entry.address) !== entry.family || !is_public_web_address(entry.address)
		)
	)
		return yield* Effect.fail(
			FacilityFailure.invalid('Outbound connections cannot reach private or reserved networks.')
		);
	const address = addresses.find((entry) => entry.family === 4) ?? addresses[0];
	if (address === undefined)
		return yield* Effect.fail(FacilityFailure.invalid('The outbound hostname resolved to no addresses.'));
	return { hostname: host, port, address, addresses };
});

/** Node's connector receives only the already validated set, including Happy Eyeballs' all-address lookup. */
export const pinned_lookup =
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
export const connect_public = Effect.fn('Network.connect_public')(function* (
	hostname: string,
	port: number,
	resolve?: Resolve
) {
	const destination = yield* public_destination(hostname, port, resolve);
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
 * (a development host only) also admits this machine's own names (`localhost`, `*.localhost`, `127.0.0.1`,
 * `::1`) over HTTP or HTTPS on any port, when every address they resolve to is loopback; nothing else private, ever.
 */
export const public_addresses = (
	url: URL,
	resolve: Resolve = (host) => lookup(host, { all: true }),
	allowLoopback = false
) =>
	Effect.gen(function* () {
		const hostname = unbracket(url.hostname);
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
				FacilityFailure.invalid('Outbound requests require HTTPS without credentials or custom ports.')
			);
		if (!loopback) return (yield* public_destination(hostname, 443, resolve)).addresses;
		const addresses = isIP(hostname)
			? [{ address: hostname, family: isIP(hostname) }]
			: yield* Port.attempt('web', () => resolve(hostname));
		if (
			addresses.length === 0 ||
			addresses.some((entry) => !isLoopbackAddress(entry.address))
		)
			return yield* Effect.fail(
				FacilityFailure.invalid('Outbound requests cannot reach private or reserved networks.')
			);
		return addresses;
	});

const too_large = (maxBytes: number) =>
	new FacilityFailure({
		kind: 'too_large',
		message: `The response exceeds the ${maxBytes} byte limit.`
	});
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
export type PageWrite = Readonly<{ method: string; body?: string | Uint8Array }>;
const CONNECT_PHASE_CODES: ReadonlySet<string> = new Set([
	'ENETUNREACH',
	'EHOSTUNREACH',
	'EADDRNOTAVAIL',
	'ECONNREFUSED',
	'ETIMEDOUT'
]);
const errorCode = (cause: unknown): string | undefined => {
	const code: unknown = cause instanceof Error ? Reflect.get(cause, 'code') : undefined;
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
	write: PageWrite | undefined,
	maxBytes: number
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
							Object.entries(response.headers).map(([name, value]): [string, string] => [
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
							if (bytes > maxBytes) {
								resume(Effect.fail(too_large(maxBytes)));
								response.destroy();
							} else chunks.push(chunk);
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
				const bytes = yield* Effect.tryPromise({
					try: () => unzipPage(body, { maxOutputLength: maxBytes }),
					catch: (error) =>
						errorCode(error) === 'ERR_BUFFER_TOO_LARGE' ? too_large(maxBytes) : failed(error)
				});
				return { ...raw, body: new Uint8Array(bytes) };
			}
			return raw;
		})
	);

export const make_request_page =
	(request: typeof httpsRequest = httpsRequest) =>
	(
		url: URL,
		addresses: readonly Address[],
		headers: Readonly<Record<string, string>> = {},
		write?: PageWrite,
		maxBytes: number = WEB_PAGE_BYTE_LIMIT
	): Effect.Effect<PageResponse, PortFailure> =>
		Effect.gen(function* () {
			let last: ConnectFailure | undefined;
			for (const address of orderAddresses(addresses)) {
				const result = yield* attemptPage(
					url.protocol === 'http:' ? httpRequest : request,
					url,
					address,
					headers,
					write,
					maxBytes
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
type RequestPage = ReturnType<typeof make_request_page>;
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

type PublicRequestOptions = {
	resolve?: Resolve;
	request?: RequestPage;
	allowLoopback?: boolean;
	loopbackOnly?: boolean;
};

/** One request under the policy, every redirect hop re-checked; its caller owns the wall and interruption. */
const guarded = (
	request: HttpRequest,
	limits: HttpFetchOptions,
	options: PublicRequestOptions = {}
): Effect.Effect<HttpResponse, PortFailure> => {
	const send = options.request ?? make_request_page();
	return Effect.gen(function* () {
		let headers: Record<string, string> = yield* Effect.try({
			try: () =>
				Object.fromEntries(
					new Headers(request.headers.map(([name, value]): [string, string] => [name, value]))
				),
			catch: failed
		});
		if (Object.keys(headers).some((name) => RESERVED.has(name) || name.startsWith('proxy-')))
			return yield* Effect.fail(FacilityFailure.invalid('An http request cannot set transport headers.'));
		let target = yield* Effect.try({
			try: () => new URL(request.url),
			catch: () => FacilityFailure.invalid('The request URL is invalid.')
		});
		let method = request.method.toUpperCase(),
			body = request.body;
		for (let hop = 0; hop <= limits.redirects; hop++) {
			if (options.loopbackOnly === true && !isLoopbackName(unbracket(target.hostname)))
				return yield* Effect.fail(
					FacilityFailure.invalid(`This host reaches loopback only, not ${target.hostname}.`)
				);
			const addresses = yield* public_addresses(target, options.resolve, options.allowLoopback);
			const response = yield* send(
				target,
				addresses,
				headers,
				method === 'GET' ? undefined : { method, ...(body === undefined ? {} : { body }) },
				limits.max_bytes
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
			const empty = response.status === 204 || response.status === 205 || response.status === 304;
			return {
				status: response.status,
				headers: Object.entries(response.headers ?? {}),
				body: empty
					? new Uint8Array(0)
					: typeof response.body === 'string'
						? new TextEncoder().encode(response.body)
						: response.body
			};
		}
		return yield* Effect.fail(FacilityFailure.invalid(`The request exceeded ${limits.redirects} redirects.`));
	});
};

/** The engine's outbound HTTP (`HttpPort`); the wall is the engine's (`Port.call`). */
export const http_port: HttpPort = {
	fetch: (request, limits, signal) => Effect.runPromise(guarded(request, limits), { signal })
};
/** Outbound HTTP to this machine only (the test kit): every hop to another host is refused. */
export const loopback_http_port: HttpPort = {
	fetch: (request, limits, signal) =>
		Effect.runPromise(guarded(request, limits, { allowLoopback: true, loopbackOnly: true }), {
			signal
		})
};

/** The provider's fetch ABI runs guarded work on its already supplied scoped host runner. */
export function public_fetch(
	run: (
		effect: Effect.Effect<Response, PortFailure>,
		options?: { readonly signal?: AbortSignal | undefined }
	) => Promise<Response>,
	options: PublicRequestOptions = {}
): typeof fetch {
	return (input, init = {}) => {
		const original = input instanceof Request ? input : undefined;
		const method = (init.method ?? original?.method ?? 'GET').toUpperCase();
		const exchange = Effect.gen(function* () {
			const headers = yield* Effect.try({
				try: () => [...new Headers(init.headers ?? original?.headers)],
				catch: failed
			});
			const body =
				method === 'GET'
					? undefined
					: init.body != null
						? yield* Port.attempt('web', () => new Response(init.body).arrayBuffer())
						: original === undefined
							? undefined
							: yield* Port.attempt('web', () => original.clone().arrayBuffer());
			const response = yield* guarded(
				{
					method,
					url: original?.url ?? String(input),
					headers,
					...(body === undefined ? {} : { body: new Uint8Array(body) })
				},
				{ redirects: MAX_REDIRECTS, max_bytes: WEB_PAGE_BYTE_LIMIT },
				options
			);
			return yield* Effect.try({
				try: () =>
					new Response(response.body.byteLength === 0 ? null : new Uint8Array(response.body), {
						status: response.status,
						headers: response.headers.map(([name, value]): [string, string] => [name, value])
					}),
				catch: failed
			});
		}).pipe(Port.call('web', TIMEOUT_MS));
		return run(exchange, { signal: init.signal ?? original?.signal });
	};
}

const request_page = make_request_page();
const unreadable = (message: string) => new FacilityFailure({ kind: 'upstream', message });
/** A host's web reader: one public page's bytes, every redirect hop re-checked, at most `WEB_PAGE_BYTE_LIMIT`. */
export const read_public_page = Effect.fn('Network.read_public_page')(function* (
	url: string,
	options: { readonly resolve?: Resolve; readonly request?: RequestPage } = {}
) {
	if (url === '') return yield* Effect.fail(unreadable('A public page needs a URL.'));
	let target = yield* Effect.try({
		try: () => new URL(url),
		catch: () => unreadable('A public page needs a valid URL.')
	});
	for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
		const addresses = yield* public_addresses(target, options.resolve);
		const response = yield* (options.request ?? request_page)(target, addresses);
		if (response.status >= 300 && response.status < 400 && response.location) {
			const location = response.location;
			target = yield* Effect.try({
				try: () => new URL(location, target),
				catch: () => unreadable('The public page returned an invalid redirect URL.')
			});
			continue;
		}
		if (response.status < 200 || response.status >= 300)
			return yield* Effect.fail(unreadable(`Public page returned HTTP ${response.status}.`));
		const bytes =
			typeof response.body === 'string' ? new TextEncoder().encode(response.body) : response.body;
		if (bytes.byteLength > WEB_PAGE_BYTE_LIMIT)
			return yield* Effect.fail(unreadable('Public page exceeds the 2 MiB limit.'));
		return { url: target.toString(), contentType: response.contentType, bytes };
	}
	return yield* Effect.fail(unreadable('Public page exceeded five redirects.'));
});
