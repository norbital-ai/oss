import { Effect } from 'effect';
import type { AiModelCatalog } from './models.js';
import type { WorkspaceRemoteTransport } from './remote-transport.js';

/**
 * One model the host offers for a turn. The host catalog is the only answer to "what is about to
 * run"; Bolt renders the picker and does not keep a second list of ids.
 */
export type AgentModelCatalogStatus = 'idle' | 'loading' | 'ready' | 'error';

const state = $state({
	catalog: null as AiModelCatalog | null,
	selectedModel: '',
	status: 'idle' as AgentModelCatalogStatus
});

let activeTransport: WorkspaceRemoteTransport | undefined;
// The memoized load for the current transport: `Effect.cached` deduplicates concurrent callers into
// one in-flight fetch and keeps the result for every later caller.
let loadOnce: Effect.Effect<Effect.Effect<void>> | undefined;

/** One model catalog and next-turn selection shared by every mounted agent surface. */
export function getAgentModelState(): typeof state {
	return state;
}

/** Loads the host model catalog once per transport and keeps the shared picker selection in sync. */
export function loadAgentModelCatalog(transport: WorkspaceRemoteTransport): Promise<void> {
	if (transport !== activeTransport) {
		activeTransport = transport;
		const load = Effect.gen(function* () {
			const catalog = yield* Effect.tryPromise(() => transport.agentModels());
			if (transport !== activeTransport) return;
			state.catalog = catalog;
			if (catalog && !catalog.options.some((option) => option.id === state.selectedModel)) {
				state.selectedModel = catalog.defaultModel;
			}
			state.status = catalog ? 'ready' : 'error';
		}).pipe(
			Effect.catch(() =>
				Effect.sync(() => {
					if (transport !== activeTransport) return;
					state.status = 'error';
				})
			)
		);
		loadOnce = Effect.cached(load);
		state.catalog = null;
		state.selectedModel = '';
		state.status = 'idle';
	}
	if (state.status === 'ready') return Promise.resolve();
	state.status = 'loading';
	return Effect.runPromise(Effect.flatten(loadOnce ?? Effect.succeed(Effect.succeed(undefined))));
}
