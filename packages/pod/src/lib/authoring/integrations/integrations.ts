import type { z } from 'zod';

export interface PrivateEnvReference {
	readonly env: string;
}

export interface HttpConnection {
	readonly baseUrl: string;
	readonly authentication?:
		| { readonly type: 'bearer'; readonly token: PrivateEnvReference }
		| { readonly type: 'header'; readonly header: string; readonly value: PrivateEnvReference };
}

export type WorkspaceConnections = Readonly<Record<string, HttpConnection>>;

export interface WebhookTrigger {
	readonly events?: readonly string[];
	readonly authentication?: {
		readonly type: 'hmac-sha256';
		readonly secret: PrivateEnvReference;
		readonly signatureHeader?: string;
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

export type CollectionMutationEvent = 'create' | 'update' | 'delete';

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
