import type { HTMLAttributes } from 'svelte/elements';

export type LayoutAttributes = Omit<HTMLAttributes<HTMLElement>, 'children' | 'style'>;
export type LayoutElement =
	| 'div'
	| 'section'
	| 'main'
	| 'aside'
	| 'header'
	| 'footer'
	| 'nav'
	| 'form'
	| 'fieldset'
	| 'dl'
	| 'ol'
	| 'ul'
	| 'li';
export type LayoutGap = 'none' | 'xs' | 'sm' | 'md' | 'lg' | 'xl';
export type LayoutPad = Exclude<LayoutGap, 'xl'>;

export type ColumnParentContext =
	| { readonly kind: 'grid' }
	| { readonly kind: 'columns'; readonly count: () => number };

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
