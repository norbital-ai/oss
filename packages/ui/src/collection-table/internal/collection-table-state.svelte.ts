import CollectionTableCheckbox from './component/row-selection/collection-table-checkbox.svelte';
import { renderComponent } from '#lib/utils';
import { isPlainRecord } from '../collection-table-row-query.js';
import { uniqBy } from 'es-toolkit/array';
import { omit } from 'es-toolkit/object';
import { PersistedState, watch } from 'runed';
import type { Translate } from '../../data-renderer/index.js';

function getPath(obj: unknown, path: string): unknown {
	return path.split('.').reduce((o: unknown, k: string) => {
		if (!isPlainRecord(o)) return undefined;
		return o[k];
	}, obj);
}

export type TableSortEntry = {
	field: string;
	order: 'asc' | 'desc';
};

export const COLLECTION_TABLE_SELECTION_COLUMN_ID = 'norbital_select' as const;

type TableState<T> = PersistedState<T> | MemoryState<T>;

class MemoryState<T> {
	current = $state() as T;

	constructor(initialValue: T) {
		this.current = initialValue;
	}
}

function createTableState<T>(key: string, initialValue: T, persistState: boolean): TableState<T> {
	if (persistState) return new PersistedState<T>(key, initialValue);
	return new MemoryState(initialValue);
}

/**
 * Optional callback handlers that are invoked when table state changes.
 * These allow parent components to react to state mutations without using
 * external `watch` or `$effect` patterns.
 */
export type TableCallbacks<TCondition> = {
	onSelectionChange?: (selectedIds: string[]) => void;
	onExpandedChange?: (expandedIds: string[]) => void;
	onSortChange?: (sort: TableSortEntry[]) => void;
	onConditionChange?: (condition: TCondition) => void;
	onColumnVisibilityChange?: (visibility: Record<string, boolean>) => void;
	onColumnSizingChange?: (sizing: Record<string, number>) => void;
	onColumnOrderChange?: (order: string[]) => void;
	onPinnedColumnsChange?: (pinned: Record<string, boolean>) => void;
};

export type TCreateColumnProps<T extends Record<string, unknown>, TCondition = unknown> = Omit<
	ConstructorParameters<typeof ColumnAPI<T, TCondition>>['0'],
	'table'
>;

export class RowAPI<T extends Record<string, unknown>, TCondition = unknown> {
	id = $state() as string;
	index = $state() as number;
	raw: T;
	private table = $state() as TableAPI<T, TCondition>;

	isSelected = $derived(Boolean(this.table.rowSelection.current[this.id]));
	isExpanded = $derived(Boolean(this.table.expanded.current[this.id]));

	constructor(args: { id: string; index: number; raw: T; table: TableAPI<T, TCondition> }) {
		this.id = args.id;
		this.index = args.index;
		this.raw = args.raw;
		this.table = args.table;
	}

	toggleSelection() {
		this.table.toggleRowSelection(this.id);
	}

	toggleExpanded() {
		this.table.toggleRowExpanded(this.id);
	}
}

export class ColumnAPI<T extends Record<string, unknown>, TCondition = unknown> {
	id = $state() as string;
	header: ({ table }: { table: TableAPI<T, TCondition> }) => unknown;
	cell?: ({ row }: { row: RowAPI<T, TCondition> }) => unknown;
	accessor?: (row: RowAPI<T, TCondition>) => unknown;
	initialWidth?: number;
	minWidth?: number;
	maxWidth?: number;
	displayOptions?: Array<{ value: string; label: string }>;
	currentDisplay?: string;
	onDisplayChange?: (value: string) => void;
	private table = $state() as TableAPI<T, TCondition>;

	enableSorting: boolean;
	enablePinning: boolean;
	enableResizing: boolean;
	enableHiding: boolean;
	enableSelection: boolean;

	isVisible = $derived(this.table.columnVisibility.current[this.id] !== false);

	isPinned = $derived(
		this.id === COLLECTION_TABLE_SELECTION_COLUMN_ID ||
			Boolean(this.table.pinnedColumns.current[this.id])
	);

