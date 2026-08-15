import type { z } from 'zod';
import type { CollectionMutationAction } from '@norbital-ai/platform-utils/collection';

export interface PrivateEnvReference {
	readonly env: string;
}

export interface HttpConnection {
	readonly baseUrl: string;
	readonly authentication?:
		| { readonly type: 'bearer'; readonly token: PrivateEnvReference }
		| { readonly type: 'header'; readonly header: string; readonly value: PrivateEnvReference };
}

/**
 * Identity function for a connection declared in `+integrations.ts`.
 *
 * It exists for inference and for the reader: a `connection` is the one place a workspace names a
 * third party and the *reference* to the credential that reaches it, and `defineConnection` makes
 * that a declaration rather than an object literal buried in a binding.
 */
export function defineConnection<const T extends HttpConnection>(connection: T): T {
	return connection;
}

/**
 * The timestamp half of a provider's signature scheme, when it signs more than the raw body.
 *
 * Stripe sends `stripe-signature: t=<timestamp>,v1=<hmac>` and signs `<timestamp>.<body>`; declaring
 * `timestamp: {}` is enough for that, because every default here is Stripe's. A provider that sends
 * the timestamp in a header of its own sets `header`. Declaring this is also what makes a replay
 * window possible at all — a body-only signature carries no time to compare against.
 */
export interface WebhookSignatureTimestamp {
	/** Header the timestamp is read from. Omit when it travels inside the signature header. */
	readonly header?: string;
	/** Element label the timestamp is read from inside the signature header. Defaults to `t`. */
	readonly field?: string;
	/** Element label the digest is read from inside the signature header. Defaults to `v1`. */
	readonly signatureField?: string;
	/** What sits between the timestamp and the body in the signed string. Defaults to `.`. */
	readonly separator?: string;
	/** How far from now a delivery may claim to be, in seconds. Defaults to 300. */
	readonly toleranceSeconds?: number;
}

export interface WebhookTrigger {
	/** Event types this binding accepts. Requires `eventType`, or Pod cannot tell what arrived. */
	readonly events?: readonly string[];
	/** Where the delivery's event type is read from: a header, or a dotted path into the body. */
	readonly eventType?: { readonly header: string } | { readonly path: string };
	readonly authentication?: {
		readonly type: 'hmac-sha256';
		readonly secret: PrivateEnvReference;
		readonly signatureHeader?: string;
		readonly timestamp?: WebhookSignatureTimestamp;
	};
	readonly eventIdHeader?: string;
}

export interface PullTrigger {
	readonly schedule: string;
	readonly method?: 'GET' | 'POST';
	readonly path: string;
	readonly cursorQuery?: string;
	readonly nextCursorHeader?: string;
}

export interface SystemEventTrigger {
	readonly event: string;
}

export interface IntegrationRequest {
	readonly method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
	readonly path: string;
	readonly headers?: Readonly<Record<string, string>>;
}

export type CollectionMutationEvent = CollectionMutationAction;

export interface CollectionReceiveBinding {
	readonly webhook?: WebhookTrigger;
	readonly pull?: PullTrigger;
	readonly systemEvent?: SystemEventTrigger;
	readonly input?: z.ZodType;
}

export type CollectionSendDestination =
	| {
			readonly request: IntegrationRequest;
			readonly systemEvent?: never;
	  }
	| {
			readonly systemEvent: SystemEventTrigger;
			readonly request?: never;
	  };

export type CollectionSendBinding = CollectionSendDestination & {
	readonly on:
		CollectionMutationEvent | Readonly<Partial<Record<CollectionMutationEvent, unknown>>>;
	readonly transform?: unknown;
};

export interface CollectionIntegrationDefinition {
	readonly connection?: HttpConnection;
	readonly receive?: Readonly<Record<string, CollectionReceiveBinding>>;
	readonly send?: Readonly<Record<string, CollectionSendBinding>>;
}

export interface RegisteredIntegration {
	readonly name: string;
	readonly definition: Readonly<Record<string, unknown>>;
}
