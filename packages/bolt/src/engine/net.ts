/// <reference types="node" />
// The public network guard every host-side outbound request shares (§3.3.8, L-BOLT-366): HTTPS only, DNS resolved
// once and the checked address pinned (no private, loopback or reserved network), redirects re-checked hop by hop,
// bounded bodies. `publicFetch` puts it behind a `fetch` shape for connections; a host's page reader uses the parts.
import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';

export const WEB_PAGE_BYTE_LIMIT = 2 * 1024 * 1024;

const excluded = new BlockList();
for (const [network, prefix] of [
	['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24],
	['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3],
] as const) excluded.addSubnet(network, prefix, 'ipv4');
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
for (const [network, prefix] of [['2001::', 32], ['2001:db8::', 32], ['2002::', 16]] as const) excluded.addSubnet(network, prefix, 'ipv6');

export const isPublicWebAddress = (address: string): boolean => {
	const family = isIP(address);
	return family === 4 ? !excluded.check(address, 'ipv4') : family === 6 && globalV6.check(address, 'ipv6') && !excluded.check(address, 'ipv6');
};

export type Address = { address: string; family: number };
export type Resolve = (hostname: string) => Promise<readonly Address[]>;

const isLoopbackName = (host: string): boolean => host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '::1';
const isLoopbackAddress = (address: string): boolean => address === '::1' || address.startsWith('127.');

/**
 * The addresses `url` may be reached on: HTTPS on 443 without credentials, every resolved address public. `allowLoopback`
 * (a development host only, L-BOLT-366) also admits this machine's own names (`localhost`, `*.localhost`, `127.0.0.1`,
 * `::1`) over HTTP or HTTPS on any port, when every address they resolve to is loopback; nothing else private, ever.
 */
export async function publicAddresses(url: URL, resolve: Resolve = (host) => lookup(host, { all: true }), allowLoopback = false): Promise<readonly Address[]> {
	const hostname = url.hostname.replace(/^\[|\]$/g, '');
	const loopback = allowLoopback && isLoopbackName(hostname) && (url.protocol === 'http:' || url.protocol === 'https:');
	if (url.username || url.password || (!loopback && (url.protocol !== 'https:' || (url.port && url.port !== '443'))))
		throw new Error('Outbound requests require HTTPS without credentials or custom ports.');
	const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await resolve(hostname);
	if (addresses.length === 0 || addresses.some((entry) => loopback ? !isLoopbackAddress(entry.address) : !isPublicWebAddress(entry.address)))
		throw new Error('Outbound requests cannot reach private or reserved networks.');
	return addresses;
}

const unzipPage = promisify(gunzip);
export type PageResponse = Readonly<{ status: number; location?: string; contentType: string; headers?: Readonly<Record<string, string>>; body: string | Uint8Array }>;
/** A request that is not a plain read: its method and, for the methods that carry one, its body. */
export type PageWrite = Readonly<{ method: string; body?: string }>;

/** Failures raised while the socket is still connecting: the next resolved address is tried; anything else is final. */
const CONNECT_PHASE_CODES: ReadonlySet<string> = new Set(['ENETUNREACH', 'EHOSTUNREACH', 'EADDRNOTAVAIL', 'ECONNREFUSED', 'ETIMEDOUT']);
const errorCode = (cause: unknown): string | undefined => {
	const code = cause instanceof Error ? Reflect.get(cause, 'code') : undefined;
	return typeof code === 'string' ? code : undefined;
};
/** IPv4 first, then IPv6, each family in resolver order: the container may have no IPv6 route. */
const orderAddresses = (addresses: readonly Address[]): readonly Address[] =>
	[...addresses.filter((entry) => entry.family === 4), ...addresses.filter((entry) => entry.family !== 4)];

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
 * `error` is attached before the request can fail, and the pinned `lookup` answers on a later macrotask: `http` attaches
 * its own socket listeners on the tick after `connect`, so a connect failing inside a synchronous callback emitted
 * `error` on a socket nobody was listening to yet — a process-level uncaught exception, not a failed call.
 */
const attemptPage = (request: typeof httpsRequest, url: URL, address: Address, signal: AbortSignal,
	headers: Readonly<Record<string, string>>, write: PageWrite | undefined): Promise<PageResponse> =>
	new Promise((resolve, reject) => {
		let connected = false;
		const req = request(url, {
			method: write?.method ?? 'GET', signal, family: address.family, agent: false,
			lookup: (_hostname, _options, callback) => { setImmediate(() => callback(null, address.address, address.family)); },
			headers: { accept: 'text/html,application/pdf,application/json,text/plain,application/xml', 'accept-encoding': 'identity',
				'user-agent': 'Norbital-Public-Page-Reader/1.0', ...headers },
		}, (response) => {
			connected = true;
			const status = response.statusCode ?? 0;
			const location = response.headers.location;
			const responseHeaders = Object.fromEntries(Object.entries(response.headers)
				.map(([name, value]) => [name.toLowerCase(), Array.isArray(value) ? value.join(', ') : (value ?? '')]));
			if (status >= 300 && status < 400) {
				response.destroy();
				resolve({ status, ...(location ? { location } : {}), headers: responseHeaders, contentType: '', body: '' });
				return;
			}
			const chunks: Buffer[] = [];
			let bytes = 0;
			response.on('data', (chunk: Buffer) => {
				bytes += chunk.byteLength;
				if (bytes > WEB_PAGE_BYTE_LIMIT) response.destroy(new Error('The response exceeds the 2 MiB limit.'));
				else chunks.push(chunk);
			});
			response.on('error', reject);
			response.on('end', () => {
				const body = Buffer.concat(chunks);
				// some official sites send gzip even when Accept-Encoding is identity
				const decoded = response.headers['content-encoding'] === 'gzip' ? unzipPage(body, { maxOutputLength: WEB_PAGE_BYTE_LIMIT }) : Promise.resolve(body);
				decoded.then((body) => resolve({ status, headers: responseHeaders, contentType: response.headers['content-type'] ?? '', body }), reject);
			});
		});
		req.on('error', (cause: Error) => {
			const code = errorCode(cause);
			reject(!connected && code !== undefined && CONNECT_PHASE_CODES.has(code) ? new ConnectFailure(address, cause) : cause);
		});
		req.on('socket', (socket) => socket.once('connect', () => (connected = true)));
		req.end(write?.body);
	});

/** Tries the checked addresses in order, IPv4 before IPv6, moving on after a connect-phase failure. */
export const makeRequestPage = (request: typeof httpsRequest = httpsRequest) =>
	async (url: URL, addresses: readonly Address[], signal: AbortSignal, headers: Readonly<Record<string, string>> = {}, write?: PageWrite): Promise<PageResponse> => {
		let last: ConnectFailure | undefined;
		for (const address of orderAddresses(addresses)) {
			signal.throwIfAborted();
			try {
				return await attemptPage(url.protocol === 'http:' ? httpRequest : request, url, address, signal, headers, write);
			} catch (cause) {
				if (!(cause instanceof ConnectFailure)) throw cause;
				last = cause;
			}
		}
		throw new Error(last === undefined ? 'The host has no address to connect to.'
			: `The host could not be reached on any address; last ${last.address.address}: ${last.cause.message}`);
	};
export type RequestPage = ReturnType<typeof makeRequestPage>;

const RESERVED = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'accept-encoding']);
const MAX_REDIRECTS = 5, TIMEOUT_MS = 30_000;

