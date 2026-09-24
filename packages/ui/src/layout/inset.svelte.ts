/**
 * Who pads the page edge — exactly one element per content region.
 *
 * The rule: the scrollport owns the inset. A `Bound inset` or `Scroll inset` pads its region and
 * everything under it stays flush. A panel that is not itself a scrollport (a tab panel) pads
 * *provisionally*: it holds the inset until a scrollport inside it claims it, then goes flush so the
 * inset lands on the scrolling box. Chrome (a tab strip, a page header) reads `insetReader()` and
 * supplies its own inset only when nothing above it has.
 *
 * Overlays (sheet, dialog, drawer) start a fresh region with `resetInset()`.
 */
import { getContext, onDestroy, setContext } from 'svelte';
import { LAYOUT_INSET_CONTEXT } from './layout.shared.js';

type InsetScope =
	| { readonly kind: 'owned' }
	| { readonly kind: 'provisional'; readonly padded: boolean; claim(): () => void };

const OWNED: InsetScope = { kind: 'owned' };
const scope = () => getContext<InsetScope | undefined>(LAYOUT_INSET_CONTEXT);

/** Whether an ancestor already pads this subtree's edge. Call at init; the reader is reactive. */
export function insetReader(): () => boolean {
	const current = scope();
	return () => current?.kind === 'owned' || (current?.kind === 'provisional' && current.padded);
}

/** A scrollport with `inset`: pads unless an owner above already does; takes over a provisional one. */
export function ownInset(): boolean {
	const current = scope();
	setContext(LAYOUT_INSET_CONTEXT, OWNED);
	if (current?.kind === 'owned') return false;
	if (current?.kind === 'provisional') onDestroy(current.claim());
	return true;
}

/** A non-scrolling panel: pads until a scrollport inside claims the inset. */
export function provisionalInset(): { readonly padded: boolean } {
	if (scope() !== undefined) {
		setContext(LAYOUT_INSET_CONTEXT, OWNED);
		return { padded: false };
	}
	let claims = $state(0);
	const provisional: InsetScope = {
		kind: 'provisional',
		get padded() {
			return claims === 0;
		},
		claim() {
			claims++;
			return () => claims--;
		}
	};
	setContext(LAYOUT_INSET_CONTEXT, provisional);
	return provisional;
}

/** An overlay's content: a new page edge, owned by `owned` (a padded sheet) or by nobody yet. */
export function resetInset(owned: boolean): void {
	setContext(LAYOUT_INSET_CONTEXT, owned ? OWNED : undefined);
}
