import type { HTMLAttributes } from 'svelte/elements';

export type LayoutAttributes = Omit<HTMLAttributes<HTMLDivElement>, 'children'>;
/**
 * The elements a layout primitive may render as.
 *
 * The list is a whitelist of flow and inline *containers*, which is what keeps `as` from becoming a
 * way to render a layout primitive as a heading, a button, or anything else that carries behaviour
 * or typography of its own. Semantic sectioning elements belong here — the point of `as` is to let a
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
	| 'li';
export type LayoutGap = 'none' | 'xs' | 'sm' | 'md' | 'lg' | 'xl';
export type LayoutPad = Exclude<LayoutGap, 'xl'>;

export type ColumnParentContext =
	{ readonly kind: 'grid' } | { readonly kind: 'columns'; readonly count: () => number };

export const COLUMN_PARENT_CONTEXT = Symbol('norbital-column-parent');

export const GAP_CLASSES: Record<LayoutGap, string> = {
	none: 'gap-0',
	xs: 'gap-1',
	sm: 'gap-2',
	md: 'gap-4',
	lg: 'gap-6',
	xl: 'gap-8'
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
/** Full-bleed chrome with its own vertical rhythm (`PageHeader`). */
export const INSET_X_CLASS = 'px-4 sm:px-6';
/** Chrome that draws its own background and so cannot pad itself (tab list). */
export const INSET_MX_CLASS = 'mx-4 sm:mx-6';
