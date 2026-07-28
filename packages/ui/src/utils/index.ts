// oxlint-disable no-explicit-any
import { getLocalTimeZone, parseAbsolute, toCalendarDate } from '@internationalized/date';
import { parseUtcInstant, formatDateRangeLocal } from '@norbital-ai/std/date';
import { type ClassValue, clsx } from 'clsx';
import type { Component, ComponentProps, Snippet } from 'svelte';
import { twMerge } from 'tailwind-merge';

export { createInfiniteLoader, type InfiniteLoader } from './infinite_loader.svelte.js';

export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs));
}

export function formatFileSize(bytes: number): string {
	if (bytes === 0) return '0 B';
	const units = ['B', 'KB', 'MB', 'GB'];
	const unit = Math.floor(Math.log(bytes) / Math.log(1024));
	return `${(bytes / Math.pow(1024, unit)).toFixed(1)} ${units[unit]}`;
}

export const DEFAULT_CSS = {
	INPUT_ELEMENT: {
		TW_UNIT: 8,
		REM: 2,
		PX: 32
	}
};

export type WithoutChild<T> = T extends { child?: any } ? Omit<T, 'child'> : T;
export type WithoutChildren<T> = T extends { children?: any } ? Omit<T, 'children'> : T;
export type WithoutChildrenOrChild<T> = WithoutChildren<WithoutChild<T>>;
export type WithElementRef<T, U extends HTMLElement = HTMLElement> = T & {
	ref?: U | null;
};

/**
 * A helper class to make it easy to identify Svelte components in
 * `columnDef.cell` and `columnDef.header` properties.
 *
 * > NOTE: This class should only be used internally by the adapter. If you're
 * reading this and you don't know what this is for, you probably don't need it.
 *
 * @example
 * The cast below is illustrative for the JSDoc snippet only — not runtime code.
 * ```svelte
 * {@const result = content(context as any)}
 * {#if result instanceof RenderComponentConfig}
 *   {@const { component: Component, props } = result}
 *   <Component {...props} />
 * {/if}
 * ```
 */
export class RenderComponentConfig<TComponent extends Component> {
	component: TComponent;
	props: ComponentProps<TComponent> | Record<string, never>;
	constructor(
		component: TComponent,
		props: ComponentProps<TComponent> | Record<string, never> = {}
	) {
		this.component = component;
		this.props = props;
	}
}

/**
 * A helper class to make it easy to identify Svelte Snippets in `columnDef.cell` and `columnDef.header` properties.
 *
 * > NOTE: This class should only be used internally by the adapter. If you're
 * reading this and you don't know what this is for, you probably don't need it.
 *
 * @example
 * The cast below is illustrative for the JSDoc snippet only — not runtime code.
 * ```svelte
 * {@const result = content(context as any)}
 * {#if result instanceof RenderSnippetConfig}
 *   {@const { snippet, params } = result}
 *   {@render snippet(params)}
 * {/if}
 * ```
 */
export class RenderSnippetConfig<TProps> {
	snippet: Snippet<[TProps]>;
	params: TProps;
	constructor(snippet: Snippet<[TProps]>, params: TProps) {
		this.snippet = snippet;
		this.params = params;
	}
}

/**
 * A helper function to help create cells from Svelte components through ColumnDef's `cell` and `header` properties.
 *
 * This is only to be used with Svelte Components - use `renderSnippet` for Svelte Snippets.
 *
 * @param component A Svelte component
 * @param props The props to pass to `component`
 * @returns A `RenderComponentConfig` object that helps svelte-table know how to render the header/cell component.
 * @example
 * ```ts
 * // +page.svelte
 * const defaultColumns = [
 *   columnHelper.accessor('name', {
 *     header: header => renderComponent(SortHeader, { label: 'Name', header }),
 *   }),
 *   columnHelper.accessor('state', {
 *     header: header => renderComponent(SortHeader, { label: 'State', header }),
 *   }),
 * ]
 * ```
 * @see {@link https://tanstack.com/table/latest/docs/guide/column-defs}
 */
export function renderComponent<
	// oxlint-disable-next-line no-explicit-any
	T extends Component<any>,
	Props extends ComponentProps<T>
>(component: T, props: Props) {
	return new RenderComponentConfig(component, props);
}

/**
 * A helper function to help create cells from Svelte Snippets through ColumnDef's `cell` and `header` properties.
 *
 * The snippet must only take one parameter.
 *
 * This is only to be used with Snippets - use `renderComponent` for Svelte Components.
 *
 * @param snippet
 * @param params
 * @returns - A `RenderSnippetConfig` object that helps svelte-table know how to render the header/cell snippet.
 * @example
 * ```ts
 * // +page.svelte
 * const defaultColumns = [
 *   columnHelper.accessor('name', {
 *     cell: cell => renderSnippet(nameSnippet, { name: cell.row.name }),
 *   }),
 *   columnHelper.accessor('state', {
 *     cell: cell => renderSnippet(stateSnippet, { state: cell.row.state }),
 *   }),
 * ]
 * ```
 * @see {@link https://tanstack.com/table/latest/docs/guide/column-defs}
 */
export function renderSnippet<TProps>(snippet: Snippet<[TProps]>, params: TProps) {
	return new RenderSnippetConfig(snippet, params);
}

/** Parses a stored UTC ISO instant for display in the local timezone. */
export function parseServerTimestamp(input: string): Date | null {
	if (!input) return null;
	try {
		return parseUtcInstant(input);
	} catch {
		return null;
	}
}

/** Parse a stored UTC ISO instant for calendar/time pickers (local timezone). */
export function parseUtcInstantZoned(value: string) {
	return parseAbsolute(parseUtcInstant(value).toISOString(), getLocalTimeZone());
}

export { formatDateRangeLocal, formatUtcInstantLocal } from '@norbital-ai/std/date';
