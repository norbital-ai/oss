import type { Row } from '../collection/types.js';
// local-array edits: each returns a fresh array (memory svelte-state-ignores-same-reference)
export const setCell = (
	rows: readonly Row[],
	i: number,
	field: string,
	value: import('@norbital-ai/std/kind').Value
): Row[] => rows.map((r, j) => (j === i ? { ...r, [field]: value } : r));
export const removeRow = (rows: readonly Row[], i: number): Row[] => rows.filter((_, j) => j !== i);
