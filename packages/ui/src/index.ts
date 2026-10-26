// `@norbital-ai/ui` (§3.6, Appendix D.2): the views, the field kinds and inputs, `Form`/`Field`, and the primitives.
// Layout is `./layout`; `CaptureKit` is `./capture`, so its face engine loads only in pages that import it.
// The views of §3.6 over `$bolt`. The shell provides `bolt` (and the representation registry) once per page.
// A collection-backed view is exported typed by what its naked prop names (`Workspace` in `./collection/types.ts`): the component
// is Svelte's generic-component shape over its own name-erased implementation.
/** Live collection rows grouped into state, enum or relation lanes; dragging a card updates its lane field under the viewer's grants. */
export { default as Board } from './board/Board.svelte';
/** Live collection points on the host's basemap, with labels, overlays and record opening; search and filters retain the viewer's read scope. */
export { default as Map } from './map/Map.svelte';
/** A live count or sum grouped by row and optional column fields, displayed as a pivot grid with totals and scoped filters. */
export { default as Pivot } from './pivot/Pivot.svelte';
/** A record frame with its label, permissions, approvals, revision history and authored tabs; renders the registered representation or generated form. */
export { default as RecordShell } from './record/RecordShell.svelte';
/** A typed table over collection rows, a query or local values, with kind-aware cells, paging, filters, sorting and permitted row actions. */
export { default as Table } from './table/Table.svelte';
export { default as ChildGrid } from './relations/ChildGrid.svelte';
export type { ChildGridProps } from './relations/ChildGrid.svelte';
export type { BoardProps, Lane } from './board/Board.svelte';
export { default as CameraCapture, type CameraCaptureProps } from './capture/CameraCapture.svelte';
export { default as Chart, type ChartProps } from './chart/Chart.svelte';
/** A workspace metric's measured trend, with shared units and optional capacity lines. */
export {
	default as UsageChart,
	formatMetricValue,
	type UsageChartLine,
	type UsageChartProps
} from './chart/UsageChart.svelte';
export {
	default as CustomView,
	type CustomField,
	type CustomViewProps
} from './collection/CustomView.svelte';
export type { MapOverlay, MapProps } from './map/Map.svelte';
export {
	default as Matrix,
	type MatrixCell,
	type MatrixMark,
	type MatrixProps
} from './matrix/Matrix.svelte';
export type { PivotProps } from './pivot/Pivot.svelte';
export type {
	RecordShellProps,
	RecordTab,
	RecordHistoryConfig,
	RecordHistorySource
} from './record/RecordShell.svelte';
export type { ApprovalView } from './client/contract.js';
export type {
	AutomationInputOf,
	AutomationKey,
	InsertOf,
	RecordOf,
	RowOf
} from './collection/types.js';
/** An approval request: its timeline of steps and the decisions the host allows the viewer. */
export { default as ApprovalPanel } from './approval/ApprovalPanel.svelte';
export { default as Rows, type RowsProps } from './relations/Rows.svelte';
export { default as RunsFor, type RunsForProps } from './runs/RunsFor.svelte';
export { default as RunStatus, type RunStatusProps } from './runs/RunStatus.svelte';
export type {
	Col,
	ColumnsIn,
	RowAction,
	RowIn,
	TableProps,
	TableSource
} from './table/Table.svelte';
export type { Toolbar, ToolbarItem } from './collection/ViewToolbar.svelte';
export {
	default as ToolbarSearch,
	type ToolbarSearchProps
} from './collection/toolbar/ToolbarSearch.svelte';
export {
	default as ToolbarFilter,
	type ToolbarFilterProps
} from './collection/toolbar/ToolbarFilter.svelte';
export { carriedContexts, onPageContexts, openRecord, pageContexts } from './record/navigation.js';
export { provideBolt, useBolt } from './client/context.js';
export { provideCollection, useEnumText } from './collection/context.js';
export { useRecordView, provideRepresentations } from './record/context.js';
export {
	type RecordCapabilities,
	type RecordRestriction,
	type RecordParentContext,
	type RecordView,
	type RepresentationLoader,
	type RestorePreview,
	type RestoreSkip
} from './record/types.js';
export { type ViewBolt } from './client/contract.js';
export { type Workspace } from './collection/types.js';
export { default as LogView, type LogViewProps } from './logs/LogView.svelte';
export { default as EmptyState } from './primitives/empty-state/EmptyState.svelte';
/** A collection's or field's label and a record's singular noun, from the catalog (`models.<c>.label|singular|fields.<f>`). */
export { label, singular } from './text/messages.js';
export { LOG_LEVELS, filterLogs, type LogLevel, type LogLine } from './logs/logs.js';

/** Uses the shared localized feedback for a custom action's typed outcome. */
export { notify as notifyOutcome } from './actions/outcome.js';
export { downloadTextFiles } from './utilities/download.js';
export { beginWorkspaceNavigation, workspaceNavigation } from './utilities/workspace-navigation.js';
export { filesSummary, joinedSummary, notesSummary } from './utilities/summary.js';
export * from './kinds/index.js';
export * from './form/index.js';
export * from './primitives/index.js';
export * from './editors/index.js';
export {
	default as EventCalendar,
	type EventCalendarProps
} from './event-calendar/event-calendar.svelte';
export type {
	CalendarEvent,
	CalendarView,
	CreateSlot,
	EventRenderContext
} from './event-calendar/calendar.js';
export { default as Toaster } from './toast/toaster.svelte';
export { toast, type ToastItem, type ToastOptions, type ToastTone } from './toast/toast.svelte.js';
export * from './pin-input/index.js';

/** One commit's build, preview and publication history, shared with Workspace Studio. */
export {
	default as ReleaseTimeline,
	type ReleaseTimelineProps
} from './releases/ReleaseTimeline.svelte';
export {
	rollbackReason,
	timelineEntries,
	type ReleaseBuild,
	type ReleaseVersion,
	type ReleaseChange,
	type ReleaseEnvironment,
	type ReleaseEntry
} from './releases/model.js';

/** The same tenant operational surface in Workspace Studio and Realm. */
export {
	default as WorkspaceOperations,
	type WorkspaceOperationsProps
} from './workspaces/WorkspaceOperations.svelte';
export type {
	WorkspaceOperationsData,
	WorkspaceOperation,
	WorkspaceScope,
	WorkspaceRange,
	WorkspaceView
} from './workspaces/types.js';