	width = $derived(
		this.table.columnSizing.current[this.id] ?? this.initialWidth ?? this.table.DEFAULT_WIDTH
	);

	sortDirection = $derived.by<'asc' | 'desc' | undefined>(() => {
		const entry = this.table.sort.current.find(
			(s) => s.field === `default.${this.id}` || s.field.split('.').includes(this.id)
		);
		return entry?.order;
	});

	constructor(init: {
		id: string;
		table: TableAPI<T, TCondition>;
		header: ColumnAPI<T, TCondition>['header'];
		cell?: ColumnAPI<T, TCondition>['cell'];
		accessor?: ColumnAPI<T, TCondition>['accessor'];
		width?: number;
		minWidth?: number;
		maxWidth?: number;
		enableSorting?: boolean;
		enablePinning?: boolean;
		enableResizing?: boolean;
		enableHiding?: boolean;
		enableSelection?: boolean;
		displayOptions?: Array<{ value: string; label: string }>;
		currentDisplay?: string;
		onDisplayChange?: (value: string) => void;
	}) {
		this.id = init.id;
		this.table = init.table;
		this.header = init.header;
		this.cell = init.cell;
		this.accessor = init.accessor;
		this.initialWidth = init.width;
		this.minWidth = init.minWidth;
		this.maxWidth = init.maxWidth;
		this.displayOptions = init.displayOptions;
		this.currentDisplay = init.currentDisplay;
		this.onDisplayChange = init.onDisplayChange;
		this.enableSorting = init.enableSorting ?? true;
		this.enablePinning = init.enablePinning ?? true;
		this.enableResizing = init.enableResizing ?? true;
		this.enableHiding = init.enableHiding ?? true;
		this.enableSelection = init.enableSelection ?? true;
	}

	toggleSort() {
		this.table.toggleSort(this.id);
	}
	togglePin() {
		this.table.toggleColumnPin(this.id);
	}
	toggleVisibility() {
		this.table.toggleColumnVisibility(this.id);
	}
	setSize(newSize: number) {
		this.table.setColumnSize(this.id, newSize);
	}
}

export class TableAPI<T extends Record<string, unknown>, TCondition = unknown> {
	readonly CHECKBOX_WIDTH = 48;
	readonly DEFAULT_WIDTH = 150;

	persistenceKey: string;
	viewKey: string;
	rowKey: keyof T;

	private callbacks?: TableCallbacks<TCondition>;
	private parseCondition: (raw: unknown) => TCondition;

	data = $state<T[]>([]);
	totalRows = $state<number>(0);
	/** Domain freeze: locked rows stay visible but cannot join a bulk selection. */
	rowLocked: (row: T) => boolean = () => false;

	condition!: TableState<TCondition>;
	sort!: TableState<TableSortEntry[]>;

	rowSelection!: TableState<Record<string, boolean>>;
	expanded!: TableState<Record<string, boolean>>;
	columnVisibility!: TableState<Record<string, boolean>>;
	columnSizing!: TableState<Record<string, number>>;
	columnOrder!: TableState<string[]>;
	pinnedColumns!: TableState<Record<string, boolean>>;
	columnDisplay!: TableState<Record<string, string>>;
	contentFitWidths: Record<string, number> = $state({});

	columns: ColumnAPI<T, TCondition>[] = $state([]);

	rowInstances!: RowAPI<T, TCondition>[];
	rowIds!: string[];
	pageSelectionState!: {
		selectedCount: number;
		isAllSelected: boolean;
		isSomeSelected: boolean;
	};
	isAllPageRowsSelected!: boolean;
	isSomePageRowsSelected!: boolean;
	orderedColumns!: ColumnAPI<T, TCondition>[];
	columnLayouts!: Array<{
		id: string;
		width: number;
		isPinned: boolean;
		isCheckbox: boolean;
		leftOffset: number;
		index: number;
		instance: ColumnAPI<T, TCondition>;
		cssVar: `--table-col-${string}-width`;
		canResize: boolean;
	}>;

