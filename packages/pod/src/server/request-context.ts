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

export function getRequestEvent(): PodRequestEvent {
	const call = currentPodCallOrNull();
	if (!call) throw new Error('Pod request context is unavailable');
	return call.event;
}
