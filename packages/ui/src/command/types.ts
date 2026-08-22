import { Schema } from 'effect';
import type { WithElementRef } from 'bits-ui';
import type { Snippet } from 'svelte';
import type { HTMLAttributes } from 'svelte/elements';

// ============================================================================
// Core Data Types
// ============================================================================

const CommandItemDataSchema = Schema.StructWithRest(
	Schema.Struct({
		value: Schema.mutableKey(Schema.String),
		disabled: Schema.mutableKey(Schema.optionalKey(Schema.Boolean)),
		keywords: Schema.mutableKey(Schema.optionalKey(Schema.Array(Schema.String))),
		groupId: Schema.mutableKey(Schema.optionalKey(Schema.String)),
		label: Schema.mutableKey(Schema.optionalKey(Schema.String)),
		description: Schema.mutableKey(Schema.optional(Schema.String)),
		href: Schema.mutableKey(Schema.optionalKey(Schema.String))
	}),
	[Schema.Record(Schema.String, Schema.Unknown)]
);
export type CommandItemData = typeof CommandItemDataSchema.Type;

// ============================================================================
// Filter Function
// ============================================================================

export type FilterFunction = (
	value: string,
	search: string,
	keywords?: readonly string[]
) => number;

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
	readonly activeValue?: string | undefined;
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
	activeValue?: string | undefined;
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
	Omit<HTMLAttributes<HTMLInputElement>, 'prefix' | 'aria-label'>
> {
	value?: string;
	placeholder?: string | undefined;
	'aria-label'?: string | undefined;
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