	constructor(args: {
		rowKey: string | keyof T | `${string}.${string}`;
		persistenceKey: string;
		viewKey: string;
		persistState?: boolean;
		data?: T[];
		totalRows?: number;
		columns?: TCreateColumnProps<T, TCondition>[];
		callbacks?: TableCallbacks<TCondition>;
		conditionDefault: TCondition;
		parseCondition: (raw: unknown) => TCondition;
		shouldApplyInitialCondition?: (condition: TCondition) => boolean;
		initialState?: {
			conditions?: TCondition;
			sort?: TableSortEntry[];
		};
	}) {
		this.rowKey = args.rowKey as keyof T;
		this.persistenceKey = args.persistenceKey;
		this.viewKey = args.viewKey;
		const persistState = args.persistState ?? true;
		this.data = args.data ?? [];
		this.totalRows = Math.max(0, args.totalRows ?? args.data?.length ?? 0);
		this.columns = args.columns?.map((c) => new ColumnAPI({ ...c, table: this })) ?? [];
		this.callbacks = args.callbacks;
		this.parseCondition = args.parseCondition;

		this.condition = createTableState(
			`${this.persistenceKey}.condition.v2`,
			args.conditionDefault,
			persistState
		);
		this.sort = createTableState<TableSortEntry[]>(`${this.persistenceKey}.sort`, [], persistState);
		this.rowSelection = createTableState(`${this.persistenceKey}.rowSelection`, {}, persistState);
		this.expanded = createTableState(`${this.persistenceKey}.expanded`, {}, persistState);
		this.columnVisibility = createTableState(
			`${this.persistenceKey}.columnVisibility`,
			{},
			persistState
		);
		this.columnSizing = createTableState(`${this.persistenceKey}.columnSizing`, {}, persistState);
		this.columnOrder = createTableState(`${this.persistenceKey}.columnOrder`, [], persistState);
		this.pinnedColumns = createTableState(`${this.persistenceKey}.pinnedColumns`, {}, persistState);
		this.columnDisplay = createTableState(`${this.persistenceKey}.columnDisplay`, {}, persistState);

		const init = args.initialState;
		if (
			init?.conditions !== undefined &&
			(args.shouldApplyInitialCondition?.(init.conditions) ?? true)
		) {
			this.condition.current = args.parseCondition(init.conditions);
		}
		this.condition.current = args.parseCondition(this.condition.current);
		if (init?.sort && init.sort.length > 0) {
			this.sort.current = init.sort.map((s) => ({
				field: s.field.startsWith('default.') ? s.field : `default.${s.field}`,
				order: s.order
			}));
		}

		this.rowInstances = $derived(this.data.map((raw, index) => this.createRowInstance(raw, index)));
		this.rowIds = $derived(this.rowInstances.map((r) => r.id));
		this.pageSelectionState = $derived.by(() => {
			const selectable = this.rowInstances.filter((row) => !this.rowLocked(row.raw));
			const selectedCount = selectable.filter((row) => this.rowSelection.current[row.id]).length;
			return {
				selectedCount,
				isAllSelected: selectable.length > 0 && selectedCount === selectable.length,
				isSomeSelected: selectedCount > 0 && selectedCount < selectable.length
			};
		});
		this.isAllPageRowsSelected = $derived(Boolean(this.pageSelectionState.isAllSelected));
		this.isSomePageRowsSelected = $derived(Boolean(this.pageSelectionState.isSomeSelected));

		this.orderedColumns = $derived.by(() => {
			const cols = this.visibleColumns;
			const selection = cols.find((c) => c.id === COLLECTION_TABLE_SELECTION_COLUMN_ID);
			const others = cols.filter((c) => c.id !== COLLECTION_TABLE_SELECTION_COLUMN_ID);

			const pinned = others.filter((c) => c.isPinned);
			const unpinned = others.filter((c) => !c.isPinned);

			const orderedUnpinned =
				this.columnOrder.current.length > 0
					? this.columnOrder.current
							.map((id) => unpinned.find((c) => c.id === id))
							.filter((c): c is ColumnAPI<T, TCondition> => !!c)
					: unpinned;

			const prefixedPinned = selection ? [selection, ...pinned] : pinned;
			return [...prefixedPinned, ...orderedUnpinned];
		}) as ColumnAPI<T, TCondition>[];

		this.columnLayouts = $derived.by(() => {
			const vis = this.orderedColumns;
			const pinned: ColumnAPI<T, TCondition>[] = [];
			const scroll: ColumnAPI<T, TCondition>[] = [];
			for (const c of vis) (c.isPinned ? pinned : scroll).push(c);

			let pinnedOffset = 0;
			let scrollOffset = 0;
			const out: Array<{
				id: string;
				width: number;
				isPinned: boolean;
				isCheckbox: boolean;
				leftOffset: number;
				index: number;
				instance: ColumnAPI<T, TCondition>;
				cssVar: `--table-col-${string}-width`;
				canResize: boolean;
			}> = [];

			let index = 0;
			const push = (c: ColumnAPI<T, TCondition>, isPinned: boolean, offset: number) => {
				const isCheckbox = c.id === COLLECTION_TABLE_SELECTION_COLUMN_ID;
				const width = isCheckbox ? this.CHECKBOX_WIDTH : c.width;

				out.push({
					id: c.id,
					width,
					isPinned,
					isCheckbox,
					leftOffset: offset,
					index,
					instance: c,
					cssVar: `--table-col-${c.id}-width` as const,
					canResize: !isCheckbox && c.enableResizing
				});
				index++;
			};

			for (const c of pinned) {
				push(c, true, pinnedOffset);
				pinnedOffset +=
					c.id === COLLECTION_TABLE_SELECTION_COLUMN_ID ? this.CHECKBOX_WIDTH : c.width;
			}
			for (const c of scroll) {
				push(c, false, scrollOffset);
				scrollOffset += c.width;
			}
			return out;
		});
	}

