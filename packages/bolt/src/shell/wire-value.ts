import { Decimal } from '@norbital-ai/std/decimal';
import type { Value } from '@norbital-ai/std/kind';
import { reviveWire, type Json } from '@norbital-ai/std/wire';
import { Array as Arr, Result } from 'effect';

/** A display projection of stored wire JSON; the original payload remains suitable for copying and storage. */
export function displayWireValue(value: Json): Value {
	if (value === null || typeof value !== 'object') return value;
	if (Arr.isArray<Json>(value)) return value.map(displayWireValue);
	// Historical or ordinary JSON may contain invalid tags: retain them instead of failing the whole viewer.
	if (Object.keys(value).length === 1 && typeof value['$dec'] === 'string') {
		const revived = Result.try({ try: () => reviveWire('', value), catch: () => undefined });
		if (Result.isSuccess(revived) && revived.success instanceof Decimal) return revived.success;
	}
	return Object.fromEntries(
		Object.entries(value).map(([key, item]) => [key, displayWireValue(item)])
	);
}
