/**
 * Minimal readers for discriminated-union (`custom(...)` JSONB) values inside hooks.
 *
 * Hooks run against values whose generated TypeScript type may be widened, so variants are
 * inspected structurally rather than narrowed by the compiler.
 */

import { entryOriginSchema } from '../custom-types/entry_origin/+definition.js';

/** Read a field off a JSONB variant value, or `undefined` when absent. */
export function variantField(value: unknown, key: string): unknown {
	if (value == null || typeof value !== 'object') return undefined;
	return Reflect.get(value, key);
}

/** Read a field expected to hold a string discriminant. */
export function variantTag(value: unknown, key: string): string | undefined {
	const tag = variantField(value, key);
	return typeof tag === 'string' ? tag : undefined;
}

/** Read a field expected to hold a number, treating absent/null as `null`. */
export function variantNumber(value: unknown, key: string): number | null {
	const raw = variantField(value, key);
	if (raw == null) return null;
	const parsed = Number(raw);
	return Number.isFinite(parsed) ? parsed : null;
}

/**
 * The `LOAN_INSTALMENT` variant of a `component_entries.origin` value, or `null` for anything else.
 *
 * Both the entry hook and the agreement hook ask this same question — one to validate an incoming
 * instalment against its agreement, the other to find the entries an agreement owns — so they ask
 * it once, here, rather than each keeping a copy of the parse.
 */
export function instalmentOrigin(value: unknown) {
	const parsed = entryOriginSchema.safeParse(value);
	return parsed.success && parsed.data.kind === 'LOAN_INSTALMENT' ? parsed.data : null;
}
