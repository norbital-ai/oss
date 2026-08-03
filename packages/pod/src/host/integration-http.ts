import type {
	ManifestIntegrationDestination,
	ManifestSecretHeader
} from '@norbital-ai/platform-utils/manifest/types';
import type { HostIntegrationDelivery, HostSecretResolver } from './types.js';

/** Reads declared secret names from the process environment. The standalone default. */
export const processEnvSecrets: HostSecretResolver = (name) =>
	process.env[name]?.trim() || undefined;

/**
 * Turn declared secret headers into real ones.
 *
 * A missing value throws naming the key. The alternative — sending the request without the header —
 * fails at the far end as an opaque 401 that says nothing about which variable was left unset, and
 * then retries with backoff forever.
 */
export function resolveSecretHeaders(
	secretHeaders: Readonly<Record<string, ManifestSecretHeader>> | undefined,
	secrets: HostSecretResolver,
	describe: string
): Record<string, string> {
	const resolved: Record<string, string> = {};
	for (const [header, reference] of Object.entries(secretHeaders ?? {})) {
		const value = secrets(reference.name);
		if (!value) {
			throw new Error(
				`${describe} needs secret "${reference.name}" and this host supplied no value for it`
			);
		}
		resolved[header] = `${reference.prefix ?? ''}${value}`;
	}
	return resolved;
}

/** A response body, clipped — an HTML error page in a retry log helps nobody. */
async function failureDetail(response: Response): Promise<string> {
	const body = await response.text().catch(() => '');
	const clipped = body.trim().slice(0, 200);
	return clipped ? `${response.status} ${response.statusText}: ${clipped}` : `${response.status}`;
}

/**
 * The delivery every `request` destination wants: POST the transformed payload to the URL the
 * workspace declared, with the connection's credential resolved here.
 *
 * This is what makes `+integrations.ts` a complete declaration rather than half of one. Before it,
 * a workspace could describe an endpoint precisely and every host still had to hand-write the fetch,
 * which is how an integration surface ends up with a manifest nobody reads.
 *
 * A `system-event` destination never reaches here — the outbox job routes those back into the
 * workspace — so arriving with one is a wiring bug worth failing loudly on.
 */
export function httpIntegrationDelivery(
	options: {
		readonly secrets?: HostSecretResolver;
		readonly fetch?: typeof globalThis.fetch;
		readonly headers?: Readonly<Record<string, string>>;
	} = {}
): HostIntegrationDelivery {
	const secrets = options.secrets ?? processEnvSecrets;
	const call = options.fetch ?? globalThis.fetch;
	return async (message) => {
		const destination: ManifestIntegrationDestination | undefined = message.destination;
		const describe = `Integration ${message.integrationName}.${message.bindingName}`;
		if (!destination) {
			throw new Error(
				`${describe} has no declared destination; httpIntegrationDelivery has nowhere to send it`
			);
		}
		if (destination.type !== 'api') {
			throw new Error(
				`${describe} declares a ${destination.type} destination, which is not an HTTP request`
			);
		}
		const response = await call(destination.url, {
			method: destination.method,
			headers: {
				'content-type': 'application/json',
				...(options.headers ?? {}),
				...destination.headers,
				...resolveSecretHeaders(destination.secretHeaders, secrets, describe)
			},
			body: JSON.stringify(message.payload ?? null)
		});
		if (!response.ok) {
			throw new Error(
				`${describe} was refused by ${destination.url} — ${await failureDetail(response)}`
			);
		}
	};
}