	private shallowEqualObject<V>(a: Record<string, V>, b: Record<string, V>): boolean {
		const aKeys = Object.keys(a);
		const bKeys = Object.keys(b);
		if (aKeys.length !== bKeys.length) return false;
		for (const k of aKeys) {
			if (a[k] !== b[k]) return false;
		}
		return true;
	}

	private shallowEqualStringArray(a: string[], b: string[]): boolean {
		if (a.length !== b.length) return false;
		for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
		return true;
	}

	private equalSortArray(a: TableSortEntry[], b: TableSortEntry[]): boolean {
		if (a.length !== b.length) return false;
		for (let i = 0; i < a.length; i++) {
			const x = a[i];
			const y = b[i];
			if (!x || !y) return false;
			if (x.field !== y.field || x.order !== y.order) return false;
		}
		return true;
	}

	private sortEntryMatchesColumn(column: ColumnAPI<T, TCondition>, field: string): boolean {
		if (field === `default.${column.id}`) return true;
		return field.split('.').includes(column.id);
	}

	private reconcileColumnsState() {
		const columnIds = new Set(this.columns.map((c) => c.id));

		{
			const next: Record<string, boolean> = {};
			for (const [id, value] of Object.entries(this.columnVisibility.current)) {
				if (columnIds.has(id) && typeof value === 'boolean') next[id] = value;
			}
			if (!this.shallowEqualObject(this.columnVisibility.current, next)) {
				this.columnVisibility.current = next;
			}
		}

		{
			const next: Record<string, number> = {};
			for (const [id, value] of Object.entries(this.columnSizing.current)) {
				if (columnIds.has(id) && typeof value === 'number') next[id] = value;
			}
			if (!this.shallowEqualObject(this.columnSizing.current, next)) {
				this.columnSizing.current = next;
			}
		}

		{
			const next: Record<string, boolean> = {};
			for (const [id, value] of Object.entries(this.pinnedColumns.current)) {
				if (id === COLLECTION_TABLE_SELECTION_COLUMN_ID) continue;
				if (columnIds.has(id) && value) next[id] = true;
			}
			if (!this.shallowEqualObject(this.pinnedColumns.current, next)) {
				this.pinnedColumns.current = next;
			}
		}

		{
			const seen = new Set<string>();
			const filtered = this.columnOrder.current.filter(
				(id) => id !== COLLECTION_TABLE_SELECTION_COLUMN_ID && columnIds.has(id)
			);
			for (const id of filtered) seen.add(id);
			for (const c of this.columns) {
				if (c.id === COLLECTION_TABLE_SELECTION_COLUMN_ID) continue;
				if (!seen.has(c.id)) filtered.push(c.id);
			}
			if (!this.shallowEqualStringArray(this.columnOrder.current, filtered)) {
				this.columnOrder.current = filtered;
			}
		}

		{
			const next = this.sort.current.filter((s) => {
				if (!s || typeof s.field !== 'string') return false;
				if (s.order !== 'asc' && s.order !== 'desc') return false;
				return this.columns.some(
					(c) => c.enableSorting !== false && this.sortEntryMatchesColumn(c, s.field)
				);
			});
			if (!this.equalSortArray(this.sort.current, next)) {
				this.sort.current = next;
			}
		}

		{
			const next: Record<string, string> = {};
			for (const [id, value] of Object.entries(this.columnDisplay.current)) {
				if (columnIds.has(id) && typeof value === 'string') next[id] = value;
			}
			const augmented: Record<string, string> = { ...next };
			for (const c of this.columns) {
				if (!(c.id in augmented) && typeof c.currentDisplay === 'string') {
					augmented[c.id] = c.currentDisplay;
				}
			}
			if (!this.shallowEqualObject(this.columnDisplay.current, augmented)) {
				this.columnDisplay.current = augmented;
			}
		}
	}

