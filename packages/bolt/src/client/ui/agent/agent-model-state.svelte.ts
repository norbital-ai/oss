// repository-health:allow SEM_PARALLEL -- agent-model-state is imported by agent/client.svelte.ts
// (./agent-model-state.svelte.js), so the pair is linked, not parallel.
import { Schema } from 'effect';
import type { RemoteQuery } from '#lib/client/contracts.js';

/**
 * One model the host offers for a turn. The host catalog is the only answer to "what is about to
 * run"; Bolt renders the picker and does not keep a second list of ids.
 *
 * The catalog is host IO: it arrives from `ai.models` over the wire, so the shape is owned here as
 * Schema and the type is derived from it, rather than declared by hand next to it.
 */
const AgentModelCatalogStatus = Schema.Literals(['idle', 'loading', 'ready', 'error']);

export type AgentModelCatalogStatus = Schema.Schema.Type<typeof AgentModelCatalogStatus>;

const AiModelOption = Schema.Struct({
	id: Schema.String,
	label: Schema.String,
	contextLength: Schema.optionalKey(Schema.Number),
	/**
	 * The model family this option belongs to — `anthropic/claude-opus-4` for every dated or
	 * suffixed variant of it. The picker groups by family so a provider offering eight snapshots of
	 * one model shows as one entry rather than eight.
	 */
	canonicalSlug: Schema.optionalKey(Schema.String)
});

export type AiModelOption = Schema.Schema.Type<typeof AiModelOption>;

export const AiModelCatalogSchema = Schema.Struct({
	defaultModel: Schema.String,
	options: Schema.Array(AiModelOption)
});

type AiModelCatalog = Schema.Schema.Type<typeof AiModelCatalogSchema>;

export type WorkspaceRemoteTransport = {
	readonly agentModels: RemoteQuery<AiModelCatalog>;
};

export type AgentModelController = ReturnType<typeof createAgentModelController>;

/** Owns one mounted workspace's model catalog and its deduplicated load. */
export function createAgentModelController(transport: WorkspaceRemoteTransport) {
	const selection = $state({ selectedModel: '' });
	return {
		state: {
			get catalog(): AiModelCatalog | null {
				return transport.agentModels.current ?? null;
			},
			get selectedModel(): string {
				return selection.selectedModel || transport.agentModels.current?.defaultModel || '';
			},
			set selectedModel(value: string) {
				selection.selectedModel = value;
			},
			get status(): AgentModelCatalogStatus {
				if (transport.agentModels.loading) return 'loading';
				if (transport.agentModels.error !== undefined) return 'error';
				return transport.agentModels.current === undefined ? 'idle' : 'ready';
			}
		}
	};
}
