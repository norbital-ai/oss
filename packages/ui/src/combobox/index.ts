import type { Snippet } from 'svelte';
export { default as Combobox } from './combobox.svelte';
/**
 * Represents a single selectable option within the combobox.
 * @template T - The underlying data type of the option's value.
 * @template AP - A record of additional properties for custom label rendering.
 */
export type TOption<T, AP extends Record<string, unknown>> = {
	/** Extra props to be spread into the label snippet for custom rendering. */
	additionalLabelProps?: AP;
	/**
	 * The display label for the option. Can be a simple string or a Svelte Snippet
	 * for complex, custom rendering.
	 */
	label:
		Snippet<[T, AP, onDelete?: (e: MouseEvent & { currentTarget: EventTarget }) => void]> | string;
	/** The unique value of the option. */
	value: T;
	/** An optional category to group the option under. */
	type?: string;
	/** An optional longer description for the option. */
	description?: string;
	/** Optional leading Iconify icon shown in the dropdown. */
	icon?: string;
	/** Optional compact trailing label shown in the dropdown. */
	badge?: string;
	/** Additional text to be included during client-side filtering. */
	search_term?: string;
};

export type TComboboxCommandItem<T, TAdditionalProps extends Record<string, unknown>> =
	| { value: string; label: string; disabled: boolean; _type: 'group'; _groupName: string }
	| {
			value: string;
			label: string;
			_type: 'select-all';
			_selectedCount: number;
			_totalCount: number;
			_allSelected: boolean;
	  }
	| { value: string; label: string; _type: 'option'; _option: TOption<T, TAdditionalProps> }
	| { value: string; label: string; _type: 'create' };

/**
 * Configuration for the infinite loading feature.
 * When provided, the component will monitor scroll position and request more data as needed.
 */
export interface TInfiniteLoadingConfig {
	/** The total number of items available on the server. */
	total: number;
	/** A boolean indicating if there are more items to fetch. */
	hasMore: boolean;
	/**
	 * A callback function triggered when the user scrolls near the end of the list.
	 * The parent component is responsible for fetching more data and updating the `options` prop.
	 * @param info - Details about the current state for fetching.
	 * @param info.loadedCount - The number of items currently loaded in the component.
	 * @param info.lastVirtualIndex - The index of the last rendered virtual item.
	 */
	handleInfiniteLoad: (info: { loadedCount: number; lastVirtualIndex: number }) => void;
}

/**
 * Base properties shared across all combobox types.
 */
export interface TComboboxBaseProps<
	T,
	TAdditionalProps extends Record<string, unknown>,
	TMultiple extends boolean = false
