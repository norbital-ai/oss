/**
 * @fileoverview Identity-Aware JSON Diffing Engine
 *
 * Provides utilities for comparing objects with special handling for arrays
 * of objects that have identity keys ('id', 'norbital_id'). This prevents
 * false positives when items are reordered or deleted from the middle of an array.
 */

import { deepDiff, type JsonPatchOperation } from '@norbital-ai/std/json';

/**
 * Reserved identity keys used to identify objects in arrays.
 * Objects with these keys will be compared by identity rather than position.
 */
const IDENTITY_KEYS = ['id', 'norbital_id'] as const;

/**
 * Finds the identity key for an array of objects.
 * Returns undefined for arrays of primitives or objects without identity keys.
 */
function readKey(value: unknown, key: string | number): unknown {
	return value !== null && typeof value === 'object' ? Reflect.get(value, key) : undefined;
}

function findIdentityKey(arr: unknown[]): string | undefined {
	if (arr.length === 0) return undefined;
	const first = arr[0];
	if (typeof first !== 'object' || first === null) return undefined;

	for (const key of IDENTITY_KEYS) {
		if (key in first) return key;
	}
	return undefined;
}

/**
 * Resolves a dot-notation path into an identity-aware JSON Pointer.
 * If a path contains a positional index in an array that has identity keys,
 * it replaces the index with the item's identity value.
 *
 * @param obj - The object to resolve the path against (usually the baseline)
 * @param path - Dot-notation path (e.g., 'columns.0.name')
 * @returns RFC 6902 JSON Pointer (e.g., '/columns/ID/name')
 */
export function resolvePathToIdentity(obj: unknown, path: string): string {
	const parts = path.split('.');
	let current: unknown = obj;
	let pointer = '';

	for (let i = 0; i < parts.length; i++) {
		const part = parts[i];
		if (Array.isArray(current)) {
			const index = parseInt(part, 10);
			const item = current[index];
			if (item && typeof item === 'object') {
				const idKey = findIdentityKey(current);
				if (idKey) {
					pointer += `/${readKey(item, idKey)}`;
					current = item;
					continue;
				}
			}
		}
		pointer += `/${part}`;
		current = readKey(current, part);
	}

	return pointer;
}

/**
 * Normalizes an object for diffing by converting keyed arrays to objects.
 * This ensures stable identity-based comparison instead of positional.
 *
 * @example
 * // Input: { tasks: [{ id: 1, text: "A" }, { id: 2, text: "B" }] }
 * // Output: { tasks: { "1": { id: 1, text: "A" }, "2": { id: 2, text: "B" } } }
 */
function normalizeForDiff(obj: unknown): unknown {
	if (Array.isArray(obj)) {
		const identityKey = findIdentityKey(obj);
		if (identityKey) {
			// Convert to object keyed by identity for stable diffing
			const normalized: Record<string, unknown> = {};
			for (const item of obj) {
				const key = String(readKey(item, identityKey));
				normalized[key] = normalizeForDiff(item);
			}
			return normalized;
		}
		// Primitives array - keep as-is (treated as single value)
		return obj;
	}

	if (typeof obj === 'object' && obj !== null) {
		const normalized: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(obj)) {
			normalized[key] = normalizeForDiff(value);
		}
		return normalized;
	}

	return obj;
}

/**
 * Compare two objects with identity-aware array handling.
 * Arrays of objects with 'id' or 'norbital_id' keys are compared by identity,
 * not by position. This prevents false positives when items are reordered
 * or deleted from the middle of an array.
 *
 * @param initial - The original object state
 * @param current - The new/modified object state
 * @returns RFC 6902 JSON Patch operations
 *
 * @example
 * const original = { tasks: [{ id: 1, text: "A" }, { id: 2, text: "B" }] };
 * const modified = { tasks: [{ id: 1, text: "A modified" }] }; // id 2 deleted
 *
 * compareWithIdentity(original, modified);
 * // Returns: [
 * //   { op: "replace", path: "/tasks/1/text", value: "A modified" },
 * //   { op: "remove", path: "/tasks/2" }
 * // ]
 */
export function compareWithIdentity(initial: unknown, current: unknown): JsonPatchOperation[] {
	return deepDiff(normalizeForDiff(initial), normalizeForDiff(current));
}

/**
 * Get changes for a specific path from a list of operations.
 * Converts dot-notation path to JSON Pointer format for matching.
 *
 * @param operations - Array of RFC 6902 operations
 * @param path - Dot-notation path (e.g., 'user.name', 'items.0.text')
 * @param baseline - Optional object to resolve identity-aware paths against
 * @returns Array of operations affecting this path
 */
export function getChangesForPath(
	operations: JsonPatchOperation[],
	path: string,
	baseline?: unknown
): JsonPatchOperation[] {
	const pointer = baseline ? resolvePathToIdentity(baseline, path) : `/${path.replace(/\./g, '/')}`;
	return operations.filter((op) => op.path.startsWith(pointer));
}

/**
 * Check if a specific path has any changes.
 *
 * @param operations - Array of RFC 6902 operations
 * @param path - Dot-notation path (e.g., 'user.name', 'items.0.text')
 * @param baseline - Optional object to resolve identity-aware paths against
 * @returns True if there are any changes at or under this path
 */
export function hasChangesForPath(
	operations: JsonPatchOperation[],
	path: string,
	baseline?: unknown
): boolean {
	const pointer = baseline ? resolvePathToIdentity(baseline, path) : `/${path.replace(/\./g, '/')}`;
	return operations.some((op) => op.path.startsWith(pointer));
}
