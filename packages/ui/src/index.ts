// `@norbital-ai/ui` (Appendix D.2): the views, the field kinds and inputs, `Form`/`Field`, and the primitives.
// Layout is `./layout`.
// The views take the page's `ctx` as a prop; the shell provides the representation registry once per page.
// A model-backed view is exported typed by what its naked prop names (`Workspace` in `./model/types.ts`): the component
// is Svelte's generic-component shape over its own name-erased implementation.
/** Live model rows grouped into state, enum or relation lanes; dragging a card updates its lane field under the viewer's grants. */
export { default as Board } from './board/Board.svelte';
/** Live model points on our vector basemap, with clusters, a detail card, an optional side list, overlays and record opening; search and filters retain the viewer's read scope. */
export { default as Map } from './map/Map.svelte';
/** A record frame with its label, permissions, approvals, revision history and authored tabs; renders the registered representation or generated form. */
export { default as RecordShell } from './record/RecordShell.svelte';
/** A typed table over model rows, a query or local values, with kind-aware cells, paging, filters, sorting and permitted row actions. */
export { default as Table } from './table/Table.svelte';
export { default as ChildGrid } from './relations/ChildGrid.svelte';
export { default as Chart } from './chart/Chart.svelte';
/** A workspace metric's measured trend, with shared units and optional capacity lines. */
export { default as UsageChart, format_metric_value } from './chart/UsageChart.svelte';
export { default as CustomView } from './model/CustomView.svelte';
export type { RecordTab, RecordHistoryConfig } from './record/RecordShell.svelte';
export type { ApprovalView } from './client/contract.js';
export type { AutomationInputOf, AutomationKey, InsertOf, RecordOf, RowOf } from './model/types.js';
export type { SourceColumns, SourceRow, ViewSource } from './model/types.js';
/** An approval request: its timeline of steps and the decisions the host allows the viewer. */
export { default as ApprovalPanel } from './approval/ApprovalPanel.svelte';
export { default as RunStatus } from './runs/RunStatus.svelte';
export type { Col, ColumnsIn, RowIn, TableProps } from './table/Table.svelte';
// The parts the built-in views are assembled from, for a page composing its own.
/** A paged view's page size, previous and next, and "Page X of Y". */
export { default as TablePager } from './table/TablePager.svelte';
/** A row's actions: one as its button, two or more folded into one menu. */
export { default as RowMenu } from './table/RowMenu.svelte';
/** A view's selection line: the page's checkbox, the count, select every matching row, clear. */
export { default as SelectionBar } from './table/SelectionBar.svelte';
/** A column heading's menu: pin, hide, move, reset width, show a hidden column. */
export { default as ColumnMenu } from './table/ColumnMenu.svelte';
/** A row as a phone card: its title and three fields, the whole card opening the record. */
export { default as RowCard } from './table/RowCard.svelte';
/** A value as a view's cell shows it, by its kind. */
export { default as CellValue } from './cell/Value.svelte';
/** A dense value on one line; wider than its cell, an expand button shows it whole (`expand="never"` in a row). */
export { default as CellOverflow } from './cell/Overflow.svelte';
/** A view's loading, no-access and error states around its ready content. */
export { default as ReadGate } from './read/ReadGate.svelte';
/** One read's pending and ready states. */
export { default as ReadOnce } from './read/ReadOnce.svelte';
/** The accent a row or card carries while an open approval request holds its record. */
export { default as ApprovalAccent } from './approval/ApprovalAccent.svelte';
/** A field's label, help, required and dirty marks and error around its control. */
export { default as FieldControl } from './form/field-control.svelte';
/** The latest runs of one automation matching `where`, each with its `RunStatus`. */
export { default as RunsFor, type RunsForProps } from './runs/RunsFor.svelte';
/** One board lane's cards: live keyset pages, the next loading as the lane scrolls near its end. */
export { default as BoardLane } from './board/BoardLane.svelte';
export type { BoardProps, Lane } from './board/Board.svelte';
/** An editable list of child rows inside a parent's form, sent as the parent's relation operations. */
export { default as Rows } from './relations/Rows.svelte';
/** A compact vertical timeline of actions. */
export { default as Timeline } from './timeline/Timeline.svelte';
export type { TimelineEntry } from './timeline/timeline.js';
export type { Toolbar, ToolbarItem } from './model/ViewToolbar.svelte';
export { default as ToolbarSearch } from './model/toolbar/ToolbarSearch.svelte';
/** The toolbar's condition, description and sort controls for a saved model filter. */
export { default as FilterEditor, type FilterValue } from './filter/FilterEditor.svelte';
export type { FilterVariables } from './filter/operators.js';
export { carried_contexts, on_page_contexts, open_record, page_contexts } from './record/navigation.js';
export { use_enum_text } from './model/context.js';
export { provide_representations } from './record/context.js';
export {
	type RecordCapabilities,
	type RecordRestriction,
	type RecordParentContext,
	type RecordView,
	type RepresentationLoader,
	type RestorePreview,
	type RestoreSkip
} from './record/types.js';
export { automation_outcome } from './actions/outcome.js';
/** A page's write in one call: a `pending` flag while it runs, and its commit, hold or typed failure toasted. */
export { use_act } from './actions/act.svelte.js';
export { type UiContext, type ViewBolt } from './client/contract.js';
export { type Workspace } from './model/types.js';
export { default as EmptyState } from './primitives/empty-state/EmptyState.svelte';
export { default as TableSkeleton } from './read/TableSkeleton.svelte';
/** A model's or field's label and a record's singular noun, from the catalog (`models.<c>.label|singular|fields.<f>`). */
export { label, singular } from './text/messages.js';

