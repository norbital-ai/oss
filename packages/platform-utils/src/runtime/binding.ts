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
 * Admin team impersonation state projected into the guest shell, so the account menu can render the
 * team picker without the guest reaching the host's directory. Absent for non-admins.
 */
export const NORBITAL_IMPERSONATION_HEADER = 'x-norbital-impersonation-json';

export type WorkspaceImpersonationSummary = {
	readonly isAdmin: boolean;
	readonly isActive: boolean;
	readonly activeTeamIds: readonly string[];
	readonly teams: readonly { norbital_id: string; name: string | null }[];
};

/**
 * A host-owned application the pod shell links into its navigation — Workspace Studio, Core
 * services. The pod renders a navigation entry and links to `entry`; it never loads the plugin's
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
	/** Top-level platform tool, or a host-owned child of Pod's Settings folder. */
	readonly placement: 'sidebar' | 'settings' | 'footer';
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

export type AiTextMessagePart = {
	readonly type: 'text';
	readonly text: string;
};

/** Image bytes stay binary across the isolate boundary; the trusted host encodes for its provider. */
export type AiImageMessagePart = {
	readonly type: 'image';
	readonly bytes: Uint8Array;
	readonly mimeType: string;
	readonly detail?: 'auto' | 'low' | 'high';
};

export type AiMessagePart = AiTextMessagePart | AiImageMessagePart;

export type AiMessage = {
	readonly role: 'system' | 'user' | 'assistant' | 'tool';
	readonly content: string | readonly AiMessagePart[];
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
	/** Provider-visible reasoning, when the adapter exposes it. Never folded into the answer text. */
	readonly reasoning?: string;
	readonly toolCalls?: readonly AiToolCall[];
	readonly stopReason: 'end' | 'tool_use' | 'max_tokens' | 'refusal';
	readonly usage?: unknown;
};

/** One provider-stream event normalized at the host boundary. */
export type AiChatStreamEvent =
	| { readonly type: 'text_part'; readonly text: string }
	| { readonly type: 'reasoning_part'; readonly text: string }
	| { readonly type: 'tool_call'; readonly call: AiToolCall }
	| {
			readonly type: 'finish';
			readonly stopReason: AiChatResult['stopReason'];
			readonly usage?: unknown;
	  };

export type AiChatStreamBatch = {
	readonly events: readonly AiChatStreamEvent[];
	readonly done: boolean;
};

/** One model a host will accept in `AiChatInput.model`. */
export type AiModelOption = {
	readonly id: string;
	readonly label: string;
	/** Groups the variants of one model (`:free`, `:thinking`) under a single family. */
	readonly canonicalSlug: string;
	/**
	 * The model's context window, in tokens.
	 *
	 * Model metadata rather than usage: it belongs beside the name because it is a property of the
	 * model, and a reader cannot turn a token count into "how full is the window" without it. Optional
	 * because a host may not know it — a guest that guessed would be inventing the denominator.
	 */
	readonly contextLength?: number;
};

/**
 * What this host will run, and which model it picks when a run names none.
 *
 * `defaultModel` exists so a picker can show the model that is actually about to run. The host holds
 * the credentials and the default; a guest that duplicated either would be a second source of truth
 * free to disagree with the one doing the inference.
 */
export type AiModelCatalog = {
	readonly defaultModel: string;
	readonly options: readonly AiModelOption[];
};

