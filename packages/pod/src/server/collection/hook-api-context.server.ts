import type {
	AfterApi,
	AfterHookApi,
	BeforeApi,
	HookApi
} from '$lib/authoring/workspace/hook-api.js';
import { AsyncLocalStorage } from 'node:async_hooks';

/** Request-local server API used by nested hooks and tenant handlers. */
export const beforeApiStorage = new AsyncLocalStorage<BeforeApi>();

export async function getBeforeApi(): Promise<BeforeApi> {
	const stored = beforeApiStorage.getStore();
	if (stored) return stored;
	const { createBeforeApi } = await import('./hook-api.server.js');
	return createBeforeApi();
}

export async function getHookApi(): Promise<HookApi> {
	const { restrictBeforeHookApi } = await import('./hook-api.server.js');
	return restrictBeforeHookApi(await getBeforeApi());
}

export async function getElevatedAfterApi(): Promise<AfterApi> {
	const { createElevatedAfterApi } = await import('./hook-api.server.js');
	return createElevatedAfterApi();
}

export async function getElevatedAfterHookApi(): Promise<AfterHookApi> {
	const { restrictAfterHookApi } = await import('./hook-api.server.js');
	return restrictAfterHookApi(await getElevatedAfterApi());
}
