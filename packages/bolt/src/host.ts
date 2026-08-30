// repository-health:allow SEM_PARALLEL -- host.ts re-exports signature definitions from system-principal; provider/consumer, not replication.
export { makeHttpConnectorBinding } from './runtime/integrations/http-connector.js';
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