/** Model inference is the host's only AI responsibility; Pod owns the agent loop and tools. */
export type HostAiBinding = {
	chat(input: AiChatInput): Promise<AiChatResult>;
	/** Offer a choice of model. A host without one runs its default and no picker is shown. */
	models?(): Promise<AiModelCatalog>;
	/** Start one provider turn. The opaque id names transient host memory, never a transcript. */
	startStream?(input: AiChatInput): Promise<string>;
	/** Pull the next available event batch; text deltas remain live across the isolate boundary. */
	readStream?(streamId: string): Promise<AiChatStreamBatch>;
	/** Release a provider stream when the tenant turn is aborted. */
	cancelStream?(streamId: string): Promise<void>;
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

/**
 * A message on a conversational transport — Telegram, WhatsApp, SMS.
 *
 * Distinct from `NotificationDelivery`, which addresses a *workspace user* and lets the host resolve
 * an address for them. Here the person on the other end may have no user row at all, so the address
 * is the transport's own: a chat id, a phone number, whatever the wire uses.
 */
export type TransportMessage = {
	/** Transport-native address of the conversation — chat id, phone number, thread id. */
	readonly conversationId: string;
	readonly text: string;
};

export type TransportSendResult = { readonly sent: boolean; readonly reason?: string };

/**
 * Every member of every binding here is a *method*, and a facility binding may never carry a data
 * field. Bindings reach a tenant runtime through the facility proxy in `serve/hosted.ts`, which
 * traps every property get and returns a call forwarder — so a data field arrives inside the
 * isolate as a function, and a record of functions does not survive the structured clone at all.
 * The type checks out on both sides and the standalone runner, which holds the real object, works;
 * only a hosted isolate sees the difference. That is why `listChannels()` and `listTransports()`
 * are calls.
 */
export type HostMessagingBinding = {
	/** External channels this host can deliver. `system` is reserved to Pod. */
	listChannels(): Promise<readonly string[]>;
	send(input: NotificationDelivery): Promise<NotificationDeliveryResult>;
	/** The transports this host can carry a declared channel over. */
	listTransports(): Promise<readonly string[]>;
	/**
	 * Send on the exact declared channel that produced the reply.
	 *
	 * `transport` alone is not an address: a workspace may declare two Telegram channels backed by
	 * two different host credentials. Carrying the declaration key keeps credential selection in the
	 * host without making the tenant aware of a token or provider-specific config id.
	 */
	sendVia(
		channel: string,
		transport: string,
		message: TransportMessage
	): Promise<TransportSendResult>;
};

/**
 * One host-supplied agent tool, described for the model.
 *
 * Plain data — name, description, JSON Schema — so it survives the structured clone that carries a
 * binding result into the isolate. It is deliberately the same shape as `AiToolSpec`: the agent loop
 * puts host tools and workspace tools into one list, because the model is offered one list.
 */
export type HostAgentToolSpec = AiToolSpec;

/**
 * Tools the *host* implements, offered to a tenant's agent.
 *
 * This is the one facility whose method set is not the interesting part: the *tools* are, and they
 * differ per host. So the binding is fixed at two methods and the tool set is discovered by calling
 * one of them. That is what makes it expressible at all — `facilityProxy` answers a property get
 * with a call forwarder, so a binding cannot carry a map of host functions, but it can carry a
 * `list()` that returns their descriptions and a `run()` that names one.
 *
 * `run` receives the model's raw input and returns whatever the tool produced. Both cross by
 * structured clone, so a tool that returns a function or a class instance returns nothing usable —
 * the same rule every other binding lives under.
 *
 * The guest may attach the Pod-selected sandbox principal below. That id is a lookup key, never an
 * authorization result: the host resolves it again in the tenant directory before opening a
 * workbench, so an isolate cannot grant itself another principal's filesystem.
 */
/**
 * How a host-tool call may touch the tenant worktree.
 *
 * `read-only` mounts `/workspace/src` read-only and leaves `/workspace/src/.tmp` writable for
 * ephemeral analysis. `read-write` is the authoring default (interactive Studio / agent).
 */
export type HostSandboxWorkspaceMode = 'read-only' | 'read-write';

/**
 * Per-call context the guest may attach to a host tool run.
 *
 * Deliberately small. `sandboxPrincipalId` is the Pod requestor already selected by the authenticated
 * request or channel delivery; the host must still resolve and authorize that id in the tenant
 * directory before opening a workbench. `sandboxWorkspace` carries the workspace policy authored in
 * source (e.g. a channel's `hostSandbox.workspace`).
 */
export type HostAgentToolRunContext = {
	readonly sandboxPrincipalId?: string;
	readonly sandboxWorkspace?: HostSandboxWorkspaceMode;
};

export type HostAgentToolBinding = {
	/** The tools this host exposes. A method, not a field — see the note on `RuntimeFacilityBindings`. */
	list(): Promise<readonly HostAgentToolSpec[]>;
	/**
	 * Run one host tool by name. The host validates `input`; the guest never sees the implementation.
	 * Optional `context` carries the Pod-selected principal plus authored workspace mount policy.
	 */
	run(name: string, input: unknown, context?: HostAgentToolRunContext): Promise<unknown>;
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
 *
 * **Methods only.** No binding below may declare a data field — see `HostMessagingBinding` for why
 * a field type-checks everywhere and still arrives as a function inside a hosted isolate.
 * `tests/runtime/facility-binding-shape.test.ts` enforces it.
 */
export type RuntimeFacilityBindings = {
	readonly db: HostDbBinding;
	readonly fileStorage?: HostFileStorageBinding;
	readonly ai?: HostAiBinding;
	readonly messaging?: HostMessagingBinding;
	readonly maps?: HostMapsBinding;
	readonly agentTools?: HostAgentToolBinding;
};

export type RuntimeFacilityName =
	| 'db'
	| 'fileStorage'
	| 'integrationDelivery'
	| 'queue'
	| 'ai'
	| 'maps'
	| 'messaging'
	| 'agentTools';

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
 * when called, the same way a `messaging` channel does, so a workspace that merely holds
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
	if (manifest.agent || automations.some((automation) => automation.spec?.kind === 'agent')) {
		required.add('ai');
	}
	// An agent that names a host tool has nothing to call without one. Same reasoning as `ai`: the
	// workspace declared a dependency on something only the host can supply, so a host that supplies
	// none must refuse the workspace rather than fail at the first run.
	if (automations.some((automation) => (automation.spec?.hostTools ?? []).length > 0)) {
		required.add('agentTools');
	}
	if ((manifest.agent?.hostTools ?? []).length > 0) required.add('agentTools');

	return [...required];
}
