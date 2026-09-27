// The MCP client (rule 63b, P23): servers declared at `src/agent/mcp/+<n>.mcp.ts`, reached over streamable HTTP on the
// current protocol revision, authorized by a bearer token or OAuth client credentials from the tenant's env and secrets.
// One session per server per turn; every call is a facility call under the 60 s wall. A missing or unreachable server
// is `unavailable` — it never fails activation (rule 69).
import { Client, ClientCredentialsProvider, StreamableHTTPClientTransport, type FetchLike } from '@modelcontextprotocol/client';
import type { FacilityError } from '../../decl/runtime/facilities.ts';
import type { Json } from '../../decl/values.ts';
import { LIMITS, type Authority, type EngineManifest } from '../contracts.ts';

type Spec = { description: string; url: string; auth?: { bearer: string } | { oauth: { clientId: string; clientSecret?: string; scopes?: readonly string[] } }; tools?: readonly string[] };
/** The tenant's configuration: env values (URL, client ids) and secrets (tokens, client secrets) by `EnvName`. */
export type McpHost = { env(name: string): string | undefined; secret?(name: string): Promise<string | null>; fetch?: FetchLike };
export type McpTool = { server: string; name: string; description: string; input: Json };

/** Rule 58: the servers a held policy's capabilities name (an administrator holds every declared one). */
export const mcpServers = (m: EngineManifest, a: Authority): { name: string; description: string }[] =>
	Object.entries(m.mcp).filter(([n]) => a.admin || a.capabilities.mcp.includes(n)).map(([name, s]) => ({ name, description: String(s['description'] ?? '') }));

const unavailable = (server: string, reason: string): FacilityError => ({ kind: 'unavailable', facility: `mcp:${server}`, reason });
const message = (e: unknown) => e instanceof Error && e.message !== '' ? e.message : String(e);

/** One turn's sessions; `close` ends them. */
export function mcpSessions(m: EngineManifest, host: McpHost | undefined, wallMs: number = LIMITS.callMs.tool) {
	const open = new Map<string, Promise<Client | FacilityError>>();
	// ponytail: OAuth tokens live in this provider for the turn; persist them per tenant if token endpoints rate-limit us.
	const connect = async (server: string): Promise<Client | FacilityError> => {
		const spec = m.mcp[server] as Spec | undefined;
		if (spec === undefined || host === undefined) return unavailable(server, 'no MCP host is configured');
		const url = host.env(spec.url);
		if (url === undefined || url === '') return unavailable(server, `${spec.url} is not set`);
		const secret = async (name: string) => (await host.secret?.(name)) ?? host.env(name) ?? null;
		let authProvider: ClientCredentialsProvider | undefined;
		const headers: Record<string, string> = {};
		if (spec.auth !== undefined && 'bearer' in spec.auth) {
			const token = await secret(spec.auth.bearer);
			if (token === null) return unavailable(server, `${spec.auth.bearer} is not set`);
			headers['authorization'] = `Bearer ${token}`;
		} else if (spec.auth !== undefined) {
			const { clientId, clientSecret, scopes } = spec.auth.oauth;
			const id = host.env(clientId), sec = clientSecret === undefined ? null : await secret(clientSecret);
			if (id === undefined || sec === null) return unavailable(server, 'the OAuth client credentials are not set');
			authProvider = new ClientCredentialsProvider({ clientId: id, clientSecret: sec, ...(scopes === undefined ? {} : { scope: scopes.join(' ') }) });
		}
		const client = new Client({ name: '@norbital-ai/bolt', version: '0.0.1' });
		const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers },
			...(authProvider === undefined ? {} : { authProvider }), ...(host.fetch === undefined ? {} : { fetch: host.fetch }) });
		try {
			await client.connect(transport, { signal: AbortSignal.timeout(wallMs) });
			return client;
		} catch (e) {
			return unavailable(server, message(e));
		}
	};
	const session = (server: string) => { let s = open.get(server); if (s === undefined) open.set(server, s = connect(server)); return s; };
	const allowed = (server: string, tool: string) => { const only = (m.mcp[server] as Spec | undefined)?.tools; return only === undefined || only.includes(tool); };
	return {
		/** The tools of the servers the actor holds; an unreachable server contributes none. */
		async tools(a: Authority): Promise<McpTool[]> {
			const lists = await Promise.all(mcpServers(m, a).map(async ({ name }) => {
				const c = await session(name);
				if (!(c instanceof Client)) return [];
				try {
					const r = await c.listTools(undefined, { signal: AbortSignal.timeout(wallMs) });
					return r.tools.filter((t) => allowed(name, t.name))
						.map((t): McpTool => ({ server: name, name: t.name, description: t.description ?? '', input: t.inputSchema as Json }));
				} catch {
					return [];
				}
			}));
			return lists.flat();
		},
		async call(server: string, tool: string, input: Json): Promise<Json | FacilityError> {
			if (!allowed(server, tool)) return unavailable(server, `${tool} is not in the server's allowlist`);
			const c = await session(server);
			if (!(c instanceof Client)) return c;
			const signal = AbortSignal.timeout(wallMs);
			try {
				const r = await c.callTool({ name: tool, arguments: (input ?? {}) as { [k: string]: unknown } }, { signal });
				return JSON.parse(JSON.stringify({ content: r.content, ...(r.structuredContent === undefined ? {} : { structured: r.structuredContent }), ...(r.isError ? { isError: true } : {}) })) as Json;
			} catch (e) {
				return signal.aborted ? { kind: 'timeout', message: `${server}.${tool} did not answer within ${wallMs} ms` } : { kind: 'upstream', message: message(e) };
			}
		},
		async close() {
			const clients = await Promise.all(open.values());
			open.clear();
			await Promise.all(clients.map((c) => c instanceof Client ? c.close().catch(() => {}) : undefined));
		},
	};
}
export type McpSessions = ReturnType<typeof mcpSessions>;