	private reconcileRowsState() {
		const rowIds = new Set(this.data.map((raw) => this.getRowId(raw)));

		{
			const next: Record<string, boolean> = {};
			for (const [id, selected] of Object.entries(this.rowSelection.current)) {
				if (rowIds.has(id) && selected) next[id] = true;
			}
			if (!this.shallowEqualObject(this.rowSelection.current, next)) {
				this.rowSelection.current = next;
			}
		}

		{
			const next: Record<string, boolean> = {};
			for (const [id, isExpanded] of Object.entries(this.expanded.current)) {
				if (rowIds.has(id) && isExpanded) next[id] = true;
			}
			if (!this.shallowEqualObject(this.expanded.current, next)) {
				this.expanded.current = next;
			}
		}
	}

	private get visibleColumns(): ColumnAPI<T, TCondition>[] {
		return this.columns.filter((c) => c.isVisible);
	}

	private getRowId(row: T): string {
		const key = this.rowKey as string;
		if (!key.includes('.')) {
			const value = row[key];
			return value !== undefined ? String(value) : '';
		}
		const value = getPath(row, key);
		return value !== undefined ? String(value) : '';
	}

	private createRowInstance(raw: T, index: number): RowAPI<T, TCondition> {
		return new RowAPI({ id: this.getRowId(raw), index, raw, table: this });
	}

	private notifySelectionChange(): void {
		if (!this.callbacks?.onSelectionChange) return;
		const selectedIds = Object.keys(this.rowSelection.current).filter(
			(id) => this.rowSelection.current[id]
		);
		this.callbacks.onSelectionChange(selectedIds);
	}

	private notifyExpandedChange(): void {
		if (!this.callbacks?.onExpandedChange) return;
		const expandedIds = Object.keys(this.expanded.current).filter(
			(id) => this.expanded.current[id]
		);
		this.callbacks.onExpandedChange(expandedIds);
	}

	toggleSort(columnId: string) {
		const key = `default.${columnId}`;
		const next = [...this.sort.current];
		const i = next.findIndex((s) => s.field === key);

		if (i === -1) {
			next.push({ field: key, order: 'asc' });
		} else if (next[i].order === 'asc') {
			next[i] = { field: key, order: 'desc' };
		} else {
			next.splice(i, 1);
		}
		this.sort.current = next;
		this.callbacks?.onSortChange?.(next);
	}

