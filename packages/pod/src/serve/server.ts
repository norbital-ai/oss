/**
 * The one HTTP server core shared by both Pod transports.
 *
 * `handlePodRequest` takes a web `Request` and answers with a web `Response`, and `node:http`
 * speaks neither. The translation is small but every part of it has a failure mode that is
 * invisible in the common case — a repeated `set-cookie` collapsed into one, a binary upload
 * decoded as text, a server-sent-events body buffered until it completes — and the pipeline that
 * sits between the socket and the runtime is a security contract: which request is refused before
 * its body is read, and which identity a request may act under, is decided here and only here.
 *
 * The two adapters differ only in which of the optional surfaces they supply. The hosted adapter
 * (`serve/hosted.ts`) fronts the runtime with a shared host token and the host's private
 * `/_host/*` control routes, and trusts identity headers the token proves. The standalone adapter
 * (`serve/standalone.ts`) authenticates every request itself, serves the workspace's static
 * assets and single-page document, and has no token at all — the socket is loopback and the
 * trusted authenticated host is expected in front of it.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { RuntimeFacilityBindings } from '@norbital-ai/platform-utils/runtime/binding';
import { hostTokenMatches, TRUSTED_HOST_TOKEN_HEADER } from '../host/identity.js';
import {
	isVerifiedSubject,
	type HostIdentity,
	type HostIdentityProvider,
	type HostVerifiedSubject
} from '../host/types.js';
import { handlePodRequest } from '../server/entry.js';

/** The host's private control plane, gated by the shared token rather than by identity. */
export const HOST_ROUTE_PREFIX = '/_host/';

/**
 * Headers the runtime reads from its trusted host and never from the client.
 *
 * Identity, plus the token that proves the caller is the host. The runtime believes `x-norbital-*`
 * absolutely, so anything a client sent under these names is removed before the request reaches
 * workspace code — see {@link withHostIdentity}.
 */
const IDENTITY_HEADERS = [
	'x-norbital-user-id',
	'x-norbital-org-id',
	'x-norbital-org-name',
	'x-norbital-base-scope-json',
	'x-norbital-host-token'
] as const;

function appendIncomingHeaders(source: IncomingMessage, target: Headers): void {
	for (const [name, rawValue] of Object.entries(source.headers)) {
		if (Array.isArray(rawValue)) {
			for (const value of rawValue) target.append(name, value);
		} else if (rawValue != null) {
			target.set(name, rawValue);
		}
	}
}

/**
 * Read a request body as bytes.
 *
 * Bytes rather than a string: a spreadsheet import or an image upload is not valid UTF-8, and
 * decoding one to text replaces every byte the decoder does not recognise with U+FFFD. The
 * corruption survives every later step, so the file that arrives is a file nobody sent.
 */
async function readRequestBody(request: IncomingMessage): Promise<Uint8Array | undefined> {
	if (request.method === 'GET' || request.method === 'HEAD') return undefined;
	const chunks: Uint8Array[] = [];
	for await (const chunk of request) {
		chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
	}
	return chunks.length > 0 ? Buffer.concat(chunks) : undefined;
}

/** A `Uint8Array` is a valid `BodyInit`; TypeScript only narrows the generic form. */
function bodyInit(bytes: Uint8Array): BodyInit {
	// stupidity: boundary-cast -- non-data Fetch boundary; the bytes remain unchanged.
	return bytes as unknown as BodyInit;
}

/**
 * Adapt one inbound Node request into the web `Request` the runtime handles.
 *
 * `origin` names the authority the runtime sees. It is not read back from the socket: the request
 * URL is what workspace code parses query parameters out of, and a value that changed with whatever
 * `Host` header arrived would make it client-controlled.
 *
 * `signal` is how the caller says the client hung up. A server-sent-events response never completes
 * on its own, so without it a closed tab leaves the stream producing into nothing.
 */
async function toWebRequest(
	request: IncomingMessage,
	origin: string,
	signal?: AbortSignal
): Promise<Request> {
	const headers = new Headers();
	appendIncomingHeaders(request, headers);
	const body = await readRequestBody(request);
	return new Request(`${origin}${request.url ?? '/'}`, {
		method: request.method,
		headers,
		...(body ? { body: bodyInit(body) } : {}),
		...(signal ? { signal } : {})
	});
}

