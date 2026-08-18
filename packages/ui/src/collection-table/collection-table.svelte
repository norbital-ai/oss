<script
	lang="ts"
	generics="TCollections extends CollectionRegistry = CollectionRegistry, TName extends CollectionName<TCollections> = CollectionName<TCollections>, TRow extends object = CollectionTableRow<TCollections, TName>"
>
	import type {
		CollectionApprovalRequest,
		CollectionDefinition,
		CollectionField,
		CollectionFieldName,
		CollectionOperations,
		CollectionPageQuery,
		CollectionQuery,
		CollectionRegistry,
		CollectionType,
		CollectionRecord,
		CollectionUpdateInput,
		RemoteQuery
	} from '@norbital-ai/std/collection';
	import { resolveRecordLabel } from '@norbital-ai/std/collection';
	import { humanize } from '@norbital-ai/std/string';
	import Icon from '@iconify/svelte';
	import { onMount } from 'svelte';
	import { Button } from '#lib/button';
	import * as Dialog from '#lib/dialog';
	import { Textarea } from '#lib/textarea';
	import * as Popover from '#lib/popover';
	import * as Sheet from '#lib/sheet';
	import { cn, renderSnippet, RenderComponentConfig, RenderSnippetConfig } from '#lib/utils';
	import { useI18n, type UiKeys } from '#lib/i18n';
	import { DataRenderer } from '../data-renderer/index.js';
	import { formatDataValue, type Translate } from '../data-renderer/index.js';
	import { Cluster, Cover, Grid, Inline, Stack, Bound } from '#lib/layout';
	import { CollectionQueryState } from '#lib/collection-query';
	import {
		CollectionActionToolbar,
		CollectionPagination,
		type CollectionToolbarComposition
	} from '#lib/collection-toolbar';
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
	import CollectionTableList from './collection-table-list.svelte';
	import CollectionTableAppliedFilters from './collection-table-applied-filters.svelte';
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
	import {
		getCollectionClientForSurface,
		getCollectionRecordScope,
		getCollectionSurfaceRuntime,
		resolveCollectionSurface,
		resolveCollectionViewKey,
		setCollectionClientContext,
		setCollectionRecordScope
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
		initialFilters = [],
		disabled = false,
		isRowLocked,
		rowLockReason,
		selectable = false,
		class: className,
		rootClass,
		borderless = false,
		rowActions,
		emptyPlaceholder,
		title,
		description,
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
	const { t } = useI18n<UiKeys>();
	const surfaceRuntime = getCollectionSurfaceRuntime();
	const collectionSurface = $derived(
		resolveCollectionSurface(surfaceRuntime?.surfaces, String(collection))
	);

	const definition = $derived(
		workspaceClient.collections[String(collection)] as CollectionDefinition<
			CollectionType<Row, object, object>
		> // stupidity: boundary-cast — the generated client and runtime manifest share collection keys.
	);
	const rawRecordFields = $derived(definition.fields.filter((field) => !isSystemField(field.name)));
	const rawSystemFields = $derived(definition.fields.filter((field) => isSystemField(field.name)));
	const operations = $derived(
		client.db[collection] as CollectionOperations<CollectionType<Row, object, object>> // stupidity: boundary-cast — Svelte's generic component boundary erases the inferred collection row.
	);
	const recordIdField = 'norbital_id';
	const recordScope = getCollectionRecordScope();
	const resolvedView = $derived(
		resolveCollectionViewKey(
			view,
			`${surfaceRuntime?.appId() ?? 'unhosted'}:${String(collection)}`,
			recordScope?.()
		)
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
		parseCondition: (condition) => condition
	});
	tableApi.rowLocked = (row) => isRowLocked?.(row.record) === true;
	/**
	 * The one search + filter + page model this table runs on.
	 *
	 * `TableAPI` used to hold a second copy of the search string and the page, and every narrowing
	 * had to remember to call `resetToFirstPage()` before it took effect. The reset is a property of
	 * the model, not a courtesy each handler pays it, so it lives in `CollectionQueryState` now and
	 * the table only keeps what is genuinely its own: the cursor for each page it has visited.
	 */
	// svelte-ignore state_referenced_locally
	const queryState = new CollectionQueryState<Row>({
		// svelte-ignore state_referenced_locally
		pageSize: query?.limit ?? 25,
		// svelte-ignore state_referenced_locally
		persistenceKey: resolvedView
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
		activeColumns.length === 0 ? t('table.metadataError', { collection: String(collection) }) : ''
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
			effectiveSelectable,
			t as Translate,
			(row) => isRowLocked?.(row.raw.record) === true
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
	const createLabel = $derived(createActionLabel(String(collection), undefined, t as Translate));

	/**
	 * One card line, resolved the way the wide grid resolves the same cell.
	 *
	 * A card role names a column, and on a relation column only that column's authored `render`
	 * knows how to read the row — `leave_type_id` is a uuid until `render` reaches through the
	 * joined `leave_request_type`. Asking `renderCell` is what keeps the narrow list and the wide
	 * grid saying the same thing about the same record; formatting the raw field instead is how the
	 * list came to show operators raw uuids on any surface under 48rem.
	 *
	 * Only text answers are taken. A column may render a component or a snippet, and a card line is
	 * a single truncating row with nowhere to mount one — and a column with no `render` at all
	 * resolves to the default cell snippet, which is exactly the case the schema formatter covers.
	 */
	function cardText(name: string, record: Row): string {
		const column = activeColumns.find((candidate) => String(candidate.key) === name);
		const rendered = column ? renderCell(column, record) : undefined;
		if (typeof rendered === 'string' && rendered !== '') return rendered;
		return formatAutoCardField(definition.fields, name, record, t as Translate);
	}

	function autoCardTitle(record: Row): string {
		if (autoCard.title.kind === 'field') {
			const text = cardText(autoCard.title.name, record);
			if (text && text !== '—') return text;
		}
		return recordTitle(record);
	}

	/**
	 * Every cursor past the first belongs to the query that produced it. A new search, filter set,
	 * page size or sort order makes the rest of the chain point into a result set that no longer
	 * exists, so it is thrown away rather than re-walked. The page index resets itself inside the
	 * query model; the cursor ledger is this surface's own bookkeeping.
	 */
	watch(
		// A signature, not the values: `orderBy` is rebuilt whenever the column registry settles, and
		// comparing identities would throw the ledger away on a change that never happened.
		() =>
			JSON.stringify([queryState.search, queryState.filters, queryState.pageSize, orderBy ?? null]),
		() => {
			queries.cursors = [undefined];
			queryState.setPageIndex(0);
		}
	);

	const rowsQueryInput = $derived.by(() => {
		if (disabled) return null;
		return {
			operations,
			query: {
				...query,
				search: queryState.search || undefined,
				orderBy: orderBy ?? defaultOrderBy,
				limit: queryState.pageSize,
				after: queries.cursors[queryState.pageIndex]
			},
			filterOptions: queryState.queryOptions
		};
	});
	watch(
		() => rowsQueryInput,
		(input) => {
			if (!input) {
				queries.rows = null;
				return;
			}
			queries.rows = input.operations.findMany(input.query, input.filterOptions);
		},
		{ lazy: false }
	);
	const pageRows = $derived(queries.rows?.current);

	/**
	 * The cursor for the next page is learned as soon as this one loads, rather than at the moment
	 * someone presses "next". The shared pagination bar moves the page index and knows nothing about
	 * cursors — it should not have to.
	 */
	watch(
		() => ({ pageIndex: queryState.pageIndex, cursor: queries.rows?.nextCursor }),
		({ pageIndex, cursor }) => {
			if (cursor) queries.cursors[pageIndex + 1] = cursor;
		},
		{ lazy: false }
	);

	const countQueryInput = $derived.by(() => {
		if (disabled) return null;
		return {
			operations,
			query: {
				where: query?.where,
				search: queryState.search || undefined,
				columns: query?.columns,
				bypass_secret: query?.bypass_secret
			},
			filterOptions: queryState.queryOptions
		};
	});
	watch(
		() => countQueryInput,
		(input) => {
			if (!input) {
				queries.count = null;
				return;
			}
			queries.count = input.operations.count(input.query, input.filterOptions);
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
							: formatDataValue(field, value, undefined, t as Translate);
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
	// A table nested in this table's detail surface belongs to the open record; it persists its view
	// against that record instead of sharing one key across every parent row.
	setCollectionRecordScope(() => activeRecordId);
	const activeRecordLoading = $derived(Boolean(queries.record?.loading));
	const activeRecordError = $derived(queries.record?.error?.message);
	// A missing query resource or an undefined first value is still "unknown", never an empty
	// collection. Keep the loader visible until the first locally-synced or server-proven result
	// arrives; only a resolved [] may render the empty state.
	const tableLoading = $derived(
		!disabled &&
			(queries.rows == null ||
				(queries.rows.current === undefined && queries.rows.error == null))
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
			? t('table.approvalLoading')
			: approvalRequest?.status === 'ONGOING'
				? t('table.approvalAwaiting')
				: t('table.approvalStatus', {
						status: approvalRequest?.status ?? t('common.unknown')
					})
	);

	function openRecord(row: GridRow): void {
		if (!detailNavigation)
			throw new Error('CollectionTable requires a record navigation provider.');
		const value = Reflect.get(row.record, recordIdField);
		if (value == null) {
			toast.error(t('table.detailMissingId', { field: recordIdField }));
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

	/**
	 * The leading edge of a row says one thing: this record is not settled.
	 *
	 * Approval already spoke that way — a leading border with a title and aria-label, so the state
	 * survives colour blindness and a screen reader — and a write still waiting in the sync outbox
	 * is the same kind of fact about a row, so it reuses the same affordance rather than inventing a
	 * second vocabulary for "not final". Only the colour and the sentence differ: warning amber for
	 * a write that has not reached the server, brand for one that has and is awaiting a human.
	 *
	 * Unsynced outranks awaiting-approval, because it is the more consequential of the two: an
	 * approval is a record the server already holds, an unsynced row is one it does not.
	 *
	 * A *rejected* write is never in this state — the mutation is rolled back, so the row either
	 * reverts or disappears, and the failure is reported where it was made.
	 */
	function rowLeadingAccent(row: GridRow): { borderClass: string; tooltip: string } | null {
		if (Reflect.get(row.record, 'norbital_pending_sync') === true) {
			return { borderClass: 'border-warning', tooltip: t('table.pendingSync') };
		}
		if (typeof Reflect.get(row.record, 'norbital_approval_id') === 'string') {
			return { borderClass: 'border-brand', tooltip: t('table.pendingApproval') };
		}
		if (isRowLocked?.(row.record) === true) {
			return {
				borderClass: 'border-muted-foreground',
				tooltip: rowLockReason?.(row.record) ?? t('table.recordLocked')
			};
		}
		return null;
	}

	function isRecordDetailActive(rowId: string): boolean {
		return activeRecordId === rowId;
	}

	function recordActionTabIndex(hovered: boolean, active: boolean): 0 | -1 {
		return hovered || active ? 0 : -1;
	}

	function recordActionClass(hovered: boolean, active: boolean): string {
		return cn(
			'inline-flex size-8 items-center justify-center rounded-md border border-border bg-card text-muted-foreground shadow-xs outline-none transition-colors hover:bg-muted hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
			active && 'border-brand/40 bg-accent text-accent-foreground',
			!active && !hovered && 'opacity-0'
		);
	}

	function recordTitle(record: Row): string {
		// Bolt declares `recordLabel` as a plain column name — `recordLabel: 'summary'`. The CEL
		// resolver evaluates it as an expression and returns null for a bare identifier, so the title
		// fell through to the first non-uuid column, which on a leave request is the raw event JSON.
		// A bare name is read as what it is; anything else is still an expression.
		const declared = definition.recordLabel ?? null;
		if (declared && /^[A-Za-z_][A-Za-z0-9_]*$/.test(declared)) {
			const value = Reflect.get(record, declared);
			if (typeof value === 'string' && value.trim() !== '') return value;
		}
		const label = resolveRecordLabel(declared, record);
		if (label) return label;
		const fallbackField = definition.fields.find(
			(field) => !isSystemField(field.name) && field.kind !== 'uuid' && !field.name.endsWith('_id')
		);
		const fallback = fallbackField
			? formatDataValue(
					fallbackField,
					Reflect.get(record, fallbackField.name),
					undefined,
					t as Translate
				)
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
			.map((field) =>
				formatDataValue(field, Reflect.get(record, field.name), undefined, t as Translate)
			)
			.find((value) => value && value !== '—');
		return fallback ?? t('table.recordDescription', { name: humanize(String(collection)) });
	}

	function formatRawStructuredValue(value: unknown): string {
		if (value == null) return '—';
		try {
			return JSON.stringify(value, null, 2) ?? String(value);
		} catch {
			return String(value);
		}
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
			if (action === 'REQUEST_FOR_CHANGE') changeRequestOpen = false;
			approvalActionState = { status: 'idle' };
			toast.success(approvalActionSuccessMessage(action));
			// The decision is already committed. Keep slow or failed reads from turning a successful
			// mutation into a stuck dialog and a false "action failed" message; live sync normally wins
			// this race, while these refreshes are only an immediate consistency assist.
			void Promise.all([queries.approval?.refresh(), refreshRows()]).catch((error: unknown) => {
				toast.error(
					error instanceof Error
						? `${t('table.actionRefreshFailed')}: ${error.message}`
						: t('table.actionRefreshFailed')
				);
			});
			return true;
		} catch (error) {
			toast.error(error instanceof Error ? error.message : t('table.approvalActionFailed'));
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
				return t('table.approvalApproved');
			case 'REJECTED':
				return t('table.approvalRejected');
			case 'REQUEST_FOR_CHANGE':
				return t('table.approvalChangesRequested');
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
			toast.success(t('table.approvalWithdrawn'));
		} catch (error) {
			toast.error(error instanceof Error ? error.message : t('table.approvalWithdrawFailed'));
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
		if (disabled) return;
		try {
			await refresh();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : t('table.refreshFailed'));
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
		aria-label={t('table.detailOpen')}
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

{#snippet toolbarActions({ Action }: CollectionToolbarComposition<Row>)}
	{#if createEnabled}
		<Action
			label={createLabel}
			icon="lucide:plus"
			variant="default"
			unavailable={disabled ? t('table.viewDisabled') : undefined}
			onRun={() => {
				createOpen = true;
			}}
		/>
	{/if}
	<Action
		label={t('table.refreshCollectionData')}
		icon="lucide:refresh-cw"
		iconOnly
		pending={tableLoading}
		unavailable={disabled ? t('table.viewDisabled') : undefined}
		onRun={() => refreshData()}
	/>
{/snippet}

{#snippet toolbar()}
	{#snippet appliedFilters()}
		<CollectionTableAppliedFilters
			where={query?.where}
			{definition}
			collections={workspaceClient.collections}
		/>
	{/snippet}
	<CollectionActionToolbar
		{client}
		{collection}
		query={queryState}
		{title}
		about={showAbout
			? { description, ...(query?.where ? { appliedContent: appliedFilters } : {}) }
			: undefined}
		{disabled}
		features={{ search: searchEnabled, filter: filterEnabled }}
		{initialFilters}
		filterPersistenceKey={resolvedView}
		operations={operationsEnabled
			? {
					exportPipelines,
					importPipelines,
					integrations,
					selectedRows: selectedRecords,
					updateSelected: updateSelectedAction,
					deleteSelected: deleteSelectedAction,
					clearSelection: () => tableApi.setRowSelection({}),
					refresh
				}
			: undefined}
		actions={toolbarActions}
	/>
{/snippet}

{#snippet paginationBar()}
	<CollectionPagination
		query={queryState}
		total={tableApi.totalRows}
		hasNextPage={Boolean(queries.rows?.nextCursor)}
		{disabled}
		selectedCount={effectiveSelectable ? selectedRecords.length : undefined}
	/>
{/snippet}

{#snippet autoListCard(record: Row)}
	{@const subtitle = formatAutoCardSubtitle(autoCard, (name) => cardText(name, record))}
	{@const badge = formatAutoCardBadge(autoCard, record, (name) => cardText(name, record))}
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
					badgeColorClass()
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
			<CollectionForm {client} {collection} defaultValues={activeRecord} />
		{/key}
	{:else}
		<CollectionRecordDetailEmpty
			icon="lucide:panel-top-dashed"
			title={t('table.noCustomView')}
			description={t('table.noCustomViewDesc')}
		/>
	{/if}
{/snippet}

{#snippet approvalDetails()}
	<Stack gap="md">
		{#if queries.approval?.loading}
			<Inline
				gap="sm"
				class="rounded-lg border bg-card p-4 text-sm text-muted-foreground"
				role="status"
			>
				<Icon icon="lucide:loader-circle" class="size-4 animate-spin" aria-hidden="true" />
				{t('table.approvalLoading')}
			</Inline>
		{:else if approvalRequest}
			<Stack gap="md" class="rounded-lg border bg-card p-4">
				<Inline align="start" gap="md">
					<div
						class={cn(
							'flex size-9 shrink-0 items-center justify-center rounded-full',
							approvalRequest.status === 'APPROVED' && 'bg-success/10 text-success',
							approvalRequest.status === 'REJECTED' && 'bg-destructive/10 text-destructive',
							approvalRequest.status === 'REQUEST_FOR_CHANGE' &&
								'bg-warning/15 text-warning-foreground',
							approvalRequest.status === 'ONGOING' && 'bg-brand/10 text-brand',
							!['APPROVED', 'REJECTED', 'REQUEST_FOR_CHANGE', 'ONGOING'].includes(
								approvalRequest.status
							) && 'bg-muted text-muted-foreground'
						)}
					>
						<Icon
							icon={approvalRequest.status === 'APPROVED'
								? 'lucide:circle-check'
								: approvalRequest.status === 'REJECTED'
									? 'lucide:circle-x'
									: approvalRequest.status === 'REQUEST_FOR_CHANGE'
										? 'lucide:message-square-warning'
										: approvalRequest.status === 'ONGOING'
											? 'lucide:clock-3'
											: 'lucide:shield-check'}
							class="size-4"
							aria-hidden="true"
						/>
					</div>
					<Stack gap="xs" grow>
						<Inline gap="sm" justify="between">
							<p class="text-sm font-medium">{t('table.approvalRequest')}</p>
							<span
								class={cn(
									'rounded-full border px-2 py-0.5 text-xs font-medium',
									approvalRequest.status === 'APPROVED' &&
										'border-success/25 bg-success/10 text-success',
									approvalRequest.status === 'REJECTED' &&
										'border-destructive/25 bg-destructive/10 text-destructive',
									approvalRequest.status === 'REQUEST_FOR_CHANGE' &&
										'border-warning/30 bg-warning/15 text-warning-foreground',
									approvalRequest.status === 'ONGOING' && 'border-brand/25 bg-brand/10 text-brand'
								)}>{humanize(approvalRequest.status)}</span
							>
						</Inline>
						<p class="text-sm leading-5 text-muted-foreground">{approvalStatusMessage}</p>
						<p
							class="truncate font-mono text-micro text-muted-foreground"
							title={approvalRequest.norbital_id}
						>
							{t('table.approvalRequestId')}: {approvalRequest.norbital_id}
						</p>
					</Stack>
				</Inline>
				{#if approvalRequest.status === 'ONGOING'}
					<Cluster gap="sm" class="border-t pt-4">
						<Button
							disabled={approvalActionPending}
							onclick={() => void processApproval('APPROVED')}
						>
							<Icon icon="lucide:check" class="mr-1.5 size-3.5" aria-hidden="true" />
							{t('table.approve')}
						</Button>
						<Button variant="outline" disabled={approvalActionPending} onclick={openChangeRequest}
							>{t('table.requestChanges')}</Button
						>
						<Button
							variant="outline"
							class="text-destructive hover:text-destructive"
							disabled={approvalActionPending}
							onclick={() => void processApproval('REJECTED')}>{t('table.reject')}</Button
						>
						<Button variant="ghost" disabled={approvalActionPending} onclick={withdrawApproval}
							>{t('table.withdrawRequest')}</Button
						>
					</Cluster>
				{/if}
			</Stack>
		{:else}
			<CollectionRecordDetailEmpty
				icon="lucide:shield-check"
				title={t('table.noApprovalRequest')}
				description={t('table.noApprovalRequestDesc')}
			/>
		{/if}
	</Stack>
{/snippet}

{#snippet rawFieldGrid({
	record,
	fields,
	className
}: {
	record: Row;
	fields: readonly CollectionField[];
	className?: string;
})}
	<Grid as="dl" minimum="compact" gap="md" class={className}>
		{#each fields as field (field.name)}
			<div class="min-w-0">
				<dt class="text-xs font-medium leading-4 text-muted-foreground">
					{field.label ?? humanize(field.name)}
				</dt>
				<dd class="mt-0.5 min-w-0 break-words text-sm leading-5">
					{#if field.kind === 'json'}
						<pre
							class="whitespace-pre-wrap break-words font-mono text-xs leading-5">{formatRawStructuredValue(
								Reflect.get(record, field.name)
							)}</pre>
					{:else}
						<DataRenderer {field} value={Reflect.get(record, field.name)} mode="display" />
					{/if}
				</dd>
			</div>
		{/each}
	</Grid>
{/snippet}

{#snippet rawDetails()}
	{#if activeRecord}
		<Stack gap="md">
			{#if rawRecordFields.length > 0}
				{@render rawFieldGrid({
					record: activeRecord,
					fields: rawRecordFields,
					className: 'rounded-lg border bg-card p-3'
				})}
			{/if}
			{#if rawSystemFields.length > 0}
				<details class="group rounded-lg border bg-muted/15">
					<summary
						class="cursor-pointer list-none rounded-lg px-3 py-2.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
					>
						<Inline gap="sm" justify="between">
							<Inline gap="sm">
								<Icon
									icon="lucide:database"
									class="size-3.5 text-muted-foreground"
									aria-hidden="true"
								/>
								<span class="text-sm font-medium">{t('table.systemFields')}</span>
								<span class="text-xs text-muted-foreground">{rawSystemFields.length}</span>
							</Inline>
							<Icon
								icon="lucide:chevron-down"
								class="size-4 text-muted-foreground transition-transform group-open:rotate-180"
								aria-hidden="true"
							/>
						</Inline>
					</summary>
					{@render rawFieldGrid({
						record: activeRecord,
						fields: rawSystemFields,
						className: 'border-t p-3'
					})}
				</details>
			{/if}
		</Stack>
	{/if}
{/snippet}

{#snippet recordSurface({ recordId, actions }: CollectionTableDetailRenderContext)}
	<CollectionRecordDetailTabs
		title={activeRecord ? recordTitle(activeRecord) : humanize(String(collection))}
		description={t('table.recordDetails', { name: humanize(String(collection)) })}
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
<Bound size="full" class="collection-table-responsive min-h-[24rem] w-full" data-collection-table-surface>
	<!--
		One toolbar and one pagination bar for both halves of the surface. The wide grid and the narrow
		list show the same page of the same query; only their body differs, so only their body is
		rendered twice.
	-->
	<!--
		The table is its own tab content box when `rootClass` supplies the outline: toolbar, body and
		pagination share one border, and `borderless` drops the grid's own inner border so there is
		exactly one line around the whole surface rather than two. The box hugs its content — no
		forced fill, so a height-chain break can never collapse it out of view.
	-->
	<Cover as="div" gap="sm" top={toolbar} bottom={paginationBar} class={rootClass}>
		<CollectionGrid
			table={tableApi}
			{disabled}
			class={cn('collection-table-wide', className)}
			isLoading={tableLoading}
			error={errorMessage}
			getRowLeadingAccent={rowLeadingAccent}
			{activeRecordId}
			rowActions={gridRowActions}
			rowIndexOffset={queryState.pageIndex * queryState.pageSize}
			stickyRowActions={true}
			borderless={borderless}
			{emptyPlaceholder}
		/>

		<CollectionTableList
			rows={listRows}
			loading={tableLoading}
			error={errorMessage}
			selectable={effectiveSelectable}
			{disabled}
			class={cn('collection-table-narrow', className)}
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
		/>
	</Cover>
</Bound>

<Sheet.Root bind:open={createOpen}>
	<Sheet.Content flush class="sm:max-w-xl">
		<Sheet.Header class="shrink-0 border-b px-5 py-4">
			<Sheet.Title>{createLabel}</Sheet.Title>
			<Sheet.Description class="sr-only">
				{t('table.createFormDescription', { label: createLabel })}
			</Sheet.Description>
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
			<Dialog.Title>{t('table.requestChanges')}</Dialog.Title>
			<Dialog.Description>{t('table.requestChangesDescription')}</Dialog.Description>
		</Dialog.Header>
		<label class="grid gap-1.5 text-sm font-medium">
			{t('table.changeRequestReason')}
			<Textarea
				value={changeRequestReason}
				placeholder={t('table.describeChangesPlaceholder')}
				maxlength={1000}
				required
				oninput={(event) => updateChangeRequestReason(event.currentTarget.value)}
			/>
		</label>
		<Dialog.Footer>
			<Dialog.Close disabled={approvalActionPending}>{t('common.cancel')}</Dialog.Close>
			<Button
				disabled={approvalActionPending || changeRequestReason.trim().length === 0}
				onclick={() => void requestChanges()}
			>
				{approvalActionPending ? t('table.requesting') : t('table.requestChanges')}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<style>
	/* These classes are forwarded to child-component roots. They must be global:
	   a scoped selector carries this component's Svelte hash, which those roots do
	   not, and leaves both responsive variants painted on top of each other. */
	:global(.collection-table-narrow) {
		display: none;
	}

	@container (max-width: 47.999rem) {
		:global(.collection-table-wide) {
			display: none;
		}

		:global(.collection-table-narrow) {
			display: grid;
		}
	}
</style>
