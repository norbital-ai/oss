export { makeHttpConnectorBinding } from './runtime/integrations/http-connector.js';
/**
 * Identity's tables, re-exported for the hosts that must apply them.
 *
 * A freshly provisioned database is empty, and `schema.migrate` — the command that would fill it —
 * authenticates through a session row like every other command. So a host has to write that row
 * before it can migrate, and to write it, it needs the schema. Handing over the pod's own
 * declaration is what stops the host from writing one from memory: Colony did exactly that, kept a
 * `bolt_sessions` of its own shaped the way it recalled, and the two drifted until authentication
 * read one table while the bootstrap wrote the other.
 *
 * Exposed here rather than from the package root because a host runs under plain Node, and the root
 * export pulls the client's `.svelte` modules into the graph with it.
 */
export { AUTH_MODELS, AUTH_SCHEMA, DEVELOPMENT_SIGN_IN_CODE } from './runtime/identity/auth.js';
export {
	INTEGRATION_HTTP_OPERATION,
	IntegrationHttpRequest,
	IntegrationHttpResponse
} from './runtime/integrations/http.js';

export type ColonyBoltHostConfig = Readonly<{
	readonly mode: 'colony';
}>;

export type SelfHostedBoltHostConfig = Readonly<{
	readonly mode: 'self-hosted';
	readonly db: string;
	readonly identity: unknown;
	readonly publicUrl: string;
}>;

export type BoltHostConfig = ColonyBoltHostConfig | SelfHostedBoltHostConfig;

/** Identity helper so a workspace host file type-checks on write. */
export const defineBoltHost = <const TConfig extends BoltHostConfig>(config: TConfig): TConfig =>
	config;
