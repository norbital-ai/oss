import type { TBaseScope } from '$lib/shared/scope.js';
import { BaseScopeSchema } from '@norbital-ai/platform-utils/scope/types';

/** Per-request base scope injected by Core via the runtime sidecar (not client-supplied). */
export const NORBITAL_BASE_SCOPE_HEADER = 'x-norbital-base-scope-json';

export function parseHostProvidedBaseScope(
	raw: string | null | undefined,
	userId: string
): TBaseScope | null {
	const trimmed = raw?.trim();
	if (!trimmed) return null;
	try {
		const parsed = BaseScopeSchema.safeParse(JSON.parse(trimmed));
		if (!parsed.success) {
			console.warn('[pod] invalid host base scope', parsed.error.flatten());
			return null;
		}
		if (userId && parsed.data.requestor.norbital_id !== userId) {
			return null;
		}
		return parsed.data;
	} catch {
		return null;
	}
}