/**
 * Re-issue a request carrying the identity the host established, and nothing the client sent about
 * identity.
 *
 * Stripping first is what makes any caller safe to trust. The runtime treats `x-norbital-*` as
 * proven, so a client that set those headers itself would otherwise be believed; a provider cannot
 * accidentally pass identity through by forgetting to clear it, because the only identity that
 * survives this function is the one it was given.
 */
async function withHostIdentity(request: Request, identity: HostIdentity): Promise<Request> {
	const headers = new Headers(request.headers);
	for (const name of IDENTITY_HEADERS) headers.delete(name);
	headers.set('x-norbital-user-id', identity.userId);
	headers.set('x-norbital-org-id', identity.organizationId);
	headers.set('x-norbital-org-name', identity.organizationName);
	if (identity.baseScope) {
		headers.set('x-norbital-base-scope-json', JSON.stringify(identity.baseScope));
	}
	const body =
		request.method === 'GET' || request.method === 'HEAD'
			? undefined
			: new Uint8Array(await request.arrayBuffer());
	return new Request(request.url, {
		method: request.method,
		headers,
		...(body && body.length > 0 ? { body: bodyInit(body) } : {}),
		signal: request.signal
	});
}

async function writeWebResponse(response: Response, target: ServerResponse): Promise<void> {
	target.statusCode = response.status;
	// `set-cookie` is the one header that legitimately repeats, and iterating the headers reports it as
	// a single comma-joined value while `setHeader` overwrites. Together they silently reduced any
	// multi-cookie response to one mangled header — which is how signing in could answer 303 to `/`
	// while setting no session at all. `getSetCookie()` returns each cookie separately, and Node
	// accepts the array.
	for (const [name, value] of response.headers) {
		if (name.toLowerCase() === 'set-cookie') continue;
		target.setHeader(name, value);
	}
	const cookies = response.headers.getSetCookie();
	if (cookies.length > 0) target.setHeader('set-cookie', cookies);

	// Stream the body incrementally when present so Server-Sent Events (the sync-engine
	// `/_runtime/sync/stream` endpoint) reach the client as they are produced rather than
	// being collapsed into one chunk. Buffered responses still work — a fully-enqueued body
	// simply flushes in one pass. The loop ends when the producer closes the stream or the
	// client disconnects (the web ReadableStream cancels, breaking the read).
	if (response.body) {
		const reader = response.body.getReader();
		target.on('close', () => {
			reader.cancel().catch(() => {});
		});
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				if (value && !target.writableEnded) target.write(Buffer.from(value));
			}
		} catch {
			// client disconnect or producer error — fall through to end()
		}
		if (!target.writableEnded) target.end();
		return;
	}

	target.end();
}

/** A plain-text refusal. The 401s and the 403 that the pipeline emits are intentionally bare. */
function refuse(response: ServerResponse, status: number, message: string): void {
	response.statusCode = status;
	response.setHeader('content-type', 'text/plain');
	response.end(message);
}

/** Serve one already-resolved asset body, honouring HEAD the way the runtime route does. */
function writeStaticAsset(
	asset: { body: Buffer; contentType: string },
	request: IncomingMessage,
	response: ServerResponse
): void {
	response.statusCode = 200;
	response.setHeader('content-type', asset.contentType);
	response.setHeader('content-length', String(asset.body.byteLength));
	response.end(request.method === 'HEAD' ? undefined : asset.body);
}

