import { createHash } from 'node:crypto';
import type { NorbitalManifest } from '@norbital-ai/platform-utils/manifest/types';
import type {
	DeclaredWebhookBinding,
	HostSecretResolver,
	WebhookInboundDelivery,
	WebhookInboundResult
} from './types.js';
import { processEnvSecrets } from './integration-http.js';
import {
	DEFAULT_WEBHOOK_SIGNATURE_HEADER,
	verifyWebhookSignature,
	webhookSignatureTimestamp,
	webhookTimestampIsFresh
} from './webhooks.js';
import type { RuntimeDispatch } from './jobs.js';

/**
 * Every `webhook` receive binding this workspace declares.
 *
 * Handed to the listener so it can mount one route per binding. The signature header and event-id
 * header travel with it for a host that verifies on its own wire; nothing here is a secret *value*.
 */
export function declaredWebhookBindings(
	manifest: NorbitalManifest
): readonly DeclaredWebhookBinding[] {
	return Object.entries(manifest.integrations ?? {}).flatMap(([integrationName, integration]) =>
		Object.entries(integration.definition.inbound ?? {}).flatMap(([bindingName, binding]) => {
			if (binding.origin.type !== 'webhook') return [];
			const origin = binding.origin;
			return [
				{
					integrationName,
					bindingName,
					collectionName: binding.collection,
					signed: origin.authentication != null,
					...(origin.authentication?.signatureHeader
						? { signatureHeader: origin.authentication.signatureHeader }
						: {}),
					...(origin.eventId ? { eventIdHeader: origin.eventId.header } : {}),
					...(origin.events ? { events: origin.events } : {})
				} satisfies DeclaredWebhookBinding
			];
		})
	);
}

export type WebhookInboundOptions = {
	readonly manifest: NorbitalManifest;
	readonly dispatch: RuntimeDispatch;
	/** Turns the declared secret name into its value. Defaults to `process.env`. */
	readonly secrets?: HostSecretResolver;
	readonly log?: (message: string) => void;
	/** The clock the replay window is measured against. Defaults to `Date.now`. */
	readonly now?: () => number;
};

/**
 * The host half of an inbound webhook: prove it, name it, hand it over.
 *
 * Verification lives here rather than in the listener on purpose. A listener is transport code an
 * operator may well write themselves, and a security check a caller can forget to make is one that
 * will eventually be forgotten. Routing every delivery through this function means the workspace is
 * only ever handed a payload whose HMAC has already been checked against the secret its own manifest
 * named — the listener could not skip the step if it wanted to.
 *
 * The delivery then crosses the private host-command plane, exactly as a channel message and a pull
 * body do, and never `handlePodRequest`: nothing a tenant request can reach may write a collection as
 * an integration.
 */
