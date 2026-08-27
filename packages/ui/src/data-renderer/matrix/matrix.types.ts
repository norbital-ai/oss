import type {
	CollectionField,
	CollectionQuery,
	CollectionRecord,
	CollectionRelationOptions
} from '@norbital-ai/std/collection';
import type { Component, Snippet } from 'svelte';
import type { FieldRendererProps } from '../data-renderer.types.js';

export interface MatrixRow {
	readonly id?: string;
}

type MatrixRowKey<TRow extends MatrixRow> = Extract<keyof TRow, string>;

export type MatrixCellRendererProps<TRow extends MatrixRow = MatrixRow> = Omit<
	FieldRendererProps,
	'row' | 'disabled' | 'onValueChange' | 'onRowChange'
> & {
	row: TRow;
	disabled: boolean;
	onValueChange: (value: unknown) => void;
	onRowChange: (patch: Record<string, unknown>) => void;
};

export interface MatrixColumn<TRow extends MatrixRow> {
	key: MatrixRowKey<TRow>;
	label: string;
	field: CollectionField;
	placeholder?: string;
	relationOptions?: CollectionRelationOptions;
	/** Render this value as immutable display content inside an otherwise editable matrix. */
	readOnly?: boolean;
	/** Specialized cell content for references that cannot be represented by one scalar field. */
	renderer?: Component<MatrixCellRendererProps<TRow>>;
	width?: number;
}

export interface MatrixRowActionProps<TRow extends MatrixRow = MatrixRow> {
	row: TRow;
	index: number;
	hovered: boolean;
	/** Whole matrix is disabled (e.g. form readonly / saving). */
	disabled: boolean;
	/** This row’s datatype cells are non-editable via `isRowDisabled`. */
	rowDisabled: boolean;
}

export interface MatrixRendererBaseProps<TRow extends MatrixRow> {
	rows: TRow[];
	columns: readonly MatrixColumn<TRow>[];
	disabled?: boolean;
	emptyMessage?: string;
	class?: string;
	/** When false, grow with content and let a parent own scrolling (avoids nested scroll traps). */
	bounded?: boolean;
	getRowId?: (row: TRow, index: number) => string;
	/** When true, the row’s cells are non-editable (remove still follows `canRemoveRow`). */
	isRowDisabled?: (row: TRow, index: number) => boolean;
	addRowLabel?: string;
	allowRemoveRows?: boolean;
	/** Defaults to allowing remove whenever `allowRemoveRows` is true. */
	canRemoveRow?: (row: TRow, index: number) => boolean;
	/** Rendered before the built-in remove control in the sticky actions column. */
	extraRowActions?: Snippet<[MatrixRowActionProps<TRow>]>[];
	onChange?: (rows: TRow[]) => void;
}

export type MatrixRendererAddRowsProps<TRow extends MatrixRow> =
	| {
			allowAddRows?: true;
			createRow: () => TRow;
			addRowDisabled?: boolean;
	  }
	| {
			allowAddRows: false;
			createRow?: never;
			addRowDisabled?: never;
	  };

export type MatrixRendererProps<TRow extends MatrixRow> = MatrixRendererBaseProps<TRow> &
	MatrixRendererAddRowsProps<TRow>;
