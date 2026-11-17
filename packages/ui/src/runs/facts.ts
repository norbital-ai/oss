import type { FileRef } from '@norbital-ai/store/kind';
import type { RunRow } from '../client/contract.js';
import { Predicate } from 'effect';
import { filesOf } from '../cell/value.js';
/** The native `ctx.progress({ ratio, text })` payload's fraction. */
export function progressOf(run: Pick<RunRow, 'progress'>): number | null {
	const p = run.progress;
	return Predicate.isObject(p) && typeof p['ratio'] === 'number' && Number.isFinite(p['ratio']) && p['ratio'] >= 0 && p['ratio'] <= 1 ? p['ratio'] : null;
}
/** The native run's current stage, without inventing a percentage for work that reports only text. */
export function progressText(run: Pick<RunRow, 'progress'>): string | null {
	const p = run.progress;
	return Predicate.isObject(p) && typeof p['text'] === 'string' ? p['text'] : null;
}
/** The files a run returned: its output's `FileRef`s, at the top or one level in. */
export const runFiles = (run: Pick<RunRow, 'result'>): readonly FileRef[] =>
	[
		run.result ?? null,
		...(Predicate.isObject(run.result) ? Object.values(run.result) : [])
	].flatMap((v) => filesOf(v));