export function webhookInboundDeliverer(
	options: WebhookInboundOptions
): (delivery: WebhookInboundDelivery) => Promise<WebhookInboundResult> {
	const secrets = options.secrets ?? processEnvSecrets;
	const log = options.log ?? ((message: string) => console.warn(message));
	const now = options.now ?? (() => Date.now());

	return async (delivery) => {
		const integration = options.manifest.integrations?.[delivery.integrationName];
		const binding = integration?.definition.inbound?.[delivery.bindingName];
		if (!binding || binding.origin.type !== 'webhook') {
			return { status: 'rejected', reason: 'no such webhook binding' };
		}
		const origin = binding.origin;
		const describe = `${delivery.integrationName}.${delivery.bindingName}`;

		if (origin.authentication) {
			const secret = secrets(origin.authentication.secret.name);
			if (!secret) {
				// Refusing beats accepting: a host that cannot resolve the secret cannot tell a genuine
				// delivery from a forged one, and silently importing both is the failure this whole path
				// exists to prevent.
				log(
					`[pod:webhook] ${describe} declares ${origin.authentication.secret.name} and this host cannot resolve it; every delivery is refused`
				);
				return { status: 'rejected', reason: 'signing secret is not configured' };
			}
			const header = (
				origin.authentication.signatureHeader ?? DEFAULT_WEBHOOK_SIGNATURE_HEADER
			).toLowerCase();
			const signature = delivery.headers[header];
			const scheme = origin.authentication.timestamp;
			// The timestamp is read before the digest because it is *part of* the signed string, not a
			// separate claim to be checked afterwards. A delivery that carries none under a binding that
			// declares the scheme is refused here rather than quietly verified against the body alone —
			// falling back would let a sender pick the weaker scheme by omitting one field.
			let value: string | undefined;
			if (scheme) {
				value = webhookSignatureTimestamp({ scheme, headers: delivery.headers, signature });
				if (!value) {
					return { status: 'rejected', reason: 'delivery carries no signature timestamp' };
				}
			}
			const verified = verifyWebhookSignature({
				body: delivery.body,
				signature,
				secret,
				...(scheme && value ? { timestamp: { ...scheme, value } } : {})
			});
			if (!verified) return { status: 'rejected', reason: 'signature did not verify' };
			// Freshness is judged only once the signature holds. A stranger probing the endpoint learns
			// nothing about the window, and the timestamp being inside the signed string is what makes it
			// trustworthy enough to compare against at all — an unsigned one is just a number they chose.
			if (scheme && value) {
				const fresh = webhookTimestampIsFresh({
					value,
					...(scheme.toleranceSeconds != null ? { toleranceSeconds: scheme.toleranceSeconds } : {}),
					nowMs: now()
				});
				if (!fresh) return { status: 'rejected', reason: 'delivery is outside the replay window' };
			}
		}

		let importData: unknown;
		try {
			importData = JSON.parse(delivery.body);
		} catch {
			return { status: 'rejected', reason: 'body is not JSON' };
		}

		if (origin.events) {
			if (!origin.eventType) {
				// Same answer as an unresolvable secret, for the same reason: the binding declared a
				// restriction this host cannot evaluate, and importing everything would be the restriction
				// silently meaning nothing. `defineWorkspace` refuses this at build time; a manifest that
				// reaches here with it is one that went around the compiler.
				log(
					`[pod:webhook] ${describe} narrows events but declares no eventType; every delivery is refused`
				);
				return { status: 'rejected', reason: 'event narrowing is not evaluable' };
			}
			const eventType = webhookEventType(delivery, importData, origin.eventType);
			if (!eventType) {
				return { status: 'rejected', reason: 'delivery names no event type' };
			}
			if (!origin.events.includes(eventType)) {
				return { status: 'rejected', reason: `event type "${eventType}" is not declared here` };
			}
		}

		const outcome = (await options.dispatch({
			kind: 'integration',
			direction: 'receive',
			integrationName: delivery.integrationName,
			bindingName: delivery.bindingName,
			collectionName: binding.collection,
			importData,
			eventId: webhookEventId(delivery, origin.eventId?.header)
		})) as { readonly status?: string; readonly imported?: number; readonly reason?: string };

		if (outcome?.status === 'duplicate') return { status: 'duplicate', imported: 0 };
		if (outcome?.status === 'refused') {
			return {
				status: 'refused',
				imported: 0,
				...(outcome.reason ? { reason: outcome.reason } : {})
			};
		}
		return { status: 'imported', imported: outcome?.imported ?? 0 };
	};
}

/**
 * What this delivery is called, for the ledger.
 *
 * The declared header first, because the provider's own id is the only thing that stays the same
 * across its retries. A digest of the raw body is the fallback rather than a random id: a redelivery
 * of the same bytes has to produce the same key, and a generated one would make every retry look new
 * — which is exactly the ledger being present and useless. Two genuinely distinct events with
 * byte-identical bodies would collide, which is why a provider that sends an id should declare it.
 */
/**
 * What this delivery says it is, read from wherever the binding declared it lives.
 *
 * Only one source is consulted — the declared one. Trying a header and then a body field would let a
 * delivery choose which of the two the filter sees, so an absent value is an absent value and the
 * caller refuses on it. A path walks plain objects only: an array index or a non-string leaf is not
 * an event name, and coercing one would invent a value the provider never sent.
 */
function webhookEventType(
	delivery: WebhookInboundDelivery,
	body: unknown,
	source: { readonly header: string } | { readonly path: string }
): string | undefined {
	if ('header' in source) return delivery.headers[source.header.toLowerCase()]?.trim() || undefined;
	let cursor: unknown = body;
	for (const segment of source.path.split('.')) {
		if (typeof cursor !== 'object' || cursor === null || Array.isArray(cursor)) return undefined;
		cursor = (cursor as Record<string, unknown>)[segment];
	}
	return typeof cursor === 'string' ? cursor.trim() || undefined : undefined;
}

function webhookEventId(delivery: WebhookInboundDelivery, header: string | undefined): string {
	const declared = header ? delivery.headers[header.toLowerCase()]?.trim() : undefined;
	if (declared) return declared;
	return `sha256:${createHash('sha256').update(delivery.body, 'utf8').digest('hex')}`;
}
