import type { WorkspaceRemoteTransport } from '$lib/authoring/workspace/remote-transport.js';
import type { AgentModelCatalog } from './models.js';

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
