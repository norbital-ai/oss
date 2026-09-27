// An act's outcome as a toast (staging's Sonner calls): saved and submitted succeed, the rest are errors or warnings.
import { toast } from '../toast/toast.svelte.js';
import type { Outcome, ViewBolt } from './bolt.js';
import { outcomeText } from './model.js';

/** Toasts `o`; `saved` replaces the generic "Saved" (a delete says "Deleted"). */
export function notify(bolt: Pick<ViewBolt, 't'>, o: Outcome, saved?: string): void {
	const text = o.kind === 'committed' && saved !== undefined ? saved : outcomeText(bolt, o);
	if (o.kind === 'committed') toast.success(text);
	else if (o.kind === 'pendingApproval') toast.info(text);
	else if (o.kind === 'unknown') toast.warning(text);
	else toast.error(text);
}