	toggleRowSelection(rowId: string) {
		const instance = this.rowInstances.find((row) => row.id === rowId);
		if (instance && this.rowLocked(instance.raw)) return;
		const current = this.rowSelection.current;
		if (current[rowId]) {
			this.rowSelection.current = omit(current, [rowId]);
		} else {
			this.rowSelection.current = { ...current, [rowId]: true };
		}
		this.notifySelectionChange();
	}

	toggleAllPageRowsSelected(select: boolean) {
		if (select) {
			const next = { ...this.rowSelection.current };
			for (const row of this.rowInstances) {
				if (this.rowLocked(row.raw)) continue;
				next[row.id] = true;
			}
			this.rowSelection.current = next;
		} else {
			this.rowSelection.current = {};
		}
		this.notifySelectionChange();
	}

	toggleRowExpanded(rowId: string) {
		const current = this.expanded.current;
		this.expanded.current = current[rowId] ? omit(current, [rowId]) : { ...current, [rowId]: true };
		this.notifyExpandedChange();
	}

	toggleColumnVisibility(columnId: string) {
		const current = this.columnVisibility.current[columnId];
		this.columnVisibility.current = {
			...this.columnVisibility.current,
			[columnId]: current === false
		};
		this.callbacks?.onColumnVisibilityChange?.({
			...this.columnVisibility.current
		});
	}

	toggleColumnPin(columnId: string) {
		if (columnId === COLLECTION_TABLE_SELECTION_COLUMN_ID) return;
		if (this.pinnedColumns.current[columnId]) {
			this.pinnedColumns.current = omit(this.pinnedColumns.current, [columnId]);
		} else {
			this.pinnedColumns.current = { ...this.pinnedColumns.current, [columnId]: true };
		}
		this.callbacks?.onPinnedColumnsChange?.({ ...this.pinnedColumns.current });
	}

	setColumnSize(columnId: string, size: number) {
		const column = this.columns.find((candidate) => candidate.id === columnId);
		const minimum = column?.minWidth ?? 40;
		const maximum = column?.maxWidth ?? Number.POSITIVE_INFINITY;
		this.columnSizing.current = {
			...this.columnSizing.current,
			[columnId]: Math.max(minimum, Math.min(maximum, size))
		};
		this.callbacks?.onColumnSizingChange?.({ ...this.columnSizing.current });
	}

	setContentFitWidths(widths: Record<string, number>, initialize: boolean) {
		this.contentFitWidths = widths;
		if (!initialize || Object.keys(this.columnSizing.current).length > 0) return;
		this.fitAllColumns();
	}

	fitColumn(columnId: string) {
		const width = this.contentFitWidths[columnId];
		if (width != null) this.setColumnSize(columnId, width);
	}

	fitAllColumns() {
		for (const column of this.columns) this.fitColumn(column.id);
	}

	setData(data: T[]) {
		this.data = data;
		if (!this.totalRows) this.totalRows = data.length;
		this.reconcileRowsState();
	}

	setTotalRows(totalRows: number) {
		this.totalRows = Math.max(0, totalRows);
	}

	setColumns(columns: ColumnAPI<T, TCondition>[]) {
		this.columns = columns;
		this.reconcileColumnsState();
	}

	setColumnDisplay(columnDisplay: Record<string, string>) {
		this.columnDisplay.current = columnDisplay;
	}

	setCondition(condition: TCondition) {
		const next = this.parseCondition(condition);
		this.condition.current = next;
		this.callbacks?.onConditionChange?.(next);
	}

	setSort(sort: TableSortEntry[]) {
		this.sort.current = sort;
		this.callbacks?.onSortChange?.(sort);
	}

	setColumnOrder(order: string[]) {
		this.columnOrder.current = order;
		this.callbacks?.onColumnOrderChange?.(order);
	}

	setRowSelection(selection: Record<string, boolean>) {
		this.rowSelection.current = selection;
		this.notifySelectionChange();
	}

	setExpanded(expanded: Record<string, boolean>) {
		this.expanded.current = expanded;
		this.notifyExpandedChange();
	}

