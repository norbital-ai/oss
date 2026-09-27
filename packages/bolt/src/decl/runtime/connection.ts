// `connection()` (§3.3.8, §5.11.4): an external HTTP endpoint and its auth, every value an env name, never a literal.
import type { Checked, Exact } from '../fields.ts';
import type { EnvName } from './names.ts';

type Auth<E> =
	| { bearer: E } | { basic: { user: E; password: E } } | { header: { name: string; value: E } }
	| { oauth2: { grant: 'client_credentials'; tokenUrl: E; clientId: E; clientSecret: E; scopes?: readonly string[] } }
	| { oauth2: { grant: 'authorization_code'; per: 'workspace' | 'user'; authorizeUrl: E; tokenUrl: E; clientId: E; clientSecret: E;
		scopes: readonly [string, ...string[]] } };
type ConnectionBase = { baseUrl: string; auth?: Auth<string> };
export type ConnectionSpec = { baseUrl: EnvName; auth?: Auth<EnvName> };

/**
 * `src/connection/+<n>.connection.ts`: an external HTTP API, its base URL and credentials named from `+workspace.ts`'s
 * `env` (bearer, header, basic or OAuth 2). Integrations and `ctx.http` call it.
 * @example
 * export default connection({ baseUrl: 'ERP_URL', auth: { bearer: 'ERP_TOKEN' } });
 */
export function connection<const S extends ConnectionBase>(spec: S & Checked<ConnectionBase, S, Exact<S, ConnectionSpec>>): S {
	return spec;
}
