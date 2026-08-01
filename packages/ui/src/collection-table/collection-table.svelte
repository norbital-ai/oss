<script
	lang="ts"
	generics="TCollections extends CollectionRegistry = CollectionRegistry, TName extends CollectionName<TCollections> = CollectionName<TCollections>, TRow extends object = CollectionTableRow<TCollections, TName>"
>
	import type {
		CollectionApprovalRequest,
		CollectionDefinition,
		CollectionField,
		CollectionFilter,
		CollectionFieldName,
		CollectionOperations,
		CollectionPageQuery,
		CollectionQuery,
		CollectionRegistry,
		CollectionType,
		CollectionRecord,
		CollectionUpdateInput,
		RemoteQuery
	} from '@norbital-ai/platform-utils/collection';
	import { resolveRecordLabel } from '@norbital-ai/platform-utils/manifest/context';
	import { humanize } from '@norbital-ai/std/string';
	import Icon from '@iconify/svelte';
	import { onMount } from 'svelte';
	import { Button } from '#lib/button';
	import * as Dialog from '#lib/dialog';
	import { Textarea } from '#lib/textarea';
	import * as Popover from '#lib/popover';
	import * as Sheet from '#lib/sheet';
	import { Tooltip } from '#lib/tooltip';
	import { cn, renderSnippet, RenderComponentConfig, RenderSnippetConfig } from '#lib/utils';
	import { DataRenderer } from '../data-renderer/index.js';
	import { formatDataValue } from '../data-renderer/index.js';
	import { Cluster, Grid, Inline, Stack, Bound } from '#lib/layout';
	import { CollectionForm } from '../collection-form/index.js';
	import {
		collectionRecordId,
		createActionLabel,
		deriveAutoCard,
		formatAutoCardBadge,
		formatAutoCardField,
		formatAutoCardSubtitle,
		isSystemField,
		type AutoCardModel
	} from './collection-card-derivation.js';
	import { toast } from 'svelte-sonner';
	import { watch } from 'runed';
	import CollectionTablePart, {
		setCollectionTablePartContext
	} from './collection-table-part.svelte';
	import CollectionGrid from './internal/collection-grid.svelte';
	import CollectionTableDetailRegistration from './internal/collection-table-detail-registration.svelte';
	import CollectionQueryControls from './collection-query-controls.svelte';
	import CollectionTableOperations from './collection-table-operations.svelte';
	import CollectionTableList from './collection-table-list.svelte';
	import CollectionRecordDetailTabs from './collection-record-detail-tabs.svelte';
	import CollectionRecordDetailEmpty from './collection-record-detail-empty.svelte';
	import {
		createCollectionTableRouteKey,
		getCollectionTableNavigationContext,
		type CollectionTableDetailRenderContext
	} from './collection-table-navigation.svelte.js';
	import {
		ColumnAPI,
		RowAPI,
		TableAPI,
		withSelectionColumn,
		type TCreateColumnProps
	} from './internal/collection-table-state.svelte.js';
	import type {
		CollectionName,
		CollectionTableColumn,
		CollectionTableProps,
		CollectionTableRow,
		CollectionTableRowActionContext
	} from './collection-table.types.js';
	import { collectionTableColumnCanSort } from './collection-table.types.js';
	import { fitCollectionColumnWidth } from './collection-table-fit.js';
	import { badgeColorClass } from './collection-card-colors.js';
	import { getCollectionSurfaceRuntime, resolveCollectionSurface } from '#lib/collection-runtime';
	import {
		getCollectionClientForSurface,
		setCollectionClientContext
	} from '#lib/collection-runtime';

	type Row = TRow;
	type ColumnConfig = CollectionTableColumn<Row>;

	interface GridRow extends Record<string, unknown> {
		__collectionTableRowId: string;
		record: Row;
	}

	interface CollectionTableQueries {
		rows: CollectionPageQuery<Row> | null;
		count: RemoteQuery<number> | null;
		record: CollectionPageQuery<Row> | null;
		approval: RemoteQuery<readonly CollectionApprovalRequest[]> | null;
		cursors: Array<string | undefined>;
	}

	type ApprovalActionState =
		| { status: 'idle' }
		| { status: 'pending' }
		| { status: 'requesting_changes'; reason: string; pending: boolean };

	let {
		client,
		collection,
		view,
		query,
		disabled = false,
		selectable = false,
		class: className,
		rowActions,
		emptyPlaceholder,
		title,
		description,
		searchPlaceholder,
		features = {},
		exportPipelines = [],
		importPipelines = [],
		integrations = [],
		columns,
		ListCard
	}: CollectionTableProps<TCollections, TName, TRow> = $props();
	// svelte-ignore state_referenced_locally -- a mounted collection surface keeps one generated client.
	const workspaceClient = getCollectionClientForSurface(client, 'CollectionTable');
	setCollectionClientContext(() => workspaceClient);
	const surfaceRuntime = getCollectionSurfaceRuntime();
	const collectionSurface = $derived(
		resolveCollectionSurface(surfaceRuntime?.surfaces, String(collection))
	);

	const definition = $derived(
		workspaceClient.collections[String(collection)] as CollectionDefinition<
			CollectionType<Row, object, object>
		> // stupidity: boundary-cast — the generated client and runtime manifest share collection keys.
	);
	const operations = $derived(
		client.db[collection] as CollectionOperations<CollectionType<Row, object, object>> // stupidity: boundary-cast — Svelte's generic component boundary erases the inferred collection row.
	);
	const recordIdField = 'norbital_id';
	const resolvedView = $derived(
		view ?? `${surfaceRuntime?.appId() ?? 'unhosted'}:${String(collection)}`
	);
	const resolvedDetailRouteKey = $derived(
		createCollectionTableRouteKey({
			view: resolvedView
		})
	);
	onMount(() => surfaceRuntime?.claimView(resolvedView));
	const detailNavigation = getCollectionTableNavigationContext();
	const searchEnabled = $derived(features.search !== false);
	const filterEnabled = $derived(features.filter !== false);
	const bulkEnabled = $derived(features.bulk !== false);
	const effectiveSelectable = $derived(
		selectable ||
			exportPipelines.some((pipeline) => pipeline.requiresSelection) ||
			importPipelines.some((pipeline) => pipeline.requiresSelection) ||
			(bulkEnabled && (operations?.updateMany != null || operations?.delete != null))
	);
	let interactiveFilters: readonly CollectionFilter[] = $state([]);
	let registeredColumns: readonly ColumnConfig[] = $state([]);
	let initialFitApplied = $state(false);
	let queries = $state<CollectionTableQueries>({
		rows: null,
		count: null,
		record: null,
		approval: null,
		cursors: [undefined]
	});
	const configuredColumns = new Map<object, ColumnConfig>();

	const activeColumns = $derived(registeredColumns);

	// svelte-ignore state_referenced_locally
	const tableApi = new TableAPI<GridRow, unknown>({
		rowKey: '__collectionTableRowId',
		// svelte-ignore state_referenced_locally
		persistenceKey: resolvedView,
		// svelte-ignore state_referenced_locally
		viewKey: resolvedView,
		// svelte-ignore state_referenced_locally
		conditionDefault: undefined,
		parseCondition: (condition) => condition,
		initialState: {
			// svelte-ignore state_referenced_locally
			pageSize: query?.limit ?? 25
		}
	});
	function syncColumns(): void {
		registeredColumns = [...configuredColumns.values()];
	}

	setCollectionTablePartContext({
		setColumn: (token, column) => {
			configuredColumns.set(token, column as ColumnConfig); // stupidity: boundary-cast — Svelte context erases the parent table generics.
			syncColumns();
		},
		removeColumn: (token) => {
			configuredColumns.delete(token);
			syncColumns();
		}
	});

	const metadataError = $derived(
		activeColumns.length === 0 ? `No field metadata is available for ${String(collection)}.` : ''
	);

	function metadataFor(column: ColumnConfig): CollectionField<Extract<keyof Row, string>> {
		return (
			definition.fields.find((field) => field.name === column.key) ?? {
				name: column.key,
				kind: 'unknown',
				nullable: true
			}
		);
	}

	function normalizeCellRender(output: unknown) {
		if (output instanceof RenderComponentConfig || output instanceof RenderSnippetConfig) {
			return output;
		}
		if (output == null) return '';
		return String(output);
	}

	function renderCell(column: ColumnConfig, row: Row) {
		const value = Reflect.get(row, column.key);
		if (column.render) {
			return normalizeCellRender(column.render({ row, field: metadataFor(column), value }));
		}
		return renderSnippet(defaultCell, { column, row, value });
	}

	const gridColumns = $derived.by((): TCreateColumnProps<GridRow, unknown>[] =>
		withSelectionColumn(
			activeColumns.map((column) => {
				const field = metadataFor(column);
				return {
					id: column.key,
					header: () => column.label ?? field.label ?? humanize(column.key),
					accessor: (row: RowAPI<GridRow, unknown>) => Reflect.get(row.raw.record, column.key),
					cell: ({ row }: { row: RowAPI<GridRow, unknown> }) => renderCell(column, row.raw.record),
					width: column.width,
					minWidth: column.minWidth,
					maxWidth: column.maxWidth,
					enableSorting: collectionTableColumnCanSort(field, {
						sortable: column.sortable
					}),
					enableResizing: column.resizable ?? true,
					enableHiding: column.hideable ?? true,
					enablePinning: column.pinnable ?? true,
					enableSelection: effectiveSelectable
				};
			}),
			effectiveSelectable
		)
	);

	watch(
		() => gridColumns,
		(nextColumns) => {
			tableApi.setColumns(
				nextColumns.map((column) => new ColumnAPI({ ...column, table: tableApi }))
			);
		},
		{ lazy: false }
	);

	const orderBy = $derived.by((): CollectionQuery<Row>['orderBy'] => {
		if (tableApi.sort.current.length === 0) return undefined;
		return tableApi.sort.current.reduce<NonNullable<CollectionQuery<Row>['orderBy']>>(
			(result, entry) => {
				const fieldName = entry.field.startsWith('default.')
					? entry.field.slice('default.'.length)
					: entry.field;
				const column = activeColumns.find((candidate) => candidate.key === fieldName);
				return column ? { ...result, [column.key]: entry.order } : result;
			},
			{}
		);
	});
	const defaultOrderBy = $derived(query?.orderBy);
	const prefilterDescriptions = $derived(describeFilters(query?.where));
	const showAbout = $derived(Boolean(description || query?.where));

	// Auto card-role hints from column annotations, filled by field structure where unset (RFC V.2d).
	const cardRoles = $derived({
		title: activeColumns.find((column) => column.card === 'title')?.key as string | undefined,
		subtitle: activeColumns
			.filter((column) => column.card === 'subtitle')
			.map((column) => String(column.key)),
		badge: activeColumns.find((column) => column.card === 'badge')?.key as string | undefined
	});
	const autoCard: AutoCardModel = $derived(
		deriveAutoCard(
			definition.fields,
			activeColumns.map((column) => String(column.key)),
			{ roles: cardRoles, hasRecordLabel: Boolean(definition.recordLabel) }
		)
	);

	const createEnabled = $derived(features.create !== false && operations?.create != null);
	const operationsEnabled = $derived(
		exportPipelines.length > 0 ||
			importPipelines.length > 0 ||
			integrations.length > 0 ||
			(bulkEnabled && (operations?.updateMany != null || operations?.delete != null))
	);
	const createLabel = $derived(createActionLabel(String(collection)));

	function autoCardTitle(record: Row): string {
		if (autoCard.title.kind === 'field') {
			const text = formatAutoCardField(definition.fields, autoCard.title.name, record);
			if (text && text !== '—') return text;
		}
		return recordTitle(record);
	}

	const rowsQueryInput = $derived.by(() => {
		if (disabled) return null;
		return {
			operations,
			query: {
				...query,
				search: tableApi.search.current || undefined,
				orderBy: orderBy ?? defaultOrderBy,
				limit: tableApi.pagination.current.pageSize,
				after: queries.cursors[tableApi.pagination.current.pageIndex]
			},
			filters: interactiveFilters
		};
	});
	watch(
		() => rowsQueryInput,
		(input) => {
			if (!input) {
				queries.rows = null;
				return;
			}
			queries.rows = input.operations.findMany(input.query, { filters: input.filters });
		},
		{ lazy: false }
	);
	const pageRows = $derived(queries.rows?.current);

	const countQueryInput = $derived.by(() => {
		if (disabled) return null;
		return {
			operations,
			query: {
				where: query?.where,
				search: tableApi.search.current || undefined,
				columns: query?.columns,
				bypass_secret: query?.bypass_secret
			},
			filters: interactiveFilters
		};
	});
	watch(
		() => countQueryInput,
		(input) => {
			if (!input) {
				queries.count = null;
				return;
			}
			queries.count = input.operations.count(input.query, { filters: input.filters });
		},
		{ lazy: false }
	);

	function recordId(row: Row): string {
		const value = Reflect.get(row, recordIdField);
		if (typeof value !== 'string' || value.length === 0) {
			throw new Error('CollectionTable records require a norbital_id.');
		}
		return value;
	}

	watch(
		() => pageRows,
		(nextRows) => {
			tableApi.setData(
				(nextRows ?? []).map((record) => ({
					__collectionTableRowId: recordId(record),
					record
				}))
			);
		},
		{ lazy: false }
	);

	watch(
		() => ({ rows: pageRows, columns: activeColumns }),
		({ rows, columns }) => {
			if (initialFitApplied || !rows || columns.length === 0) return;
			const canvas = typeof document === 'undefined' ? null : document.createElement('canvas');
			const context = canvas?.getContext('2d');
			if (context) context.font = '13px "Geist Variable", ui-sans-serif, system-ui, sans-serif';
			const widths = Object.fromEntries(
				columns.map((column) => {
					const field = metadataFor(column);
					const header = column.label ?? field.label ?? humanize(column.key);
					const values = rows.map((row) => {
						const value = Reflect.get(row, column.key);
						const rendered = column.render?.({ row, field, value });
						return typeof rendered === 'string' || typeof rendered === 'number'
							? String(rendered)
							: formatDataValue(field, value);
					});
					return [
						String(column.key),
						column.width ??
							fitCollectionColumnWidth(
								field,
								values,
								header,
								context ? (text) => context.measureText(text).width : undefined
							)
					];
				})
			);
			tableApi.setContentFitWidths(widths, true);
			initialFitApplied = true;
		},
		{ lazy: false }
	);

	watch(
		() => queries.count?.current,
		(total) => tableApi.setTotalRows(total ?? 0),
		{ lazy: false }
	);

	const gridRowActions = $derived([
		openRecordAction,
		...(rowActions?.length ? [gridRowAction] : [])
	]);
	const errorMessage = $derived(
		queries.rows?.error?.message ?? queries.count?.error?.message ?? metadataError
	);
	const activeRecordId = $derived(
		detailNavigation?.resolveRecordId({
			collectionName: String(collection),
			routeKey: resolvedDetailRouteKey
		})
	);
	const activeRecordQueryInput = $derived.by(() => {
		if (!activeRecordId || disabled) return null;
		return {
			operations,
			query: {
				where: { [recordIdField]: { eq: activeRecordId } } as CollectionQuery<Row>['where'], // stupidity: boundary-cast — the configured row key is constrained by CollectionTableProps but becomes a runtime string.
				limit: 1
			}
		};
	});
	watch(
		() => activeRecordQueryInput,
		(input) => {
			if (!input) {
				queries.record = null;
				return;
			}
			queries.record = input.operations.findMany(input.query);
		},
		{ lazy: false }
	);
	const activeRecord = $derived.by(() => {
		const record = queries.record?.current?.[0];
		// Remote queries retain the previous result while a new key in the same family loads. Never
		// mount a stateful representation with that carry-over row: its form captures recordId at
		// construction, so showing record B with record A's form would send edits to the wrong row.
		if (!record || !activeRecordId || String(Reflect.get(record, recordIdField)) !== activeRecordId)
			return undefined;
		return record;
	});
	const activeRecordLoading = $derived(Boolean(queries.record?.loading));
	const activeRecordError = $derived(queries.record?.error?.message);
	const tableLoading = $derived(queries.rows?.loading ?? false);
	const pageCount = $derived(
		Math.max(1, Math.ceil(tableApi.totalRows / tableApi.pagination.current.pageSize))
	);
	let approvalActionState = $state<ApprovalActionState>({ status: 'idle' });
	let changeRequestOpen = $state(false);
	const approvalActionPending = $derived(
		approvalActionState.status === 'pending' ||
			(approvalActionState.status === 'requesting_changes' && approvalActionState.pending)
	);
	const changeRequestReason = $derived(
		approvalActionState.status === 'requesting_changes' ? approvalActionState.reason : ''
	);
	const selectedRecords = $derived(
		tableApi.data
			.filter((row) => tableApi.rowSelection.current[row.__collectionTableRowId])
			.map((row) => row.record)
	);
	const updateSelectedAction = $derived(
		bulkEnabled && operations?.updateMany ? updateSelectedRecords : undefined
	);
	const deleteSelectedAction = $derived(
		bulkEnabled && operations?.delete ? deleteSelectedRecords : undefined
	);
	let createOpen = $state(false);
	const activeApprovalId = $derived.by(() => {
		if (!activeRecord) return undefined;
		const value = Reflect.get(activeRecord, 'norbital_approval_id');
		return typeof value === 'string' ? value : undefined;
	});
	const approvalQueryInput = $derived(
		activeApprovalId && workspaceClient.approvals
			? { approvalId: activeApprovalId, approvals: workspaceClient.approvals }
			: null
	);
	watch(
		() => approvalQueryInput,
		(input) => {
			queries.approval = input ? input.approvals.findMany(input.approvalId) : null;
		},
		{ lazy: false }
	);
	const approvalRequest = $derived(queries.approval?.current?.[0]);
	const approvalStatusMessage = $derived(
		queries.approval?.loading
			? 'Loading approval status…'
			: approvalRequest?.status === 'ONGOING'
				? 'This record is awaiting approval.'
				: `Status: ${approvalRequest?.status ?? 'Unknown'}`
	);

	function openRecord(row: GridRow): void {
		if (!detailNavigation)
			throw new Error('CollectionTable requires a record navigation provider.');
		const value = Reflect.get(row.record, recordIdField);
		if (value == null) {
			toast.error(`Cannot open detail without ${recordIdField}.`);
			return;
		}
		detailNavigation.open({
			collectionName: String(collection),
			recordId: String(value),
			routeKey: resolvedDetailRouteKey
		});
	}

	function recordDetailHref(row: GridRow): string | undefined {
		if (!detailNavigation) return undefined;
		const value = Reflect.get(row.record, recordIdField);
		if (value == null) return undefined;
		return detailNavigation.href({
			collectionName: String(collection),
			recordId: String(value),
			routeKey: resolvedDetailRouteKey
		});
	}

	function approvalAccent(row: GridRow): { borderClass: string; tooltip: string } | null {
		return typeof Reflect.get(row.record, 'norbital_approval_id') === 'string'
			? { borderClass: 'border-brand', tooltip: 'Pending approval' }
			: null;
	}

	function isRecordDetailActive(rowId: string): boolean {
		return activeRecordId === rowId;
	}

	function recordActionTabIndex(hovered: boolean, active: boolean): 0 | -1 {
		return hovered || active ? 0 : -1;
	}

	function recordActionClass(hovered: boolean, active: boolean): string {
		return cn(
			'inline-flex size-8 items-center justify-center rounded-sm text-muted-foreground outline-none hover:bg-accent hover:text-accent-foreground focus-visible:outline-none',
			active && 'bg-accent text-accent-foreground',
			!active && !hovered && 'opacity-0'
		);
	}

	function recordTitle(record: Row): string {
		const label = resolveRecordLabel(definition.recordLabel ?? null, record);
		if (label) return label;
		const fallbackField = definition.fields.find(
			(field) => !isSystemField(field.name) && field.kind !== 'uuid' && !field.name.endsWith('_id')
		);
		const fallback = fallbackField
			? formatDataValue(fallbackField, Reflect.get(record, fallbackField.name))
			: '';
		return fallback && fallback !== '—' ? fallback : humanize(String(collection));
	}

	function autoListDescription(record: Row): string {
		const titleField = autoCard.title.kind === 'field' ? autoCard.title.name : null;
		const fallback = definition.fields
			.filter(
				(field) =>
					!isSystemField(field.name) &&
					field.name !== titleField &&
					field.kind !== 'uuid' &&
					!field.name.endsWith('_id')
			)
			.map((field) => formatDataValue(field, Reflect.get(record, field.name)))
			.find((value) => value && value !== '—');
		return fallback ?? `${humanize(String(collection))} record`;
	}

	function formatRawStructuredValue(value: unknown): string {
		if (value == null) return '—';
		try {
			return JSON.stringify(value, null, 2) ?? String(value);
		} catch {
			return String(value);
		}
	}

	function formatFilterValue(value: unknown): string {
		if (value instanceof Date) return value.toLocaleString();
		if (Array.isArray(value)) return value.map(formatFilterValue).join(', ');
		if (typeof value === 'string') return value.replace(/^%|%$/g, '');
		if (typeof value === 'object' && value != null) return JSON.stringify(value);
		return String(value ?? 'empty');
	}

	function describeFilters(where: unknown): string[] {
		if (Array.isArray(where)) return where.flatMap(describeFilters);
		if (typeof where !== 'object' || where == null) return [];
		return Object.entries(where).flatMap(([fieldName, condition]) => {
			if (fieldName === 'AND') return describeFilters(condition);
			if (fieldName === 'OR') {
				const alternatives = describeFilters(condition);
				return alternatives.length > 0 ? [`Any of: ${alternatives.join('; ')}`] : [];
			}
			if (fieldName === 'NOT') return describeFilters(condition).map((label) => `Not ${label}`);
			const field = definition.fields.find((candidate) => candidate.name === fieldName);
			const label = field?.label ?? humanize(fieldName);
			if (typeof condition !== 'object' || condition == null || Array.isArray(condition)) {
				return [`${label} is ${formatFilterValue(condition)}`];
			}
			return Object.entries(condition).map(([operator, operand]) => {
				switch (operator) {
					case 'ilike':
						return `${label} contains ${formatFilterValue(operand)}`;
					case 'ne':
						return `${label} is not ${formatFilterValue(operand)}`;
					case 'gt':
						return `${label} is greater than ${formatFilterValue(operand)}`;
					case 'gte':
						return `${label} is at least ${formatFilterValue(operand)}`;
					case 'lt':
						return `${label} is less than ${formatFilterValue(operand)}`;
					case 'lte':
						return `${label} is at most ${formatFilterValue(operand)}`;
					case 'isNull':
						return `${label} is empty`;
					case 'isNotNull':
						return `${label} is not empty`;
					case 'contains_date':
						return `${label} contains ${formatFilterValue(operand)}`;
					default:
						return `${label} is ${formatFilterValue(operand)}`;
				}
			});
		});
	}

	async function processApproval(
		action: 'APPROVED' | 'REJECTED' | 'REQUEST_FOR_CHANGE',
		comments?: string
	): Promise<boolean> {
		const approvals = workspaceClient.approvals;
		if (!activeApprovalId || !approvals) return false;
		approvalActionState =
			action === 'REQUEST_FOR_CHANGE'
				? { status: 'requesting_changes', reason: comments ?? '', pending: true }
				: { status: 'pending' };
		try {
			await approvals.process({ approvalRequestId: activeApprovalId, action, comments });
			await Promise.all([queries.approval?.refresh(), refreshRows()]);
			toast.success(approvalActionSuccessMessage(action));
			if (action === 'REQUEST_FOR_CHANGE') changeRequestOpen = false;
			approvalActionState = { status: 'idle' };
			return true;
		} catch (error) {
			toast.error(error instanceof Error ? error.message : 'Approval action failed');
			approvalActionState =
				action === 'REQUEST_FOR_CHANGE'
					? { status: 'requesting_changes', reason: comments ?? '', pending: false }
					: { status: 'idle' };
			return false;
		}
	}

	function approvalActionSuccessMessage(
		action: 'APPROVED' | 'REJECTED' | 'REQUEST_FOR_CHANGE'
	): string {
		switch (action) {
			case 'APPROVED':
				return 'Request approved';
			case 'REJECTED':
				return 'Request rejected';
			case 'REQUEST_FOR_CHANGE':
				return 'Changes requested';
			default:
				return action satisfies never;
		}
	}

	function openChangeRequest(): void {
		approvalActionState = { status: 'requesting_changes', reason: '', pending: false };
		changeRequestOpen = true;
	}

	function closeChangeRequest(): void {
		if (approvalActionPending) return;
		changeRequestOpen = false;
		approvalActionState = { status: 'idle' };
	}

	function updateChangeRequestReason(reason: string): void {
		if (approvalActionState.status !== 'requesting_changes') return;
		approvalActionState = { ...approvalActionState, reason };
	}

	async function requestChanges(): Promise<void> {
		const reason = changeRequestReason.trim();
		if (!reason) return;
		await processApproval('REQUEST_FOR_CHANGE', reason);
	}

	async function withdrawApproval(): Promise<void> {
		const approvals = workspaceClient.approvals;
		if (!activeApprovalId || !approvals) return;
		approvalActionState = { status: 'pending' };
		try {
			await approvals.withdraw(activeApprovalId);
			await Promise.all([queries.approval?.refresh(), refreshRows()]);
			toast.success('Approval request withdrawn');
		} catch (error) {
			toast.error(error instanceof Error ? error.message : 'Unable to withdraw approval request');
		} finally {
			approvalActionState = { status: 'idle' };
		}
	}

	async function refreshRows(): Promise<void> {
		await queries.rows?.refresh();
	}

	async function refresh(): Promise<void> {
		await Promise.all([refreshRows(), queries.count?.refresh()]);
	}

	async function refreshDetail(): Promise<void> {
		await Promise.all([refreshRows(), queries.record?.refresh(), queries.approval?.refresh()]);
	}

	async function refreshData(): Promise<void> {
		if (tableLoading || disabled) return;
		try {
			await refresh();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : 'Refresh failed');
		}
	}

	async function updateSelectedRecords(
		fieldName: string,
		value: unknown,
		rows: readonly Row[]
	): Promise<void> {
		const updateMany = operations?.updateMany;
		if (!updateMany) throw new Error('This collection does not allow bulk updates.');
		await updateMany(
			rows.map((record) => ({
				recordId: collectionRecordId(record),
				input: { [fieldName]: value } as CollectionUpdateInput<CollectionType<Row, object, object>> // stupidity: boundary-cast — schema-selected writable fields and DataRenderer constrain the dynamic patch.
			}))
		);
	}

	async function deleteSelectedRecords(rows: readonly Row[]): Promise<void> {
		const deleteRecord = operations?.delete;
		if (!deleteRecord) throw new Error('This collection does not allow deletion.');
		await Promise.all(rows.map((record) => deleteRecord(collectionRecordId(record))));
	}

	function updateInteractiveFilters(filters: readonly CollectionFilter[]): void {
		resetToFirstPage();
		interactiveFilters = filters;
	}

	function resetToFirstPage(): void {
		queries.cursors = [undefined];
		if (tableApi.pagination.current.pageIndex === 0) return;
		tableApi.setPagination({ pageIndex: 0, pageSize: tableApi.pagination.current.pageSize });
	}

	function setPage(pageIndex: number): void {
		tableApi.setPagination({
			pageIndex,
			pageSize: tableApi.pagination.current.pageSize
		});
	}

	function previousPage(): void {
		if (tableApi.pagination.current.pageIndex === 0) return;
		setPage(tableApi.pagination.current.pageIndex - 1);
	}

	function nextPage(): void {
		const nextCursor = queries.rows?.nextCursor;
		if (!nextCursor) return;
		const nextIndex = tableApi.pagination.current.pageIndex + 1;
		queries.cursors[nextIndex] = nextCursor;
		setPage(nextIndex);
	}

	const listRows = $derived(
		tableApi.rowInstances.map((row) => ({
			id: row.id,
			record: row.raw.record,
			selected: row.isSelected,
			toggleSelection: () => row.toggleSelection()
		}))
	);