	createColumnResizer(options: {
		tableHeaderElement: () => HTMLDivElement | null;
		containerElement: () => HTMLDivElement | null;
		onColumnResize: (props: { columnId: string; newSize: number }) => void;
		getIndexById: (id: string) => number;
	}) {
		const { containerElement, onColumnResize, getIndexById } = options;
		let activeColumnId = $state<string | null>(null);
		let initialMouseX = 0;
		let initialWidth = 0;

		watch(
			() => activeColumnId,
			(nextColumnId) => {
				document.body.style.cursor = nextColumnId ? 'col-resize' : '';
				document.body.style.userSelect = nextColumnId ? 'none' : '';
				if (!nextColumnId) return;
				const colId = nextColumnId;
				const move = (e: MouseEvent | TouchEvent) => {
					const idx = getIndexById(colId);
					if (idx < 0) return;
					const layout = this.columnLayouts[idx];
					const x = 'touches' in e ? e.touches[0].clientX : e.clientX;
					const deltaX = x - initialMouseX;
					const min = layout.instance.minWidth ?? 40;
					const max = layout.instance.maxWidth;
					let next = Math.max(initialWidth + deltaX, min);
					if (typeof max === 'number') next = Math.min(next, max);
					onColumnResize({ columnId: colId, newSize: next });
				};
				const end = () => {
					activeColumnId = null;
					// Resize handles are buttons; blur so header `group-focus-within`
					// styles (sort / column actions) do not stick after drag.
					if (document.activeElement instanceof HTMLElement) {
						document.activeElement.blur();
					}
				};
				window.addEventListener('mousemove', move);
				window.addEventListener('mouseup', end);
				window.addEventListener('touchmove', move);
				window.addEventListener('touchend', end);
				return () => {
					window.removeEventListener('mousemove', move);
					window.removeEventListener('mouseup', end);
					window.removeEventListener('touchmove', move);
					window.removeEventListener('touchend', end);
				};
			}
		);

		return {
			handle: (event: MouseEvent | TouchEvent, id: string) => {
				const container = containerElement();
				if (!container) return;
				event.stopPropagation();
				const x = 'touches' in event ? event.touches[0].clientX : event.clientX;
				const idx = getIndexById(id);
				if (idx < 0) return;
				const layout = this.columnLayouts[idx];
				initialMouseX = x;
				initialWidth = layout?.width ?? this.DEFAULT_WIDTH;
				activeColumnId = id;
			},
			get activeColumnId() {
				return activeColumnId;
			}
		};
	}
}

export function withSelectionColumn<TData extends Record<string, unknown>, TCondition = unknown>(
	cols: TCreateColumnProps<TData, TCondition>[],
	enabled: boolean,
	t?: Translate,
	isLocked?: (row: RowAPI<TData, TCondition>) => boolean
): TCreateColumnProps<TData, TCondition>[] {
	if (!enabled) return cols.slice();

	return uniqBy(
		[
			{
				id: COLLECTION_TABLE_SELECTION_COLUMN_ID,
				header: ({ table }) =>
					renderComponent(CollectionTableCheckbox, {
						controlledChecked: true,
						checked: table.isAllPageRowsSelected,
						indeterminate: table.isSomePageRowsSelected,
						onCheckedChange: (value: boolean) => table.toggleAllPageRowsSelected(Boolean(value)),
						'aria-label': t ? t('table.selectAllRows') : 'Select all rows'
					}),
				cell: ({ row }) =>
					renderComponent(CollectionTableCheckbox, {
						controlledChecked: true,
						checked: row.isSelected,
						disabled: isLocked?.(row) === true,
						onCheckedChange: () => row.toggleSelection(),
						'aria-label': t ? t('table.selectRow') : 'Select row'
					}),
				enableSorting: false,
				enablePinning: false,
				enableResizing: false,
				enableHiding: false,
				enableSelection: true,
				width: 48
			},
			...cols
		] as TCreateColumnProps<TData, TCondition>[],
		(item) => item.id
	);
}
