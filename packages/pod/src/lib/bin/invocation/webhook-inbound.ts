import { createHash } from 'node:crypto';
import type { NorbitalManifest } from '@norbital-ai/platform-utils/manifest/types';
import type {
	DeclaredWebhookBinding,
	HostSecretResolver,
	WebhookInboundDelivery,
	WebhookInboundResult
} from '../../host/types.js';
import { processEnvSecrets } from '../../host/integration-http.js';
import {
	DEFAULT_WEBHOOK_SIGNATURE_HEADER,
	verifyWebhookSignature
} from '../../host/webhooks.js';
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
			const verified = verifyWebhookSignature({
				body: delivery.body,
				signature: delivery.headers[header],
				secret
			});
			if (!verified) return { status: 'rejected', reason: 'signature did not verify' };
		}

		let importData: unknown;
		try {
			importData = JSON.parse(delivery.body);
		} catch {
			return { status: 'rejected', reason: 'body is not JSON' };
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
function webhookEventId(delivery: WebhookInboundDelivery, header: string | undefined): string {
	const declared = header ? delivery.headers[header.toLowerCase()]?.trim() : undefined;
	if (declared) return declared;
	return `sha256:${createHash('sha256').update(delivery.body, 'utf8').digest('hex')}`;
}
