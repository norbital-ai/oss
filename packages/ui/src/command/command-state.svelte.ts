import { watch } from 'runed';
import { createContext } from 'svelte';
import type { CommandItemData, CommandStateProps, FilterFunction } from '#lib/command/types';

// ============================================================================
// Command Context
// ============================================================================

export const [getCommandState, setCommandState] = createContext<() => CommandState>();

// ============================================================================
// Command State Manager
// ============================================================================

export class CommandState {
	// Store props object - access via getters for reactivity
	readonly #props: CommandStateProps;

	// DOM reference for grid layout
	listRef?: HTMLElement;

	// Internal state - initialized from props, then managed internally
	indicatorItemValue = $state<string | null>(null);
	filterValue = $state('');

	// Input mode tracking
	inputMode = $state<'keyboard' | 'mouse'>('keyboard');

	// Input focus tracking
	isInputFocused = $state(false);

	// Mouse inside list tracking
	mouseInsideList = $state(false);

	// Derived: filtered visible items
	visibleItems = $derived(this.#computeVisibleItems());

	// Stable signature for reactive deps (avoids whole-list JSON.stringify in watches)
	visibleItemsSignature = $derived(
		this.visibleItems
			.map((item) => `${JSON.stringify(item.value)}:${item.disabled ? 1 : 0}`)
			.join(',')
	);

	// Effective highlight: always an enabled visible value when any exist.
	resolvedIndicatorValue = $derived.by(() => {
		const enabledItems = this.visibleItems.filter((item) => !item.disabled);
		if (enabledItems.length === 0) {
			return null;
		}
		if (
			this.indicatorItemValue &&
			enabledItems.some((item) => item.value === this.indicatorItemValue)
		) {
			return this.indicatorItemValue;
		}
		const preferredValue = this.#props.activeValue;
		if (preferredValue && enabledItems.some((item) => item.value === preferredValue)) {
			return preferredValue;
		}
		return enabledItems[0].value;
	});

	// Show ring only while using keyboard (focused input) or hovering the list with the mouse.
	get shouldShowIndicator() {
		if (this.inputMode === 'keyboard') {
			return this.isInputFocused;
		}
		return this.mouseInsideList;
	}

	// Grid layout map for 2D navigation
	#gridMap: string[][] = [];

	// Reactive getters - reading props.x triggers Svelte's reactivity tracking
	get items(): CommandItemData[] {
		return this.#props.items ?? [];
	}

	get activeValues(): string[] {
		const value = this.#props.value;
		if (!value) return [];
		return Array.isArray(value) ? value : [value];
	}

	get shouldFilter(): boolean {
		return this.#props.shouldFilter;
	}

	get filterFn(): FilterFunction | undefined {
		return this.#props.filterFn;
	}

	get columns(): number | undefined {
		return this.#props.columns;
	}

	get onChange(): ((value: string) => void) | undefined {
		return this.#props.onChange;
	}

	constructor(props: CommandStateProps) {
		this.#props = props;

		// Initialize from props
		this.indicatorItemValue = props.activeValue ?? null;
		this.filterValue = props.searchValue ?? '';

		// Sync filterValue when searchValue prop changes (for controlled input)
		watch(
			() => this.#props.searchValue,
			(value) => {
				this.#updateFilter(value ?? '');
			}
		);
	}

	// ============================================================================
	// Public Methods - State Setters
	// ============================================================================

	setListRef(element: HTMLElement) {
		this.listRef = element;
	}

	setInputFocused(isFocused: boolean) {
		this.isInputFocused = isFocused;
	}

	setIndicator(value: string | null) {
		this.indicatorItemValue = value;
	}

	setFilter(value: string) {
		this.#updateFilter(value);
	}

	// ============================================================================
	// Public Methods - Navigation
	// ============================================================================

	// Helper: find next/prev non-disabled item
	#findNextEnabled(items: CommandItemData[], startIndex: number, direction: 1 | -1): number {
		const len = items.length;
		let index = startIndex;
		for (let i = 0; i < len; i++) {
			index = (index + direction + len) % len;
			if (!items[index].disabled) return index;
		}
		return -1;
	}

