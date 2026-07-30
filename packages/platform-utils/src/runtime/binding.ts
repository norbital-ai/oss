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

export const NORBITAL_BILLING_HEADER = 'x-norbital-billing-json';

export type WorkspaceBillingSummary = {
	readonly status: string;
	readonly currentPeriodEnd: string | null;
	readonly hasPaymentMethod: boolean;
};

/**
 * A host-owned application the pod shell links into its sidebar — Workspace Studio, organization
 * settings. The pod renders a navigation entry and links to `entry`; it never loads the plugin's
 * code, so a host surface stays a host route and nothing of it enters the workspace bundle.
 *
 * Pure data, so it crosses the isolate boundary by structured clone. It lives here rather than with
 * the host contract because the wire has to name it, and the wire cannot depend on Pod.
 */
export type HostAppPlugin = {
	/** Stable identifier, unique within a host. */
	readonly key: string;
	readonly label: string;
	readonly icon: string | null;
	/**
	 * Where the pod shell sends the browser: a host-owned path or absolute URL.
	 *
	 * Rejected at startup unless it is site-relative (`/studio`) or `https:`. A `javascript:` entry
	 * would be script injection into every session, and the shell renders this straight into an href.
	 */
	readonly entry: string;
	/** Only `sidebar` today; the field exists so a second placement does not need a contract change. */
	readonly placement: 'sidebar';
	/**
	 * Show the entry only to workspace admins. Hiding an entry is not authorization — the host route
	 * behind `entry` must still authorize the request itself, since a URL is guessable.
	 */
	readonly adminOnly?: boolean;
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
};

export type AiMessage = {
	readonly role: 'system' | 'user' | 'assistant' | 'tool';
	readonly content: string;
	readonly toolCallId?: string;
	readonly toolCalls?: readonly AiToolCall[];
};

export type AiToolSpec = {
	readonly name: string;
	readonly description: string;
	readonly inputSchema: unknown;
};

export type AiToolCall = {
	readonly id: string;
	readonly name: string;
	readonly input: unknown;
};

export type AiChatInput = {
	readonly messages: readonly AiMessage[];
	readonly tools?: readonly AiToolSpec[];
	readonly outputSchema?: unknown;
	readonly model?: string;
	readonly profile?: string;
};

export type AiChatResult = {
	readonly text: string;
	readonly toolCalls?: readonly AiToolCall[];
	readonly stopReason: 'end' | 'tool_use' | 'max_tokens' | 'refusal';
	readonly usage?: unknown;
};

/** Model inference is the host's only AI responsibility; Pod owns the agent loop and tools. */
export type HostAiBinding = {
	chat(input: AiChatInput): Promise<AiChatResult>;
};

export type NotificationDelivery = {
	readonly organizationId: string;
	readonly channel: string;
	readonly recipientUserId: string;
	readonly subject: string;
	readonly message: string;
	readonly cta?: { readonly label: string; readonly url: string } | null;
};

export type NotificationDeliveryResult = { readonly sent: boolean; readonly reason?: string };

export type HostNotificationsBinding = {
	/** External channels this host can deliver. `system` is reserved to Pod. */
	readonly channels: readonly string[];
	send(input: NotificationDelivery): Promise<NotificationDeliveryResult>;
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
 * contract; hosts own the implementations and credentials. Bindings are optional in the transport
 * shape because workspaces require different facilities, but a host must satisfy the compiled
 * manifest before it accepts traffic.
 */
export type RuntimeFacilityBindings = {
	readonly db: HostDbBinding;
	readonly fileStorage?: HostFileStorageBinding;
	readonly ai?: HostAiBinding;
	readonly notifications?: HostNotificationsBinding;
	readonly maps?: HostMapsBinding;
};

export type RuntimeFacilityName =
	'db' | 'fileStorage' | 'integrationDelivery' | 'queue' | 'ai' | 'maps' | 'notifications';

/**
 * Facilities implied by the portable workspace manifest, independent of a particular host.
 *
 * A facility belongs here only when the workspace cannot *function* without it, not merely when it
 * would be nice to have. The distinction is whether the stored data depends on the provider:
 *
 * - a `file()` field has nowhere to put its bytes without `fileStorage`;
 * - an agent automation has no model to call without `ai`;
 * - a scheduled or event automation, and an outbound integration, have nothing to drive them
 *   without `queue` — and an integration has nowhere to deliver without `integrationDelivery`.
 *
 * `maps` is deliberately absent. A `geolocation()` value is self-contained
 * (`{ geometry, formatted_address, type, srid }`), so storing, querying, and displaying one needs no
 * provider at all — only edit-time address autocomplete and static-map rendering do. Those validate
 * when called, the same way a `notifications` channel does, so a workspace that merely holds
 * coordinates is not blocked from starting.
 */
export function requiredRuntimeFacilities(
	manifest: NorbitalManifest
): readonly RuntimeFacilityName[] {
	const required = new Set<RuntimeFacilityName>(['db']);
	const fields = Object.values(manifest.collections).flatMap(
		(collection) => collection.fields ?? []
	);
	if (fields.some((field) => field.kind === 'file')) required.add('fileStorage');

	if (Object.keys(manifest.integrations ?? {}).length > 0) {
		required.add('integrationDelivery');
		required.add('queue');
	}
	const automations = Object.values(manifest.automations ?? {});
	if (automations.length > 0) required.add('queue');
	if (automations.some((automation) => automation.spec?.kind === 'agent')) required.add('ai');

	return [...required];
}