/**
 * A `fetch` over the guard, for connections: public HTTPS only with the checked address pinned, no transport-header
 * overrides, at most five redirects each re-checked, a cross-origin hop dropping every caller header but `accept` (one
 * of them is the credential), a `301`/`302`/`303` answer to a write continued as a bodiless GET, a 30 s deadline over
 * the whole request and a 2 MiB body. Only string and form bodies are sent (what connections send). `allowLoopback` is
 * `publicAddresses`' development-only admission of this machine's own names.
 */
export function publicFetch(o: { resolve?: Resolve; request?: RequestPage; allowLoopback?: boolean } = {}): typeof fetch {
	const request = o.request ?? makeRequestPage();
	return (async (input: string | URL, init: RequestInit = {}): Promise<Response> => {
		let headers: Record<string, string> = Object.fromEntries(new Headers(init.headers));
		if (Object.keys(headers).some((n) => RESERVED.has(n) || n.startsWith('proxy-'))) throw new Error('A connection cannot set transport headers.');
		const signal = AbortSignal.any([...(init.signal ? [init.signal] : []), AbortSignal.timeout(TIMEOUT_MS)]);
		let target = new URL(input), method = (init.method ?? 'GET').toUpperCase();
		let body = init.body === undefined || init.body === null ? undefined : String(init.body);
		for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
			signal.throwIfAborted();
			const addresses = await publicAddresses(target, o.resolve, o.allowLoopback); // each hop's hostname is checked in turn
			signal.throwIfAborted();
			const r = await request(target, addresses, signal, headers, method === 'GET' ? undefined : { method, ...(body === undefined ? {} : { body }) });
			if (r.status >= 300 && r.status < 400 && r.location) {
				const next = new URL(r.location, target);
				if (next.origin !== target.origin) headers = headers['accept'] === undefined ? {} : { accept: headers['accept'] };
				if (r.status !== 307 && r.status !== 308 && method !== 'GET') {
					method = 'GET';
					body = undefined;
					delete headers['content-type'];
				}
				target = next;
				continue;
			}
			const empty = r.status === 204 || r.status === 205 || r.status === 304;
			return new Response(empty ? null : r.body as BodyInit, { status: r.status, headers: r.headers ?? {} });
		}
		throw new Error('The request exceeded five redirects.');
	}) as typeof fetch;
}
