// repository-health:allow SEM_PARALLEL -- host.ts re-exports signature definitions from system-principal; provider/consumer, not replication.
export { makeHttpConnectorBinding } from './runtime/integrations/http-connector.js';
/**
 * Identity's tables, re-exported for the hosts that must apply them.
 *
 * `identitySchemaSteps()` renders them from the collections that declare them, so a host applies the
 * platform's own steps rather than a copy of the DDL it would have to keep in step by hand.
 *
 * Colony no longer needs these. It used to apply them by hand so it could insert a service user and a
 * session row into a virgin database and authenticate `schema.migrate` as that subject; provisioning
 * is signed with the host's gateway secret now, so the migration creates identity's tables itself and
 * there is nothing to write beforehand.
 *
 * They stay exported because the deadlock is real for any host that authenticates a bootstrap through
 * a session rather than a signature, and handing over bolt's own declaration is what stops such a host
 * from writing one from memory: Colony did exactly that, kept a `bolt_sessions` of its own shaped the
 * way it recalled, and the two drifted until authentication read one table while the bootstrap wrote
 * the other.
 *
 * Exposed here rather than from the package root because a host runs under plain Node, and the root
 * export pulls the client's `.svelte` modules into the graph with it.
 */
export { AUTH_MODELS } from './authoring/system-models.js';
export { DEVELOPMENT_SIGN_IN_CODE } from './runtime/identity/auth.js';
export { identitySchemaSteps } from './compiler/schema-plan.js';
// repository-health:allow SEM_PARALLEL -- host.ts re-exports SystemPrincipal's signature
// definitions (./runtime/access/system-principal.js), so the pair is linked, not parallel.
export { compileHostModelSchema } from './compiler/schema-migrations.js';
/**
 * What a host needs to sign an invocation as `colony system`, exported rather than restated.
 *
 * The runtime verifies the digest by rebuilding `systemSignaturePayload` from what arrived; a host
 * that rendered its own version of "the bytes we sign" would be one edit away from a check that
 * passes on a payload nobody meant to authorize. One definition, imported by both ends.
 *
 * The secret itself is never exported and never crosses this seam. It is read from the host's
 * environment on each side under `GATEWAY_SECRET_VARIABLE`, which is the host's existing
 * `COLONY_GATEWAY_SECRET` and not a second key minted for provisioning.
 */
export {
	GATEWAY_SECRET_VARIABLE,
	SIGNATURE_LIFETIME_MILLIS,
	SYSTEM_SIGNATURE_HEADER,
	SYSTEM_TIMESTAMP_HEADER,
	systemSignaturePayload
} from './runtime/access/system-principal.js';

/** Computes the host-side HMAC without pulling Node's crypto module into runtime/browser bundles. */
export const systemSignature = (secret: string, payload: string): string =>
	createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
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
import { createHmac } from 'node:crypto';