export type PodHttpServerOptions = {
	/** The authority the runtime sees on every request. Never read back from the socket. */
	readonly origin: string;
	/** The socket address. */
	readonly bind: { readonly host: string; readonly port: number };
	/** Who a request belongs to, established by whichever side fronts this process. */
	readonly identity: HostIdentityProvider;
	/** The facilities `handlePodRequest` runs tenant traffic against. */
	readonly bindings: RuntimeFacilityBindings;
	/**
	 * The shared host token. When set, every request must carry `TRUSTED_HOST_TOKEN_HEADER`
	 * matching it and is refused 401 before any body is read. The hosted adapter is the only caller.
	 */
	readonly token?: string;
	/**
	 * The host's private control plane, consulted before authentication on every `/_host/*` path.
	 * Returns `true` when it answered. The hosted adapter is the only caller.
	 */
	readonly hostRoutes?: (
		pathname: string,
		request: IncomingMessage,
		response: ServerResponse
	) => Promise<boolean>;
	/**
	 * Pre-auth real-file serving. The standalone adapter is the only caller: the hosted adapter serves no
	 * static assets because the host holds the same build output on disk.
	 */
	readonly staticAssets?: (
		request: IncomingMessage
	) => Promise<{ body: Buffer; contentType: string } | null>;
	/**
	 * The single-page document, served to a request that authenticated and matched no real file.
	 * A deep link has to resolve to the shell rather than a 404, but it is a *document*, so it
	 * belongs behind the session rather than beside the JavaScript. Standalone only.
	 */
	readonly appDocument?: (
		request: IncomingMessage
	) => Promise<{ body: Buffer; contentType: string } | null>;
	/**
	 * Turns an authenticated-but-unnamed subject into a workspace identity, or `null` when the
	 * address has no user and no pending invitation. Without it a verified subject is refused
	 * outright, which is the hosted adapter's behaviour — its provider asserts a full identity or nothing.
	 */
	readonly resolveSubject?: (verified: HostVerifiedSubject) => Promise<HostIdentity | null>;
	/**
	 * The runtime entry point. Defaults to this package's own `server/entry.js`. The standalone
	 * runner passes the *bundled* copy it also loads its workspace into, so workspace registration,
	 * host plugins, and database notifications live in the same module instance every tenant
	 * request runs in; under the hosted adapter the default and the bundle are the same code anyway.
	 */
	readonly handlePodRequest?: (
		request: Request,
		bindings: RuntimeFacilityBindings
	) => Promise<Response>;
	/** Prefix for the unhandled-rejection log line. Defaults to `[pod]`. */
	readonly label?: string;
};

/**
 * One request through the whole pipeline, in the order that is the security contract.
 *
 *   a. The identity provider owns its routes (a login page must be reachable unauthenticated).
 *   b. The shared host token is compared before any body is read, when one is configured.
 *   c. The host's `/_host/*` control plane answers before authentication, when one is configured.
 *   d. Pre-auth static assets serve before authentication, when the adapter serves any.
 *   e. The provider authenticates. `null` is a bare 401; a `Response` is a redirect or challenge.
 *   f. A verified subject is resolved to a workspace identity, or refused (401 hosted, 403 standalone).
 *   g. The single-page document is served to the authenticated request that matched no real file.
 *   h. The request is re-issued with the established identity and handed to the runtime.
 *
 * The hosted and standalone adapters supply disjoint subsets of the optional surfaces, so each
 * step is a no-op for whichever adapter does not own it — but the order never changes.
 */
