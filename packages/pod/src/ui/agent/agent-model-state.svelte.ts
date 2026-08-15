import type { AiModelCatalog } from '@norbital-ai/platform-utils/runtime/binding';
import type { WorkspaceRemoteTransport } from '$lib/authoring/workspace/remote-transport.js';

/**
 * One model the host offers for a turn. The host catalog is the only answer to "what is about to
 * run"; Pod renders the picker and does not keep a second list of ids.
 */
export type AgentModelCatalogStatus = 'idle' | 'loading' | 'ready' | 'error';

const state = $state({
	catalog: null as AiModelCatalog | null,
	selectedModel: '',
	status: 'idle' as AgentModelCatalogStatus
});

let activeTransport: WorkspaceRemoteTransport | undefined;
let activeLoad: Promise<void> | undefined;

/** One model catalog and next-turn selection shared by every mounted agent surface. */
// stupidity:allow Q4 -- exported named helper
export function getAgentModelState(): typeof state {
	return state;
}

/** Loads the host model catalog once per transport and keeps the shared picker selection in sync. */
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