/** Uses the shared localized feedback for a custom action's typed outcome. */
export { notify as notify_outcome } from './actions/outcome.js';
export { begin_workspace_navigation } from './utilities/workspace-navigation.js';
export { files_summary, joined_summary, notes_summary } from './utilities/summary.js';
export {
	TimeInput,
	Editor,
	FileInput,
	MoneyInput,
	PhoneInput,
	format_handle,
	Picker,
	PointInput,
	Show,
	type ShowProps,
	StateBadge,
	StructuredData,
	TimeRangeInput,
	type ModelExposure,
	type AutomationExposure,
	type CustomFieldEntry,
	type KindsHost,
	enum_text,
	format,
	format_value,
	value_object,
	type Fields,
	type Value,
	type Kind,
	type Point,
	is_json_schema,
	json_schema_kind,
	type JsonSchema
} from './kinds/index.js';
export {
	Field,
	type FieldEditor,
	type FieldView,
	DescriptionHint,
	Section,
	type RecordSection,
	Form,
	type FormProps,
	FormState,
	use_form,
	use_record_controller,
	type Row
} from './form/index.js';
export {
	/** Collapsible sections: `Accordion.Root` holds `Accordion.Item`s, each a `Trigger` and its `Content`. */
	Accordion,
	/** A modal dialog: `Dialog.Root`, its `Trigger`, and `Content` with a header, title, description and footer. */
	Dialog,
	/** Where the portals beneath it land: a mount with its own stylesheet keeps its floating content under it. */
	BitsConfig,
	confirm_action,
	/** Floating content anchored to a trigger: `Popover.Root`, `Popover.Trigger`, `Popover.Content`. */
	Popover,
	Drawer,
	Sheet,
	Badge,
	type BadgeVariant,
	Button,
	type ButtonProps,
	Checkbox,
	Combobox,
	type ComboboxOption,
	Icon,
	Image,
	Input,
	Label,
	Progress,
	Qr,
	Spinner,
	TAB_LEVEL,
	Tabs,
	TabStrip,
	Textarea,
	Tooltip,
	virtual_list,
	cn,
	format_file_size,
	set_ui_text,
	ui_text_for,
	ui_text,
	type UiTextKey
} from './primitives/index.js';
export {
	CodeEditor,
	type CommandItem,
	MarkdownEditor,
	ReadonlyMarkdown,
	highlighted_line,
	code_highlight,
	code_language,
	code_theme
} from './editors/index.js';
export { default as EventCalendar } from './event-calendar/event-calendar.svelte';
export type { CalendarEvent, CalendarView } from './event-calendar/calendar.js';
export { default as Toaster } from './toast/toaster.svelte';
export { toast } from './toast/toast.svelte.js';
export { PinInput, PhoneVerify } from './pin-input/index.js';

/** Studio's place in a page, and the preview and test report the shell's agent pane and Studio share. */
export { default as StudioSlot } from './studio/StudioSlot.svelte';
export type { StudioMount, StudioProps } from './studio/slot.js';
export { default as PreviewFrame } from './studio/PreviewFrame.svelte';
export { default as TestResults } from './studio/TestResults.svelte';
export { elapsed_text } from './studio/elapsed.js';
/** The same tenant operational surface in Workspace Studio and Realm. */
export { default as WorkspaceOperations } from './workspaces/WorkspaceOperations.svelte';
export { release_window } from './workspaces/filters.js';
export type {
	WorkspaceOperationsData,
	WorkspaceScope,
	WorkspaceRange,
	WorkspaceView
} from './workspaces/types.js';