async function handleConnection(
	options: PodHttpServerOptions,
	request: IncomingMessage,
	response: ServerResponse
): Promise<void> {
	// A client that goes away is how an otherwise endless response ends. The socket closing before
	// the body finished is that signal, and aborting the request is what stops a server-sent-events
	// producer from streaming into a connection nobody is reading.
	const hangUp = new AbortController();
	response.on('close', () => {
		if (!response.writableFinished) hangUp.abort();
	});
	// The web request is created on first use, not eagerly: the hosted adapter must compare the host token
	// — and answer its host routes — before a byte of any request body is read.
	let webRequest: Request | null = null;
	const toWeb = async (): Promise<Request> => {
		webRequest ??= await toWebRequest(request, options.origin, hangUp.signal);
		return webRequest;
	};

	// A provider owns its routes before anything else looks at the request, so a login page is
	// reachable while unauthenticated and is never mistaken for a workspace asset.
	if (options.identity.handleRoute) {
		const routed = await options.identity.handleRoute(await toWeb());
		if (routed) return writeWebResponse(routed, response);
	}

	// The token is what separates the host from everyone else, and every route behind it — tenant
	// traffic included — assumes it held. Compared in constant time, before a byte of any body was
	// read, and only when the adapter configured one.
	if (options.token) {
		const provided = request.headers[TRUSTED_HOST_TOKEN_HEADER];
		if (!hostTokenMatches(typeof provided === 'string' ? provided.trim() : '', options.token)) {
			return refuse(response, 401, 'Unauthorized');
		}
	}

	// The host's private control plane reaches past every tenant-facing check: a command runs jobs
	// and writes system events, and a notification wakes the change feed. The token is therefore
	// the whole of its authorization — and it has already been compared above.
	const pathname = new URL(request.url ?? '/', options.origin).pathname;
	if (options.hostRoutes && pathname.startsWith(HOST_ROUTE_PREFIX)) {
		if (await options.hostRoutes(pathname, request, response)) return;
	}

	// A real file is served before authentication so the shell, scripts, and styles load; the
	// single-page document is deliberately not resolved here, because that would serve the shell —
	// and every unknown deep link — to anyone. The document waits behind the session instead.
	if (options.staticAssets) {
		const asset = await options.staticAssets(request);
		if (asset) return writeStaticAsset(asset, request, response);
	}

	const authentication = await options.identity.authenticate(await toWeb());
	// `null` means not authenticated and produces a bare 401. It is not an error path.
	if (!authentication) return refuse(response, 401, 'Unauthorized');
	// A provider that wants a browser to go somewhere returns the response itself — a redirect to
	// a login page, a `WWW-Authenticate` challenge. `null` is right for an API client and useless
	// for a person.
	if (authentication instanceof Response) return writeWebResponse(authentication, response);

	// The provider proved an address; the directory that turns it into a user lives in the tenant
	// database, so resolution goes over the private control plane rather than here.
	let resolved: HostIdentity | null;
	if (isVerifiedSubject(authentication)) {
		if (!options.resolveSubject) return refuse(response, 401, 'Unauthorized');
		resolved = await options.resolveSubject(authentication);
		if (!resolved) {
			return refuse(
				response,
				403,
				'Forbidden: this address has no workspace user and no pending invitation'
			);
		}
	} else {
		resolved = authentication;
	}

	// Authenticated and no real file matched: this is a deep link into the single-page app.
	if (options.appDocument) {
		const document = await options.appDocument(request);
		if (document) return writeStaticAsset(document, request, response);
	}

	// Strip whatever the client sent about identity and re-issue the request as the established
	// one; only the identity that survived `authenticate`/`resolveSubject` is believed.
	const authenticated = await withHostIdentity(await toWeb(), resolved);
	const handle = options.handlePodRequest ?? handlePodRequest;
	return writeWebResponse(await handle(authenticated, options.bindings), response);
}

/** A running Pod server, for a caller that has to be able to stop it again. */
export type PodHttpServer = {
	readonly port: number;
	close(): Promise<void>;
};

/**
 * Bind and serve one Pod runtime over HTTP.
 *
 * Resolves once the port is bound, which is also the moment readiness endpoints start to answer.
 * The returned `close` drains no open connections first on purpose: a server-sent-events response
 * never ends on its own, so waiting for it to finish would mean never closing at all.
 */
export async function createPodHttpServer(options: PodHttpServerOptions): Promise<PodHttpServer> {
	const label = options.label ?? '[pod]';
	const server = createServer((request, response) => {
		void handleConnection(options, request, response).catch((cause: unknown) => {
			console.error(`${label} request failed`, cause);
			if (!response.headersSent) response.statusCode = 500;
			if (!response.writableEnded) response.end('Internal Server Error');
		});
	});
	await listen(server, options.bind);
	return {
		port: options.bind.port,
		close: () =>
			new Promise<void>((resolve, reject) => {
				server.close((cause) => (cause ? reject(cause) : resolve()));
				// A server-sent-events response never ends on its own, so draining the open
				// connections first would mean never closing at all.
				server.closeAllConnections();
			})
	};
}

/**
 * Bind the socket, and fail rather than resolve when the address is unusable.
 *
 * `server.listen` reports a taken port asynchronously, so a caller that treated the call as
 * synchronous would print its ready line and then serve nothing.
 */
async function listen(
	server: Server,
	address: { readonly host: string; readonly port: number }
): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const onError = (cause: Error) => {
			server.off('listening', onListening);
			reject(cause);
		};
		const onListening = () => {
			server.off('error', onError);
			resolve();
		};
		server.once('error', onError);
		server.once('listening', onListening);
		server.listen(address.port, address.host);
	});
}
