import type { NorbitalManifest } from '../manifest/types.js';
import { z } from 'zod';

export type DbQueryResult = {
	readonly rows: readonly unknown[];
	readonly rowCount: number;
};

/** Serializable query payload for the host db binding (no driver callbacks). */
export type DbQueryConfig = {
	readonly text: string;
	readonly rowMode?: 'array';
	readonly values?: readonly unknown[];
};

export type DbQueryInput = string | DbQueryConfig;

export type HostDbBinding = {
	query(sql: DbQueryInput, params?: readonly unknown[]): Promise<DbQueryResult>;
	begin(): Promise<string>;
	txQuery(txId: string, sql: DbQueryInput, params?: readonly unknown[]): Promise<DbQueryResult>;
	commit(txId: string): Promise<void>;
	rollback(txId: string): Promise<void>;
};

export type PresignResult = {
	readonly url: string;
	readonly expiresAt: string;
};

export const NORBITAL_BILLING_HEADER = 'x-norbital-billing-json';

export type WorkspaceBillingSummary = {
	readonly status: string;
	readonly currentPeriodEnd: string | null;
	readonly hasPaymentMethod: boolean;
};

/**
 * File bytes cross the isolate boundary as raw `Uint8Array`. The V8 isolate marshals binding args/returns
 * with `v8.serialize` (structured clone), which supports typed arrays natively, so base64 would only
 * add overhead.
 */
export type HostFileStorageBinding = {
	put(key: string, body: Uint8Array, contentType?: string): Promise<void>;
	get(key: string): Promise<Uint8Array | null>;
	delete(key: string): Promise<void>;
	presignPut(key: string, ttlSeconds: number): Promise<PresignResult>;
	presignGet(key: string, ttlSeconds: number): Promise<PresignResult>;
};

export type AiInferInput = {
	readonly prompt: string;
	readonly model?: string;
	readonly temperature?: number;
	readonly schema?: unknown;
};

export type AiInferResult = {
	readonly text: string;
	readonly usage?: unknown;
};

export type AiChatInput = {
	readonly messages: readonly {
		readonly role: 'system' | 'user' | 'assistant';
		readonly content: string;
	}[];
	readonly model?: string;
	readonly temperature?: number;
};

export type HostAiBinding = {
	infer(input: AiInferInput): Promise<AiInferResult>;
	chat(input: AiChatInput): Promise<AiInferResult>;
};

export type NotificationChannel = 'email' | 'telegram' | 'whatsapp' | 'web';

export type NotificationDeliveryInput = {
	readonly organizationId: string;
	readonly recipientUserId: string;
	readonly subject: string;
	readonly message: string;
	readonly channels: readonly NotificationChannel[];
	readonly cta?: { readonly label: string; readonly url: string } | null;
};

export type NotificationDeliveryResult = {
	readonly [channel: string]: { readonly sent: boolean; readonly reason?: string };
};

export type HostNotificationsBinding = {
	send(input: NotificationDeliveryInput): Promise<NotificationDeliveryResult>;
};

export type StaticMapMarker = {
	readonly latitude: number;
	readonly longitude: number;
	readonly label?: string;
	readonly tone?: 'default' | 'alert';
};

export const StaticMapInputSchema = z.object({
	markers: z
		.array(
			z.object({
				latitude: z.number().finite().min(-90).max(90),
				longitude: z.number().finite().min(-180).max(180),
				label: z
					.string()
					.regex(/^[A-Z0-9]$/)
					.optional(),
				tone: z.enum(['default', 'alert']).optional()
			})
		)
		.min(1)
		.max(50)
});

export type StaticMapInput = z.infer<typeof StaticMapInputSchema>;

export type StaticMapRenderResult = {
	readonly mimeType: 'image/png' | 'image/jpeg';
	readonly data: Uint8Array;
	readonly markerPositions: readonly {
		readonly x: number;
		readonly y: number;
	}[];
};

export type GeolocationSuggestion = {
	readonly formattedAddress: string;
	readonly latitude: number | null;
	readonly longitude: number | null;
};

/**
 * Maps operations execute in the trusted host. Tenant runtimes receive only
 * derived place data or rendered image bytes, never provider credentials.
 */
export type HostMapsBinding = {
	renderStaticMap(input: StaticMapInput): Promise<StaticMapRenderResult>;
	autocompleteGeolocation(query: string): Promise<readonly GeolocationSuggestion[]>;
};

/**
 * Capabilities supplied by whichever platform hosts a tenant runtime. The runtime owns this
 * contract; hosts own the implementations and credentials. Optional capabilities fail at their
 * point of use, allowing the same build to run on platforms with different facility sets.
 */
export type RuntimeFacilityBindings = {
	readonly db: HostDbBinding;
	readonly fileStorage?: HostFileStorageBinding;
	readonly ai?: HostAiBinding;
	readonly notifications?: HostNotificationsBinding;
	readonly maps?: HostMapsBinding;
};

export type RuntimeFacilityRequirement =
	'db' | 'fileStorage' | 'integrationDelivery' | 'queue' | 'ai' | 'maps';

/** Facilities implied by the portable workspace manifest, independent of a particular host. */
export function requiredRuntimeFacilities(
	manifest: NorbitalManifest
): readonly RuntimeFacilityRequirement[] {
	const required = new Set<RuntimeFacilityRequirement>(['db']);
	const fields = Object.values(manifest.collections).flatMap(
		(collection) => collection.fields ?? []
	);
	if (fields.some((field) => field.kind === 'file')) required.add('fileStorage');
	if (fields.some((field) => field.kind === 'geolocation')) required.add('maps');

	if (Object.keys(manifest.integrations ?? {}).length > 0) {
		required.add('integrationDelivery');
		required.add('queue');
	}
	const automations = Object.values(manifest.automations ?? {});
	if (automations.length > 0) required.add('queue');
	if (automations.some((automation) => automation.spec?.kind === 'agent')) required.add('ai');

	return [...required];
}
