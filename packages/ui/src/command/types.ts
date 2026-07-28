import type { WithElementRef } from 'bits-ui';
import type { Snippet } from 'svelte';
import type { HTMLAttributes } from 'svelte/elements';

// ============================================================================
// Core Data Types
// ============================================================================

export interface CommandItemData {
	value: string;
	disabled?: boolean;
	keywords?: string[];
	groupId?: string;
	label?: string;
	description?: string;
	href?: string;
	// Additional custom data
	[key: string]: unknown;
}

// ============================================================================
// Filter Function
// ============================================================================

export type FilterFunction = (value: string, search: string, keywords?: string[]) => number;

// ============================================================================
// Loading & Data Fetching Configs
// ============================================================================

export interface CommandClientConfig {
	isLoading?: boolean;
	error?: string | null;
}

export interface CommandServerConfig {
	onSearch: (query: string) => void;
	isLoading?: boolean;
	error?: string | Error | null;
}

export interface CommandInfiniteLoadingConfig {
	total: number;
	hasMore: boolean;
	onLoadMore: (info: { loadedCount: number; lastVisibleIndex: number }) => void;
}

// Infinite loading contract for command surfaces.
export interface TInfiniteLoadingConfig {
	total: number;
	hasMore: boolean;
	handleInfiniteLoad: (info: { loadedCount: number; lastVirtualIndex: number }) => void;
}

// ============================================================================
// State Props
// ============================================================================

export interface CommandStateProps {
	// Reactive props (pass with getters for reactivity)
	readonly items?: CommandItemData[];
	readonly searchValue?: string;
	readonly value?: string | string[];
	readonly activeValue?: string;
	// Configuration
	shouldFilter: boolean;
	filterFn?: FilterFunction;
	columns?: number;
	onChange?: (value: string) => void;
}

// ============================================================================
// Component Props
// ============================================================================

export interface CommandRootProps extends WithElementRef<HTMLAttributes<HTMLDivElement>> {
	// Data-driven items (new API for virtualization)
	items?: CommandItemData[];
	// Selected value(s)
	value?: string | string[];
	// Currently highlighted/indicator value
	activeValue?: string;
	// Search input value (for filtering)
	searchValue?: string;
	shouldFilter?: boolean;
	filter?: FilterFunction;
	columns?: number;
	onValueChange?: (value: string) => void;
	onIndicatorKeydown?: (
		event: KeyboardEvent,
		context: {
			indicatorValue: string | null;
			items: CommandItemData[];
		}
	) => boolean | void;
	children?: Snippet;
	disableNavigation?: boolean;
}

export interface CommandListProps extends WithElementRef<HTMLAttributes<HTMLDivElement>> {
	children?: Snippet;
	// Virtualization options (used when items are provided to Command.Root)
	itemHeight?: number;
	overscan?: number;
	// Gap between items (in pixels)
	gap?: number;
	// Custom item rendering snippet
	itemSnippet?: Snippet<
		[
			{
				item: CommandItemData;
				index: number;
				isIndicator: boolean;
				isSelected: boolean;
			}
		]
	>;
	// Placeholder snippet for unloaded items
	placeholderSnippet?: Snippet<[{ index: number }]>;
	// Loading threshold (items from end to trigger load, default: 5)
	loadMoreThreshold?: number;
	// Data fetching configs
	clientConfig?: CommandClientConfig;
	serverConfig?: CommandServerConfig;
	infiniteLoading?: CommandInfiniteLoadingConfig;
}

export interface CommandGroupProps extends WithElementRef<HTMLAttributes<HTMLDivElement>> {
	heading?: string;
	children?: Snippet;
}

export interface CommandGroupHeadingProps extends WithElementRef<HTMLAttributes<HTMLDivElement>> {
	children?: Snippet;
}

export interface CommandGroupItemsProps extends WithElementRef<HTMLAttributes<HTMLDivElement>> {
	children?: Snippet;
}

export interface CommandInputProps extends WithElementRef<
	Omit<HTMLAttributes<HTMLInputElement>, 'prefix'>
> {
	value?: string;
	placeholder?: string;
	disabled?: boolean;
	prefix?: Snippet;
	suffix?: Snippet;
	outerClass?: string;
}

export interface CommandEmptyProps extends WithElementRef<HTMLAttributes<HTMLDivElement>> {
	children?: Snippet;
	// When true, always show empty state (useful for children-based mode)
	show?: boolean;
}

export interface CommandSeparatorProps extends WithElementRef<HTMLAttributes<HTMLDivElement>> {}

export interface CommandLoadingProps extends WithElementRef<HTMLAttributes<HTMLDivElement>> {
	children?: Snippet;
}

export interface CommandDialogProps {
	open?: boolean;
	value?: string;
	onOpenChange?: (open: boolean) => void;
	children?: Snippet;
}

export interface CommandShortcutProps extends WithElementRef<HTMLAttributes<HTMLSpanElement>> {
	children?: Snippet;
}
