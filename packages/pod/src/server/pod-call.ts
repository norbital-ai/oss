import { AsyncLocalStorage } from 'node:async_hooks';
import type { ProvisionedContext } from '$lib/server/bootstrap/workspace_store.js';
import type { BeforeApi } from '$lib/server/collection/hook-api.server.js';
import type { PodAdmit } from './admit.js';
import type { PodRequestEvent } from './request-context.js';

export type PodCall = {
	admit: PodAdmit | null;
	readonly event: PodRequestEvent;
	workspace: ProvisionedContext | null;
	beforeApi: BeforeApi | null;
};

const podCallStorage = new AsyncLocalStorage<PodCall>();

export function runWithPodCall<T>(call: PodCall, fn: () => T): T {
	return podCallStorage.run(call, fn);
}

export function currentPodCall(): PodCall {
	const call = podCallStorage.getStore();
	if (!call) throw new Error('Pod call context is unavailable');
	return call;
}

export function currentPodCallOrNull(): PodCall | null {
	return podCallStorage.getStore() ?? null;
}

export function setPodCallWorkspace(workspace: ProvisionedContext): void {
	currentPodCall().workspace = workspace;
}

export function setPodCallBeforeApi(beforeApi: BeforeApi): void {
	currentPodCall().beforeApi = beforeApi;
}

export function setPodCallAdmit(admit: PodAdmit | null): void {
	currentPodCall().admit = admit;
}

/** Temporarily replace one PodCall field when already inside a call. */
export function withPodCallField<K extends 'admit' | 'workspace' | 'beforeApi'>(
	field: K,
	value: PodCall[K],
	fn: () => unknown
): unknown {
	const call = currentPodCallOrNull();
	if (!call) return fn();
	const previous = call[field];
	call[field] = value;
	try {
		const result = fn();
		if (result && typeof (result as Promise<unknown>).then === 'function') {
			return Promise.resolve(result).finally(() => {
				call[field] = previous;
			});
		}
		call[field] = previous;
		return result;
	} catch (error) {
		call[field] = previous;
		throw error;
	}
}
