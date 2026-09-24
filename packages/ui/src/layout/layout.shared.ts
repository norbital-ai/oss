import type {
	HTMLAnchorAttributes,
	HTMLAttributes,
	HTMLButtonAttributes,
	HTMLLabelAttributes
} from 'svelte/elements';

/**
 * Attributes a primitive accepts: any element's, plus the few a `button`, `a` or `label` rendering
 * needs (`as="button"` takes `type` and `disabled`; `as="a"` takes `href`).
 */
export type LayoutAttributes = Omit<HTMLAttributes<HTMLDivElement>, 'children'> &
	Pick<HTMLButtonAttributes, 'type' | 'disabled' | 'form' | 'name' | 'value'> &
	Pick<HTMLAnchorAttributes, 'href' | 'target' | 'rel' | 'download' | 'hreflang'> &
	Pick<HTMLLabelAttributes, 'for'> & {
		/** The rendered element, for measurement or focus. */
		ref?: HTMLElement | null;
	};
/**
 * The elements a layout primitive may render as.
 *
 * The list is a whitelist of flow and inline *containers*, which is what keeps `as` from becoming a
 * way to render a layout primitive as a heading or anything else that carries typography of its
 * own. `button`, `a` and `label` are here because a control whose content is laid out is otherwise
 * a raw flex element or a control wrapping a layout span. Semantic sectioning elements belong here — the point of `as` is to let a
 * region be a `<section>` or an `<article>` without giving up the primitive's layout.
 */
export type LayoutElement =
	| 'div'
	| 'span'
	| 'section'
	| 'article'
	| 'main'
	| 'aside'
	| 'header'
	| 'footer'
	| 'nav'
	| 'form'
	| 'fieldset'
	| 'figure'
	| 'figcaption'
	| 'dl'
	| 'ol'
	| 'ul'
	| 'li'
	// Interactive containers: a row, a card or a chip that IS the control, with no wrapper span.
	| 'button'
	| 'a'
	| 'label';
export type LayoutGap = 'none' | 'xs' | 'sm' | 'md' | 'lg' | 'xl';
export type LayoutPad = Exclude<LayoutGap, 'xl'>;

export type ColumnParentContext =
	{ readonly kind: 'grid' } | { readonly kind: 'columns'; readonly count: () => number };

export const COLUMN_PARENT_CONTEXT = Symbol('norbital-column-parent');

/**
 * The gap scale. Every stacking primitive spends it; it is exported for the same reason
 * `INSET_MX_CLASS` is — a box that cannot be a primitive still owes the same rhythm.
 */
export const GAP_CLASSES: Record<LayoutGap, string> = {
	none: 'gap-0',
	xs: 'gap-1',
	sm: 'gap-2',
	md: 'gap-4',
	lg: 'gap-6',
	xl: 'gap-8'
};

/** The same scale on the block axis alone, for a grid whose rows sit tighter than its columns. */
export const ROW_GAP_CLASSES: Record<LayoutGap, string> = {
	none: 'gap-y-0',
	xs: 'gap-y-1',
	sm: 'gap-y-2',
	md: 'gap-y-4',
	lg: 'gap-y-6',
	xl: 'gap-y-8'
};

export type ScrollAxis = 'x' | 'y' | 'both';

/**
 * The scrollport classes, per axis — the one definition of what "this region scrolls" means.
 *
 * Per-axis `overscroll-contain`: an x-only reel must not trap the parent's vertical scroll, and
 * the axis that does not scroll is *clipped* rather than left visible, so a wide child cannot
 * paint outside the region.
 *
 * `Scroll` is how a region declares itself a scrollport, and is what almost every caller wants.
 * This token exists for the boxes `Scroll` cannot be: it fills its parent unconditionally, so a
 * pane bounded by its own `max-height` (a popover, a collapsible) or by a fixed height (a chip
 * reel) cannot be one — and neither can an element a third-party component or a ProseMirror
 * editor owns. Those honour the same contract by naming it, the way `INSET_MX_CLASS` lets chrome
 * that cannot pad itself still keep the app inset.
 */
export const SCROLL_AXIS_CLASSES: Record<ScrollAxis, string> = {
	// No static `overscroll-contain` here: Chrome halts scroll chaining at any contain'ed scroll
	// container, overflowing or not, so an inert region would eat the wheel meant for its ancestor.
	// `base.css` applies contain from `data-overflow`, only where the affordance measured overflow.
	x: 'overflow-x-auto overflow-y-clip',
	y: 'overflow-x-clip overflow-y-auto',
	both: 'overflow-auto'
};

export const PAD_CLASSES: Record<LayoutPad, string> = {
	none: 'p-0',
	xs: 'p-1',
	sm: 'p-2',
	md: 'p-4',
	lg: 'p-6'
};

/** The one app inset: content regions. The only legal consumer is the single inset owner. */
export const INSET_CLASS = 'px-4 py-2 sm:px-6';
/**
 * Set by a `Bound inset` for its subtree: the page already owns the horizontal inset, so chrome
 * that would otherwise supply its own (a default tab strip) aligns with the content instead of
 * stepping in a second time.
 */
export const LAYOUT_INSET_CONTEXT = Symbol('layout.inset');
/**
 * Set by every `Scroll` for its subtree: the nearest element that scrolls vertically. An x-only
 * reel forwards its parent's, so a virtual list in a lane of a horizontal board still finds the
 * lane.
 */
export const SCROLL_PORT_CONTEXT = Symbol('layout.scroll-port');
export type ScrollPort = { readonly element: HTMLElement | null };
/** Full-bleed chrome with its own vertical rhythm (`PageHeader`). */
export const INSET_X_CLASS = 'px-4 sm:px-6';
/** Chrome that draws its own background and so cannot pad itself (tab list). */
export const INSET_MX_CLASS = 'mx-4 sm:mx-6';