	#getFirstEnabled(items: CommandItemData[]): CommandItemData | undefined {
		return items.find((item) => !item.disabled);
	}

	#getLastEnabled(items: CommandItemData[]): CommandItemData | undefined {
		return [...items].reverse().find((item) => !item.disabled);
	}

	#getEnabledVisibleItems(): CommandItemData[] {
		return this.visibleItems.filter((item) => !item.disabled);
	}

	#anchorToFirstEnabled(enabledItems: CommandItemData[]) {
		const first = enabledItems[0];
		this.setIndicator(first?.value ?? null);
	}

	#updateFilter(nextValue: string) {
		const previousValue = this.filterValue;
		this.filterValue = nextValue;

		// Clearing search should always reset keyboard anchoring to the top row.
		if (this.shouldFilter && previousValue.length > 0 && nextValue.length === 0) {
			this.#anchorToFirstEnabled(this.#getEnabledVisibleItems());
		}
	}

	#getIndicatorIndexForNavigation(
		items: CommandItemData[],
		fallback: 'first' | 'last'
	): number | null {
		const resolved = this.resolvedIndicatorValue;
		if (!resolved) {
			const fallbackItem =
				fallback === 'first' ? this.#getFirstEnabled(items) : this.#getLastEnabled(items);
			if (fallbackItem) this.setIndicator(fallbackItem.value);
			return null;
		}

		const currentIndex = items.findIndex((i) => i.value === resolved);
		if (currentIndex === -1) {
			const fallbackItem =
				fallback === 'first' ? this.#getFirstEnabled(items) : this.#getLastEnabled(items);
			if (fallbackItem) this.setIndicator(fallbackItem.value);
			return null;
		}

		return currentIndex;
	}

	navigateDown() {
		const items = this.visibleItems;
		if (items.length === 0) return;

		const currentIndex = this.#getIndicatorIndexForNavigation(items, 'first');
		if (currentIndex === null) return;

		if (!this.columns || this.columns <= 1) {
			const nextIndex = this.#findNextEnabled(items, currentIndex, 1);
			if (nextIndex >= 0) this.setIndicator(items[nextIndex].value);
			return;
		}

		// Grid navigation
		this.#computeGridMap();
		const currentValue = items[currentIndex]?.value;
		if (!currentValue) return;
		const pos = this.#getGridPosition(currentValue);
		if (!pos) return;

		const nextRow = this.#gridMap[pos.row + 1];
		if (nextRow) {
			const nextItem = nextRow[Math.min(pos.col, nextRow.length - 1)];
			if (nextItem) this.setIndicator(nextItem);
		}
	}

	navigateUp() {
		const items = this.visibleItems;
		if (items.length === 0) return;

		const currentIndex = this.#getIndicatorIndexForNavigation(items, 'last');
		if (currentIndex === null) return;

		if (!this.columns || this.columns <= 1) {
			const prevIndex = this.#findNextEnabled(items, currentIndex, -1);
			if (prevIndex >= 0) this.setIndicator(items[prevIndex].value);
			return;
		}

		// Grid navigation
		this.#computeGridMap();
		const currentValue = items[currentIndex]?.value;
		if (!currentValue) return;
		const pos = this.#getGridPosition(currentValue);
		if (!pos || pos.row === 0) return;

		const prevRow = this.#gridMap[pos.row - 1];
		if (prevRow) {
			const prevItem = prevRow[Math.min(pos.col, prevRow.length - 1)];
			if (prevItem) this.setIndicator(prevItem);
		}
	}

	navigateRight() {
		const items = this.visibleItems;
		if (items.length === 0) return;

		const currentIndex = this.#getIndicatorIndexForNavigation(items, 'first');
		if (currentIndex === null) return;

		if (!this.columns || this.columns <= 1) {
			const nextIndex = this.#findNextEnabled(items, currentIndex, 1);
			if (nextIndex >= 0) this.setIndicator(items[nextIndex].value);
			return;
		}

		// Grid navigation
		this.#computeGridMap();
		const currentValue = items[currentIndex]?.value;
		if (!currentValue) return;
		const pos = this.#getGridPosition(currentValue);
		if (!pos) return;

		const currentRow = this.#gridMap[pos.row];
		if (pos.col < currentRow.length - 1) {
			this.setIndicator(currentRow[pos.col + 1]);
		}
	}

	navigateLeft() {
		const items = this.visibleItems;
		if (items.length === 0) return;

		const currentIndex = this.#getIndicatorIndexForNavigation(items, 'last');
		if (currentIndex === null) return;

		if (!this.columns || this.columns <= 1) {
			const prevIndex = this.#findNextEnabled(items, currentIndex, -1);
			if (prevIndex >= 0) this.setIndicator(items[prevIndex].value);
			return;
		}

		// Grid navigation
		this.#computeGridMap();
		const currentValue = items[currentIndex]?.value;
		if (!currentValue) return;
		const pos = this.#getGridPosition(currentValue);
		if (!pos || pos.col === 0) return;

		const currentRow = this.#gridMap[pos.row];
		this.setIndicator(currentRow[pos.col - 1]);
	}

	navigateFirst() {
		const first = this.#getFirstEnabled(this.visibleItems);
		if (first) this.setIndicator(first.value);
	}

	navigateLast() {
		const last = this.#getLastEnabled(this.visibleItems);
		if (last) this.setIndicator(last.value);
	}

	selectCurrent() {
		const value = this.resolvedIndicatorValue;
		if (value) {
			this.onChange?.(value);
		}
	}

	// ============================================================================
	// Private Methods - Filtering
	// ============================================================================

	#computeVisibleItems(): CommandItemData[] {
		const allItems = this.items;

		if (this.shouldFilter && this.filterValue) {
			return allItems.filter((item) => this.#filterItem(item));
		}

		return allItems;
	}

	#filterItem(item: CommandItemData): boolean {
		if (!this.shouldFilter || !this.filterValue) return true;

		const score = this.filterFn
			? this.filterFn(item.value, this.filterValue, item.keywords)
			: this.#defaultFilter(item);

		return score > 0;
	}

	#defaultFilter(item: CommandItemData): number {
		const search = this.filterValue.toLowerCase();
		const value = item.value.toLowerCase();

		if (value.includes(search)) return 1;

		if (item.keywords) {
			for (const keyword of item.keywords) {
				if (keyword.toLowerCase().includes(search)) return 1;
			}
		}

		// Also check label and description if present
		if (item.label && item.label.toLowerCase().includes(search)) return 1;
		if (item.description && item.description.toLowerCase().includes(search)) return 1;

		return 0;
	}

	// ============================================================================
	// Private Methods - Grid Layout
	// ============================================================================

	#computeGridMap(): void {
		if (!this.listRef || this.visibleItems.length === 0) {
			this.#gridMap = [];
			return;
		}

		const listRect = this.listRef.getBoundingClientRect();
		const itemPositions: Array<{
			value: string;
			top: number;
			left: number;
			height: number;
		}> = [];

		for (const item of this.visibleItems) {
			const itemEl = this.listRef.querySelector<HTMLElement>(`[data-value="${item.value}"]`);
			if (!itemEl) continue;

			const rect = itemEl.getBoundingClientRect();
			itemPositions.push({
				value: item.value,
				top: rect.top - listRect.top,
				left: rect.left - listRect.left,
				height: rect.height
			});
		}

		if (itemPositions.length === 0) {
			this.#gridMap = [];
			return;
		}

		// Sort by Y then X
		itemPositions.sort((a, b) => {
			const rowDiff = a.top - b.top;
			if (Math.abs(rowDiff) > a.height / 2) return rowDiff;
			return a.left - b.left;
		});

		// Group into rows
		const rows: string[][] = [];
		let currentRowIndex = 0;
		let currentRowTop = itemPositions[0].top;

		for (const pos of itemPositions) {
			if (Math.abs(pos.top - currentRowTop) > pos.height / 2) {
				currentRowIndex++;
				currentRowTop = pos.top;
			}

			if (!rows[currentRowIndex]) {
				rows[currentRowIndex] = [];
			}
			rows[currentRowIndex].push(pos.value);
		}

		this.#gridMap = rows;
	}

	#getGridPosition(itemValue: string): { row: number; col: number } | null {
		for (let row = 0; row < this.#gridMap.length; row++) {
			const col = this.#gridMap[row].indexOf(itemValue);
			if (col !== -1) return { row, col };
		}
		return null;
	}
}
