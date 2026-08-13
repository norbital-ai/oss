import type { WorkspaceRemoteTransport } from '$lib/authoring/workspace/remote-transport.js';

/**
 * One model the host offers for a turn.
 *
 * Structurally the Core-era `AgentModelOption`, restated here because Pod is the side that renders
 * the picker. Deliberately no list of ids alongside it: the catalog and the default are the host's,
 * reached through `agentModels`. A copy kept in this package would be a second answer to "what is
 * about to run", and Core's own baked list is the argument against one — it still names GPT-4o and
 * Claude Sonnet 4 as the frontier a year after they stopped being it.
 */
export type AgentModelOption = {
	readonly id: string;
	readonly label: string;
	readonly canonicalSlug: string;
	/** The model's context window in tokens, when the host publishes one. The denominator, nothing more. */
	readonly contextLength?: number;
};

export type AgentModelCatalog = {
	readonly defaultModel: string;
	readonly options: readonly AgentModelOption[];
};

export type AgentModelCatalogStatus = 'idle' | 'loading' | 'ready' | 'error';

const state = $state({
	catalog: null as AgentModelCatalog | null,
	selectedModel: '',
	status: 'idle' as AgentModelCatalogStatus
});

let activeTransport: WorkspaceRemoteTransport | undefined;
let activeLoad: Promise<void> | undefined;

/** One model catalog and next-turn selection shared by every mounted agent surface. */
export function getAgentModelState(): typeof state {
	return state;
}

export function loadAgentModelCatalog(transport: WorkspaceRemoteTransport): Promise<void> {
	if (transport !== activeTransport) {
		activeTransport = transport;
		activeLoad = undefined;
		state.catalog = null;
		state.selectedModel = '';
		state.status = 'idle';
	}
	if (activeLoad) return activeLoad;
	if (state.status === 'ready') return Promise.resolve();

	state.status = 'loading';
	activeLoad = Promise.resolve()
		.then(() => transport.agentModels())
		.then((catalog) => {
			if (transport !== activeTransport) return;
			state.catalog = catalog;
			if (catalog && !catalog.options.some((option) => option.id === state.selectedModel)) {
				state.selectedModel = catalog.defaultModel;
			}
			state.status = catalog ? 'ready' : 'error';
		})
		.catch(() => {
			if (transport !== activeTransport) return;
			state.status = 'error';
		})
		.finally(() => {
			if (transport === activeTransport) activeLoad = undefined;
		});
	return activeLoad;
}