> {
	// Core Data & State
	options: TOption<T, TAdditionalProps>[];
	value?: TMultiple extends true ? T[] | null : T | null;

	// Behavior
	multiple?: TMultiple;
	/**
	 * Adds a keyboard-accessible row for selecting or clearing every loaded option.
	 * Only available for client-side multi-select comboboxes without infinite loading.
	 */
	allowSelectAll?: TMultiple extends true ? boolean : never;
	display?: Snippet<[TMultiple extends true ? T[] : T]>;
	emptyPlaceholder?: string | Snippet;
	InlineCreateForm?: Snippet<
		[
			{
				newValue: string;
				cancel: () => void;
				setSubmitting: (v: boolean) => void;
				submitting: boolean;
				onSuccess: (newOption: TOption<T, TAdditionalProps>) => void;
			}
		]
	>;
	allowClear?: boolean;
	/** When true, clicking an already-selected option clears the value (single-select only). */
	allowClickToSetNull?: boolean;
	hideChevron?: boolean;
	disabled?: boolean;
	invalid?: boolean;
	readonly?: boolean;
	readonlyContent?: Snippet;
	truncate?: boolean;
	/** Optional content rendered directly under the search box (option filters, scope pickers). */
	header?: Snippet;
	/** Optional custom footer content rendered at the bottom of the dropdown. */
	footer?: Snippet;
	/**
	 * When true, preserves the original `options` order exactly.
	 * When false (default), the current selection is floated to the top for readability.
	 */
	preserveOptionOrder?: boolean;
	open?: boolean;
	style?: string;
	/** Stable accessible name for the combobox trigger. Defaults to the current selection summary. */
	ariaLabel?: string;

	// Search & Filtering
	searchable?: boolean;
	searchPlaceholder?: string;

	// Virtualization & Infinite Loading
	itemHeight?: number;
	groupHeaderHeight?: number;
	maxHeight?: number;
	overscan?: number;
	infiniteLoadingConfig?: TInfiniteLoadingConfig;
	/** When true, scroll the list to the current selection upon opening. */
	scrollToSelection?: boolean;

	// Styling
	class?: string;
	triggerClass?: string;
	sameWidth?: boolean;
	dropdownClass?: string;
	align?: 'start' | 'center' | 'end';
	minWidth?: number;
	maxWidth?: number;
	/**
	 * When true, the dropdown is clamped to whichever viewport edge it collides with
	 * instead of spilling past it: the preferred `side` is flipped and the alignment is
	 * shifted along the anchor until the dropdown fits.
	 *
	 * Handled natively by the underlying floating primitive (`flip` + `shift`), so the
	 * position is re-evaluated on scroll and resize rather than only when the dropdown opens.
	 *
	 * Set to `false` to pin the dropdown to `align` exactly and allow it to overflow.
	 *
	 * @default true
	 */
	avoidCollisions?: boolean;
	/**
	 * Virtual padding, in pixels, inset from the viewport edges when detecting collisions.
	 * Larger values keep the dropdown further away from the edge it clamps against.
	 * Has no effect when `avoidCollisions` is `false`.
	 *
	 * @default 8
	 */
	collisionPadding?: number;

	// Callbacks
	onValueChange?: (value: TMultiple extends true ? T[] | null : T | null) => void;
}

/**
 * Configuration for client-side filtering.
 */
export interface TClientConfig {
	/** An optional loading state, controlled by the parent. */
	isLoading?: boolean;
	/** An optional error message to display. */
	error?: string | null;
}

/**
 * Configuration for server-side filtering.
 */
export interface TServerConfig {
	/**
	 * **Required.** A callback that communicates the search query to the parent.
	 * The parent is responsible for updating the `options` prop.
	 * @param query The current search string.
	 */
	onSearch: (query: string) => void;
	/**
	 * Set to `true` to display a loading indicator. This should be managed by the parent.
	 */
	isLoading?: boolean;
	/** An optional error message to display. */
	error?: string | null;
}

/**
 * Properties for the client-side filtering combobox.
 */
export interface TComboboxClientProps {
	/** Specifies that filtering is handled client-side. */
	type?: 'client';
	/** An optional object for client-side configurations like loading and error states. */
	clientConfig?: TClientConfig;
	/** Server config is not applicable for client-side filtering. */
	serverConfig?: never;
}

/**
 * Properties for the server-side filtering combobox.
 */
interface TComboboxServerProps {
	/** Specifies that filtering is handled by the server. */
	type: 'server';
	/** A required object containing all properties and callbacks for server-side filtering. */
	serverConfig: TServerConfig;
	/** Client config is not applicable for server-side filtering. */
	clientConfig?: never;
}

/**
 * A discriminated union of combobox properties, providing strong type-safety
 * based on the filtering `type`.
 *
 * @template T - The underlying data type of an option's value.
 * @template TAdditionalProps - A record of extra props for the option label snippet.
 * @template TMultiple - A boolean indicating if multi-select is enabled.
 */
export type TComboboxProps<
	T,
	TAdditionalProps extends Record<string, unknown>,
	TMultiple extends boolean = false
> = TComboboxBaseProps<T, TAdditionalProps, TMultiple> &
	(TComboboxClientProps | TComboboxServerProps);
