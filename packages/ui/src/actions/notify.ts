// Shared toast feedback for native outcomes: committed, submitted, refused, conflicted or unknown.
import { toast } from '../toast/toast.svelte.js';
import type { OutcomeFeedback, ViewBolt } from '../client/contract.js';
import { outcomeText } from './outcome.js';

/** Toasts `o`; `saved` replaces the generic "Saved" (a delete says "Deleted"). */
export function notify<O extends OutcomeFeedback>(
	bolt: Pick<ViewBolt, 't'>,
	o: O,
	saved?: string
): void {
	const text = o.kind === 'committed' && saved !== undefined ? saved : outcomeText(bolt, o);
	if (o.kind === 'committed') toast.success(text);
	else if (o.kind === 'pendingApproval') toast.info(text);
	else if (o.kind === 'unknown') toast.warning(text);
	else toast.error(text);
}
