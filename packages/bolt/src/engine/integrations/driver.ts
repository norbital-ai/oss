// The OAuth client a driver's link grants with. The driver contract itself (`Provider`, `Link`, `DriverOpen`) is
// `@norbital-ai/host-api`'s: the host registers its providers, and the links manager (`links.ts`) opens one `Link` per
// instance from the provider the operator chose at pairing.
import type { IntegrationSpec } from '../../decl/runtime/integration.ts';
import type { OAuthClient, OAuthVendor } from '@norbital-ai/host-api';

/** The client `DriverOpen.oauth_client` answers: the definition's own when both its secrets are set, else the host's. */
export const oauth_client_of = (
	definition: Pick<IntegrationSpec, 'oauth'>,
	secrets: Readonly<Record<string, string>> | undefined,
	host: Partial<Record<OAuthVendor, OAuthClient>> | undefined,
	vendor?: OAuthVendor
): OAuthClient | undefined => {
	const id = definition.oauth === undefined ? undefined : secrets?.[definition.oauth.client],
		secret = definition.oauth === undefined ? undefined : secrets?.[definition.oauth.secret];
	return id !== undefined && id !== '' && secret !== undefined && secret !== ''
		? { id, secret }
		: vendor === undefined
			? undefined
			: host?.[vendor];
};
