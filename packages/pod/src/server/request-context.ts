import { AsyncLocalStorage } from 'node:async_hooks';
import type { RuntimeFacilityBindings } from '@norbital-ai/platform-utils/runtime/binding';
import type { CallRequest } from './call-request.js';
import { currentPodCallOrNull } from './pod-call.js';

export type { CallRequest } from './call-request.js';

export interface PodRequestLocals {
	db: RuntimeFacilityBindings['db'];
	identity: string;
	org: { id: string; name: string };
	zone: 'live' | 'preview';
}

export interface PodRequestEvent {
	readonly request: CallRequest;
	readonly params: { readonly path?: string };
	readonly platform: { readonly bindings: RuntimeFacilityBindings };
	readonly locals: PodRequestLocals;
	readonly fetch: typeof globalThis.fetch;
	readonly cookies: {
		get(name: string): string | undefined;
	};
}

const requestEventStorage = new AsyncLocalStorage<PodRequestEvent>();

export function runWithRequestEvent<T>(event: PodRequestEvent, run: () => T): T {
	if (currentPodCallOrNull()) return run();
	return requestEventStorage.run(event, run);
}

export function getRequestEvent(): PodRequestEvent {
	const call = currentPodCallOrNull();
	if (call) return call.event;
	const event = requestEventStorage.getStore();
	if (!event) throw new Error('Pod request context is unavailable');
	return event;
}
