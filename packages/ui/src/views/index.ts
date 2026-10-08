// The views of §3.6 over `$bolt`. The shell provides `bolt` (and the representation registry) once per page.
// A collection-backed view is exported typed by what its naked prop names (`Workspace` in `./bolt.ts`): the component
// is Svelte's generic-component shape over its own name-erased implementation.
import type { ComponentConstructorOptions, SvelteComponent } from 'svelte';
import BoardView from './Board.svelte';
import MapView from './Map.svelte';
import PivotView from './Pivot.svelte';
import RecordShellView from './RecordShell.svelte';
import TableView from './Table.svelte';
import type { BoardProps } from './Board.svelte';
import type { MapProps } from './Map.svelte';
import type { PivotProps } from './Pivot.svelte';
import type { RecordShellProps } from './RecordShell.svelte';
import type { ColumnsIn, RowIn, TableProps, TableSource } from './Table.svelte';
import type { CollectionKey } from './bolt.js';

/** Only `of` infers the source: the other props are checked against it, never read back into it. */
type TableOf<S> = { of: S } & NoInfer<Omit<TableProps<S, RowIn<S>, ColumnsIn<S>>, 'of'>>;
/**
 * A paged, sortable table of a collection (`of="<c>"`), a collection query, a read or rows: typed columns, a toolbar with
 * search, filter and sort, row actions, and a click that opens the record.
 * @example
 * <Table of="jobs" columns={['title', 'status', 'due_on']} orderBy={{ due_on: 'asc' }} />
 */
export const Table = TableView as unknown as {
	new <const S extends TableSource>(options: ComponentConstructorOptions<TableOf<S>>): SvelteComponent<TableOf<S>>;
	<const S extends TableSource>(internal: unknown, props: TableOf<S>): {};
};
/**
 * A kanban board of a collection: one lane per value of a `state`, `enum` or relation field (`by`), cards of up to four
 * fields or a snippet; dragging a card between lanes writes the new value.
 * @example
 * <Board of="jobs" by="status" card={['title', 'assignee']} />
 */
export const Board = BoardView as unknown as {
	new <const C extends CollectionKey>(options: ComponentConstructorOptions<BoardProps<C>>): SvelteComponent<BoardProps<C>>;
	<const C extends CollectionKey>(internal: unknown, props: BoardProps<C>): {};
};
/**
 * Rows of a collection with a `point` field `at` as markers on the host's keyless basemap; a click opens the record.
 */
export const Map = MapView as unknown as {
	new <const C extends CollectionKey>(options: ComponentConstructorOptions<MapProps<C>>): SvelteComponent<MapProps<C>>;
	<const C extends CollectionKey>(internal: unknown, props: MapProps<C>): {};
};
/** A pivot table of a collection's aggregate: `rows` by `cols`, each cell a count or a sum of `value`. */
export const Pivot = PivotView as unknown as {
	new <const C extends CollectionKey>(options: ComponentConstructorOptions<PivotProps<C>>): SvelteComponent<PivotProps<C>>;
	<const C extends CollectionKey>(internal: unknown, props: PivotProps<C>): {};
};
/**
 * One record's view (or a create view): a header with title, state pill and actions, the generated form or the collection's representation, and authored tabs.
 */
export const RecordShell = RecordShellView as unknown as {
	new <const C extends CollectionKey>(options: ComponentConstructorOptions<RecordShellProps<C>>): SvelteComponent<RecordShellProps<C>>;
	<const C extends CollectionKey>(internal: unknown, props: RecordShellProps<C>): {};
};
export type { BoardProps, Lane } from './Board.svelte';
export { default as CameraCapture, type CameraCaptureProps } from './CameraCapture.svelte';
export { default as Chart, type ChartProps } from './Chart.svelte';
export { default as CustomView, type CustomField, type CustomViewProps } from './CustomView.svelte';
export type { MapOverlay, MapProps } from './Map.svelte';
export { default as Matrix, type MatrixCell, type MatrixMark, type MatrixProps } from './Matrix.svelte';
export type { PivotProps } from './Pivot.svelte';
export type { RecordShellProps, RecordTab } from './RecordShell.svelte';
export type { InsertOf, RecordOf, RowOf } from './bolt.js';
export { default as ReviewBanner, type ReviewBannerProps } from './ReviewBanner.svelte';
export { default as Rows, type RowsProps } from './Rows.svelte';
export { default as RunsFor, type RunsForProps } from './RunsFor.svelte';
export { default as RunStatus, type RunStatusProps } from './RunStatus.svelte';
export type { Col, ColumnsIn, RowAction, RowIn, TableProps, TableSource } from './Table.svelte';
export type { Toolbar, ToolbarItem } from './ViewToolbar.svelte';
export { carriedContexts, onPageContexts, openRecord, pageContexts, provideBolt, provideCollection, useEnumText, useRecordView, provideRepresentations, type RecordView, type RepresentationLoader, type ViewBolt, type Workspace } from './bolt.js';
export { default as LogView, type LogViewProps } from './LogView.svelte';
export { default as EmptyState } from './EmptyState.svelte';
/** A collection's or field's label and a record's singular noun, from the catalog (`models.<c>.label|singular|fields.<f>`). */
export { label, singular } from './model.js';
export { LOG_LEVELS, filterLogs, type LogLevel, type LogLine } from './logs.js';
