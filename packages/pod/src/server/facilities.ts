import { getRequestEvent } from '$lib/server/request-context.js';
import { error } from '$lib/server/http.js';
import type { RuntimeFacilityBindings } from '@norbital-ai/platform-utils/runtime/binding';

export type RuntimeFacilityName = Exclude<keyof RuntimeFacilityBindings, 'db'>;

/** Request-scoped capabilities injected by the current hosting platform. */
export function getRuntimeFacilities(): RuntimeFacilityBindings {
	const event = getRequestEvent();
	const bindings = event.platform?.bindings;
	if (!bindings) {
		throw error(503, 'The hosting platform did not provide runtime facilities');
	}
	return bindings;
}

export function requireRuntimeFacility<K extends RuntimeFacilityName>(
	name: K
): NonNullable<RuntimeFacilityBindings[K]> {
	const facility = getRuntimeFacilities()[name];
	if (facility == null) {
		throw error(503, `The hosting platform did not provide the ${name} facility`);
	}
	return facility;
}
