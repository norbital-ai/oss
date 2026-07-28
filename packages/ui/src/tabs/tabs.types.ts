import type { Snippet } from 'svelte';

export const WORKSPACE_TAB_TRIGGER_TEXT_CLASS = 'text-xs font-medium';

export type TabListVariant = 'default' | 'underline' | 'chip';
export type TabListSemantics = 'default' | 'info' | 'warning' | 'danger' | 'success';
export type TabListLayout = 'horizontal' | 'vertical' | 'responsive';

export type TabConfig = {
	/** Tab id and default label when `label` is omitted. Or a snippet trigger (auto id `tab-${index}`). */
	name: string | Snippet;
	content: Snippet | string;
	/** Visible label or custom trigger when `name` is a string id. */
	label?: string | Snippet;
	/** Optional Iconify id or canonical `product:*` reference rendered before the label. */
	icon?: string;
	/** Tooltip and `aria-label` when the visible label is omitted or empty. */
	description?: string;
	disabled?: boolean;
	keepAlive?: boolean;
	lazyLoad?: boolean;
};

export type TabsProps = {
	config: TabConfig[];
	value?: string;
	onValueChange?: (value: string) => void;
	class?: string;
	listClass?: string;
	listStyle?: string;
	contentPadding?: boolean;
	variant?: TabListVariant;
	semantics?: TabListSemantics;
	layout?: TabListLayout;
	keepAlive?: boolean;
	lazyLoad?: boolean;
	animate?: boolean;
	showContent?: boolean;
	header?: Snippet<[{ list: Snippet }]>;
	listPrefix?: Snippet;
	listSuffix?: Snippet;
};