</script>

{#snippet defaultCell({ column, row, value }: { column: ColumnConfig; row: Row; value: unknown })}
	<!-- A relation is a uuid and renders as text. To show it as a labelled record, give the column a
	     `render` that mounts RelationshipRenderer with the option set you want. -->
	<DataRenderer
		field={metadataFor(column)}
		{value}
		row={row as Record<string, unknown>}
		mode="display"
	/>
{/snippet}

{#snippet gridRowAction({ row, hovered }: { row: RowAPI<GridRow, unknown>; hovered: boolean })}
	{#each rowActions ?? [] as action}
		{@const context: CollectionTableRowActionContext<Row> = {
			row: row.raw.record,
			hovered
		}}
		{@render action(context)}
	{/each}
{/snippet}

{#snippet openRecordAction({ row, hovered }: { row: RowAPI<GridRow, unknown>; hovered: boolean })}
	{@const isDetailActive = isRecordDetailActive(row.id)}
	<button
		type="button"
		aria-label="Open record detail"
		aria-pressed={isDetailActive}
		tabindex={recordActionTabIndex(hovered, isDetailActive)}
		class={recordActionClass(hovered, isDetailActive)}
		onclick={(event) => {
			event.preventDefault();
			event.stopPropagation();
			openRecord(row.raw);
			event.currentTarget.blur();
		}}
	>
		<Icon icon="lucide:panel-right-open" class="size-4" />
	</button>
{/snippet}

{#snippet tableToolbar()}
	{#if title}<h2 class="shrink-0 truncate text-sm font-semibold">{title}</h2>{/if}
	{#if showAbout}
		<Tooltip align="start" contentClass="max-w-sm space-y-2" delayDuration={100}>
			{#snippet trigger({ props })}
				<Button
					{...props}
					type="button"
					variant="ghost"
					size="icon"
					class="size-8"
					aria-label="About this collection"
				>
					<Icon icon="lucide:info" class="size-4" />
				</Button>
			{/snippet}
			{#snippet content()}
				{#if description}<p>{description}</p>{/if}
				{#if query?.where}
					<Stack gap="xs">
						<p class="font-medium">Applied by this view</p>
						<Stack as="ul" gap="xs">
							{#each prefilterDescriptions as filterDescription}
								<Inline as="li" align="start" gap="xs" class="text-xs">
									<Icon icon="lucide:filter" class="mt-0.5 size-3 shrink-0 opacity-70" />
									<span>{filterDescription}</span>
								</Inline>
							{/each}
						</Stack>
					</Stack>
				{/if}
			{/snippet}
		</Tooltip>
	{/if}
	<CollectionQueryControls
		{definition}
		collections={workspaceClient.collections}
		{disabled}
		searchEnabled={searchEnabled && definition.fields.length > 0}
		{filterEnabled}
		initialSearch={tableApi.search.current}
		searchPlaceholder={searchPlaceholder ?? 'Search text fields…'}
		onSearchChange={(search) => {
			resetToFirstPage();
			tableApi.setSearch(search);
		}}
		onFilterChange={updateInteractiveFilters}
	/>
	{#if operationsEnabled}
		<CollectionTableOperations
			collectionName={String(collection)}
			{exportPipelines}
			{importPipelines}
			{integrations}
			selectedRows={selectedRecords}
			fields={definition.fields}
			updateSelected={updateSelectedAction}
			deleteSelected={deleteSelectedAction}
			clearSelection={() => tableApi.setRowSelection({})}
			{disabled}
			{refresh}
		/>
	{/if}
{/snippet}

{#snippet createTools()}
	<Button size="sm" {disabled} onclick={() => (createOpen = true)}>
		<Icon icon="lucide:plus" class="size-4" />
		{createLabel}
	</Button>
{/snippet}

{#snippet toolbarTools()}
	{#if createEnabled}
		{@render createTools()}
	{/if}
	<Button
		type="button"
		variant="ghost"
		size="icon"
		aria-label="Refresh collection data"
		title="Refresh collection data"
		disabled={disabled || tableLoading}
		onclick={() => void refreshData()}
	>
		<Icon icon="lucide:refresh-cw" class={tableLoading ? 'size-4 animate-spin' : 'size-4'} />
	</Button>
{/snippet}

{#snippet autoListCard(record: Row)}
	{@const subtitle = formatAutoCardSubtitle(autoCard, definition.fields, record)}
	{@const badge = formatAutoCardBadge(autoCard, definition.fields, record)}
	<Inline align="start" justify="between" gap="md">
		<Stack gap="xs">
			<p class="min-w-0 truncate font-medium">{autoCardTitle(record)}</p>
			<p class="min-w-0 truncate text-sm text-muted-foreground">
				{subtitle || autoListDescription(record)}
			</p>
		</Stack>
		{#if badge}
			<!-- stupidity:allow UI6 -- this leaf component root is the reusable layout boundary being defined -->
			<span
				class={cn(
					'inline-flex max-w-full shrink-0 items-center gap-1 truncate rounded-full border px-2 py-0.5 text-xs font-medium',
					badgeColorClass(badge.color)
				)}>{badge.label}</span
			>
		{/if}
	</Inline>
{/snippet}

{#snippet recordDetails()}
	{#if activeRecord && collectionSurface?.representation}
		{@const Representation = collectionSurface.representation}
		{#key activeRecordId}
			<Representation
				record={activeRecord}
				close={() => detailNavigation?.pop()}
				refresh={refreshDetail}
			/>
		{/key}
	{:else if activeRecord}
		<!-- Default detail surface (RFC V.2/V.6): a schema-derived form bound to the record. -->
		{#key activeRecordId}
			<CollectionForm
				{client}
				{collection}
				recordId={activeRecordId}
				defaultValues={activeRecord}
			/>
		{/key}
	{:else}
		<CollectionRecordDetailEmpty
			icon="lucide:panel-top-dashed"
			title="No custom record view"
			description="This collection has no dedicated UI representation. Use Raw to inspect its fields."
		/>
	{/if}
{/snippet}

{#snippet approvalDetails()}
	<Stack gap="md">
		{#if queries.approval?.loading || approvalRequest}
			<div class="rounded-lg border bg-muted/30 p-4">
				<p class="text-sm font-medium">Approval request</p>
				<p class="mt-1 text-sm text-muted-foreground">{approvalStatusMessage}</p>
			</div>
		{/if}
		{#if approvalRequest}
			<Grid as="dl" minimum="card" gap="sm" class="rounded-lg border p-4">
				{#each Object.entries(approvalRequest) as [key, value] (key)}
					<div class="min-w-0">
						<dt class="text-xs font-medium text-muted-foreground">{humanize(key)}</dt>
						<dd class="mt-1 break-words text-sm">
							{typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value ?? '—')}
						</dd>
					</div>
				{/each}
			</Grid>
		{:else if !queries.approval?.loading}
			<CollectionRecordDetailEmpty
				icon="lucide:shield-check"
				title="No approval request"
				description="This record has no approval workflow activity yet."
			/>
		{/if}
		{#if approvalRequest?.status === 'ONGOING'}
			<Cluster gap="sm">
				<Button disabled={approvalActionPending} onclick={() => void processApproval('APPROVED')}>
					Approve
				</Button>
				<Button variant="outline" disabled={approvalActionPending} onclick={openChangeRequest}
					>Request changes</Button
				>
				<Button
					variant="outline"
					disabled={approvalActionPending}
					onclick={() => void processApproval('REJECTED')}>Reject</Button
				>
				<Button variant="ghost" disabled={approvalActionPending} onclick={withdrawApproval}
					>Withdraw request</Button
				>
			</Cluster>
		{/if}
	</Stack>
{/snippet}

{#snippet rawDetails()}
	{#if activeRecord}
		<Grid as="dl" minimum="card" gap="sm">
			{#each definition.fields as field (field.name)}
				<div class="min-w-0 rounded-lg border bg-card p-4">
					<dt class="text-xs font-medium text-muted-foreground">
						{field.label ?? humanize(field.name)}
					</dt>
					<dd class="mt-1 text-sm">
						{#if field.kind === 'json'}
							<pre
								class="whitespace-pre-wrap break-words font-mono text-xs">{formatRawStructuredValue(
									Reflect.get(activeRecord, field.name)
								)}</pre>
						{:else}
							<DataRenderer {field} value={Reflect.get(activeRecord, field.name)} mode="display" />
						{/if}
					</dd>
				</div>
			{/each}
		</Grid>
	{/if}
{/snippet}

{#snippet recordSurface({ recordId, actions }: CollectionTableDetailRenderContext)}
	<CollectionRecordDetailTabs
		title={activeRecord ? recordTitle(activeRecord) : humanize(String(collection))}
		description={`${humanize(String(collection))} record details`}
		loading={recordId !== activeRecordId || activeRecordLoading}
		error={activeRecordError}
		found={Boolean(activeRecord)}
		{actions}
		ui={recordDetails}
		approval={approvalDetails}
		raw={rawDetails}
	/>
{/snippet}

<div class="hidden" aria-hidden="true">
	{@render columns({ Column: CollectionTablePart })}
</div>

{#if detailNavigation}
	{#key resolvedDetailRouteKey}
		<CollectionTableDetailRegistration
			navigation={detailNavigation}
			routeKey={resolvedDetailRouteKey}
			renderDetail={recordSurface}
		/>
	{/key}
{/if}

<!-- stupidity:allow UI10 -- collection surfaces need a natural minimum height (header + a few rows); no Bound size expresses it -->
<!-- stupidity:allow UI15 -- the table keeps a usable empty/loading viewport before rows establish intrinsic height -->
<Bound size="full" class="collection-table-responsive min-h-[24rem]" data-collection-table-surface>
	<CollectionGrid
		table={tableApi}
		{disabled}
		class={cn('collection-table-wide', className)}
		isLoading={tableLoading}
		error={errorMessage}
		enableSelection={effectiveSelectable}
		onRowActivate={openRecord}
		getRowLeadingAccent={approvalAccent}
		{activeRecordId}
		rowActions={gridRowActions}
		leftActions={[tableToolbar]}
		rightActions={[toolbarTools]}
		stickyRowActions={true}
		hasNextPage={Boolean(queries.rows?.nextCursor)}
		onPreviousPage={previousPage}
		onNextPage={nextPage}
		{emptyPlaceholder}
	/>

	<CollectionTableList
		rows={listRows}
		loading={tableLoading}
		error={errorMessage}
		selectable={effectiveSelectable}
		{disabled}
		class={cn('collection-table-narrow', className)}
		pageIndex={tableApi.pagination.current.pageIndex}
		{pageCount}
		hasNextPage={Boolean(queries.rows?.nextCursor)}
		toolbar={tableToolbar}
		{toolbarTools}
		ListCard={ListCard ?? autoListCard}
		{emptyPlaceholder}
		{rowActions}
		{recordTitle}
		{activeRecordId}
		recordHref={(record) =>
			recordDetailHref({
				record,
				__collectionTableRowId: String(Reflect.get(record, recordIdField))
			})}
		onOpen={(record) =>
			openRecord({
				record,
				__collectionTableRowId: String(Reflect.get(record, recordIdField))
			})}
		onPreviousPage={previousPage}
		onNextPage={nextPage}
	/>
</Bound>

<Sheet.Root bind:open={createOpen}>
	<Sheet.Content flush class="sm:max-w-xl">
		<Sheet.Header class="shrink-0 border-b px-5 py-4">
			<Sheet.Title>{createLabel}</Sheet.Title>
			<Sheet.Description class="sr-only">{createLabel} form</Sheet.Description>
		</Sheet.Header>
		<div class="min-h-0 flex-1 p-5">
			{#if collectionSurface?.representation}
				{@const Representation = collectionSurface.representation}
				<Representation
					record={null}
					refresh
					close={() => {
						void refresh();
						createOpen = false;
					}}
				/>
			{:else}
				<CollectionForm
					{client}
					{collection}
					onAfterSubmit={() => {
						void refresh();
						createOpen = false;
					}}
				/>
			{/if}
		</div>
	</Sheet.Content>
</Sheet.Root>

<Dialog.Root open={changeRequestOpen} onOpenChange={(open) => !open && closeChangeRequest()}>
	<Dialog.Content class="max-w-md">
		<Dialog.Header>
			<Dialog.Title>Request changes</Dialog.Title>
			<Dialog.Description>
				Explain what must change before this request can be approved.
			</Dialog.Description>
		</Dialog.Header>
		<label class="grid gap-1.5 text-sm font-medium">
			Change request reason
			<Textarea
				value={changeRequestReason}
				placeholder="Describe the required changes"
				maxlength={1000}
				required
				oninput={(event) => updateChangeRequestReason(event.currentTarget.value)}
			/>
		</label>
		<Dialog.Footer>
			<Dialog.Close disabled={approvalActionPending}>Cancel</Dialog.Close>
			<Button
				disabled={approvalActionPending || changeRequestReason.trim().length === 0}
				onclick={() => void requestChanges()}
			>
				{approvalActionPending ? 'Requesting…' : 'Request changes'}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<style>
	.collection-table-narrow {
		display: none;
	}

	@container (max-width: 47.999rem) {
		.collection-table-wide {
			display: none;
		}

		.collection-table-narrow {
			display: grid;
		}
	}
</style>
