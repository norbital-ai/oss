import { createServer, request as requestUpstream, type IncomingMessage, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';

export type SessionGatewayAddress = {
	readonly host: string;
	readonly port: number;
};

export type SessionGatewayDocument =
	| string
	| ((session: { readonly browserSession: string }) => string);

export type SessionGatewayInput = {
	readonly upstream: SessionGatewayAddress;
	readonly credential: string;
	readonly cookieName: string;
	readonly isDocument: (pathname: string) => boolean;
	readonly rewritePath?: (pathname: string) => string;
	readonly document: SessionGatewayDocument;
	readonly listen?: { readonly host?: string; readonly port?: number };
};

export type SessionGateway = {
	readonly address: SessionGatewayAddress;
	readonly baseUrl: string;
	readonly cookieName: string;
	readonly stop: () => Promise<void>;
};

export type WorkspaceDocumentInput = {
	readonly tenantId: string;
	readonly environment: string;
	readonly releaseId: string;
	readonly principal: string;
	readonly workspaceId?: string;
	readonly syncPrincipal?: string;
	readonly organizationName?: string;
	readonly title?: string;
	readonly commandPrefix?: string;
	readonly syncStreamUrl?: string;
	readonly viewPath?: string;
};

const loopbackHost = (host: string): string =>
	host === '0.0.0.0' || host === '::' || host === '[::]' ? '127.0.0.1' : host;

const hasSessionCookie = (cookieHeader: string | undefined, name: string, value: string): boolean =>
	(cookieHeader ?? '')
		.split(';')
		.map((part) => part.trim())
		.includes(`${name}=${value}`);

const listen = (server: Server, host: string, port: number): Promise<SessionGatewayAddress> =>
	new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(port, host, () => {
			const address = server.address();
			if (address === null || typeof address === 'string') {
				reject(new Error('session gateway did not bind a TCP port'));
				return;
			}
			resolve({ host, port: address.port });
		});
	});

/** HTML document that mounts the compiled guest at `#workspace`. */
export const workspaceDocumentHtml = (input: WorkspaceDocumentInput): string => {
	const organizationName = input.organizationName ?? input.tenantId;
	const workspaceId = input.workspaceId ?? input.tenantId;
	const syncPrincipal = input.syncPrincipal ?? input.principal;
	const title = input.title ?? organizationName;
	const commandPrefix = input.commandPrefix ?? '/_bolt/command/';
	const syncStreamUrl = input.syncStreamUrl ?? '/sync/stream';
	const viewPath = input.viewPath ?? '/';
	const json = (value: string) => JSON.stringify(value);
	return `<!doctype html>
<html lang="en">
	<head>
		<meta charset="utf-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1" />
		<title>${title.replaceAll('<', '&lt;')}</title>
		<style>html, body, #workspace { min-height: 100%; margin: 0; }</style>
	</head>
	<body>
		<div id="workspace"></div>
		<script type="module">
			const target = document.querySelector('#workspace');
			const command = async (name, input, signal, headers = {}) => {
				const response = await fetch(${json(commandPrefix)} + encodeURIComponent(name), {
					method: 'POST',
					credentials: 'same-origin',
					headers: { 'content-type': 'application/json', ...headers },
					body: JSON.stringify(input),
					signal
				});
				const text = await response.text();
				const value = text === '' ? null : JSON.parse(text);
				if (!response.ok) throw new Error(value?.message ?? value?.error?.message ?? response.statusText);
				return value;
			};
			const unavailable = async () => { throw new Error('This embedder does not expose that host operation.'); };
			const session = {
				workspaceId: ${json(workspaceId)},
				tenantId: ${json(input.tenantId)},
				environment: ${json(input.environment)},
				releaseId: ${json(input.releaseId)},
				syncPrincipal: ${json(syncPrincipal)},
				principal: ${json(input.principal)},
				accessScope: 'administrator',
				credential: 'http-only-host-session',
				transport: { command },
				syncStreamUrl: ${json(syncStreamUrl)},
				authoringStreamUrl: '/authoring/stream',
				files: { store: unavailable, remove: unavailable, urlFor: (key) => '/files/' + key },
				operations: { read: async () => ({}), run: unavailable }
			};
			const currentView = () => ({
				organization: { id: ${json(input.tenantId)}, name: ${json(organizationName)} },
				organizations: [{ organizationId: ${json(input.tenantId)}, organizationName: ${json(organizationName)}, logoUrl: null }],
				user: { id: ${json(input.principal)}, email: ${json(`${input.principal}@example.test`)}, teamPath: [], admin: true },
				path: location.pathname === '/' ? ${json(viewPath)} : location.pathname,
				search: location.search
			});
			let handle;
			const actions = {
				navigate: (href, options = {}) => {
					history[options.replace ? 'replaceState' : 'pushState']({}, '', href);
					handle?.update({ ...currentView(), path: location.pathname, search: location.search });
				},
				signOut: () => location.reload(),
				changeOrganization: () => {},
				impersonate: () => {},
				stopImpersonating: () => {}
			};
			const entry = await import('/workspace.js');
			handle = await entry.mountWorkspace(target, { session, view: currentView(), actions });
			addEventListener('popstate', () => handle.update({ ...currentView(), path: location.pathname, search: location.search }));
		</script>
	</body>
</html>`;
};

/**
 * Cookie → Bearer document in front of a listening `startApplication`.
 * EventSource cannot set Authorization; bolt-server `/sync/stream` is Authorization-only.
 */
export const startSessionGateway = async (input: SessionGatewayInput): Promise<SessionGateway> => {
	const browserSession = randomUUID();
	const document =
		typeof input.document === 'function' ? input.document({ browserSession }) : input.document;
	const upstreamHost = loopbackHost(input.upstream.host);
	const listenHost = input.listen?.host ?? '127.0.0.1';
	const listenPort = input.listen?.port ?? 0;
	const rewritePath = input.rewritePath ?? ((pathname: string) => pathname);

	const server = createServer((request, response) => {
		const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
		if (input.isDocument(url.pathname) && request.method === 'GET') {
			response.writeHead(200, {
				'content-type': 'text/html; charset=utf-8',
				'cache-control': 'no-store',
				'set-cookie': `${input.cookieName}=${browserSession}; HttpOnly; SameSite=Lax; Path=/`
			});
			response.end(document);
			return;
		}

		const headers: Record<string, string | string[] | undefined> = { ...request.headers };
		headers.host = `${upstreamHost}:${input.upstream.port}`;
		delete headers.connection;
		if (hasSessionCookie(request.headers.cookie, input.cookieName, browserSession)) {
			headers.authorization = `Bearer ${input.credential}`;
		}

		const upstream = requestUpstream(
			{
				host: upstreamHost,
				port: input.upstream.port,
				method: request.method,
				path: `${rewritePath(url.pathname)}${url.search}`,
				headers
			},
			(upstreamResponse: IncomingMessage) => {
				const responseHeaders = { ...upstreamResponse.headers };
				delete responseHeaders.connection;
				response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);
				upstreamResponse.pipe(response);
			}
		);
		upstream.on('error', (cause: Error) => {
			response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
			response.end(`session gateway upstream failed: ${cause.message}`);
		});
		request.pipe(upstream);
	});

	const address = await listen(server, listenHost, listenPort);
	let stopping = false;
	return {
		address,
		baseUrl: `http://${loopbackHost(address.host)}:${address.port}`,
		cookieName: input.cookieName,
		stop: async () => {
			if (stopping) return;
			stopping = true;
			await new Promise<void>((resolve, reject) => {
				server.close((cause) => (cause === undefined ? resolve() : reject(cause)));
			});
		}
	};
};
