import type { FileRef } from '@norbital-ai/std/kind';
import type { RunRow } from '../client/contract.js';
import { isRow } from '../read/results.js';
import { filesOf } from '../cell/value.js';
/** Progress as a 0–1 fraction when the run reports `{ done, total }` or a number. */
export function progressOf(run: Pick<RunRow, 'progress'>): number | null {
	const p = run.progress;
	if (typeof p === 'number') return p > 1 ? p / 100 : p;
	if (isRow(p) && typeof p['done'] === 'number' && typeof p['total'] === 'number' && p['total'] > 0)
		return p['done'] / p['total'];
	return null;
}
/** The files a run returned (final-ui rule 27): its output's `FileRef`s, at the top or one level in. */
export const runFiles = (run: Pick<RunRow, 'result'>): readonly FileRef[] =>
	[run.result ?? null, ...(isRow(run.result) ? Object.values(run.result) : [])].flatMap((v) =>
		filesOf(v)
	);
