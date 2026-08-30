<script
	lang="ts"
	generics="TCollections extends CollectionRegistry = CollectionRegistry, TName extends CollectionName<TCollections> = CollectionName<TCollections>, TRow extends object = CollectionTableRow<TCollections, TName>"
>
	import type {
		CollectionDefinition,
		CollectionField,
		CollectionOperations,
		CollectionQuery,
		CollectionRegistry,
		CollectionType
	} from '@norbital-ai/std/collection';
	import { isSystemCollectionField, labelTermText } from '@norbital-ai/std/collection';
	import { humanize } from '@norbital-ai/std/string';
	import Icon from '@iconify/svelte';
	import { Number as Number_ } from 'effect';
	import { onDestroy, onMount } from 'svelte';
	import * as Sheet from '#lib/sheet';
	import { cn, renderSnippet } from '#lib/utils';
	import { useI18n } from '#lib/i18n';
	import { DataRenderer, formatDataValue, type FieldRendererComponent } from '#lib/data-renderer';
	import { Cover, Stack, Bound } from '#lib/layout';
	import { CollectionQueryState } from '#lib/collection-query';
	import {
		CollectionActionToolbar,
		CollectionPagination,
		type CollectionToolbarComposition
	} from '#lib/collection-toolbar';
	import {
		collectionRecordLeadingAccent,
		type ResolvedCollectionRecordMetadata
	} from '#lib/collection-record-metadata';
	import {
		createCollectionActionLabel,
		deriveAutoCard,
		resolvedCollectionRecordMetadata,
		type AutoCardModel
	} from '#lib/collection-surface';
	import { toast } from 'svelte-sonner';
	import { watch } from 'runed';
	import CollectionTablePart, {
		setCollectionTablePartContext
	} from './collection-table-part.svelte';
	import CollectionGrid from './internal/collection-grid.svelte';
	import CollectionTableList from './collection-table-list.svelte';
	import { CollectionAppliedFilters } from '#lib/collection-filter';
	import {
		createCollectionRouteKey,
		getCollectionNavigationContext
	} from '#lib/collection-navigation/collection-navigation.svelte';
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
		CollectionTableColumnsComposition,
		CollectionTableProps,
		CollectionTableRow,
		CollectionTableRowActionContext
	} from '#lib/collection-table/collection-table.types';
	import { collectionTableColumnCanSort } from '#lib/collection-table/collection-table.types';

	const COLUMN_WIDTH_BOUNDS: Readonly<Record<string, readonly [number, number]>> = {
		boolean: [72, 112],
		instant: [168, 240],
		money: [120, 184],
		numeric: [88, 168],
		number: [88, 168],
		integer: [80, 144],
		enum: [104, 224],
		file: [144, 288],
		uuid: [160, 288],
		text: [120, 360],
		string: [120, 360],
		phone: [128, 208]
	};

	function fitCollectionColumnWidth(
		field: CollectionField,
		formattedValues: readonly string[],
		header: string,
		measure: (text: string) => number = (text) => text.length * 7.5
	): number {
		const [kindMin, kindMax] = field.relation
			? [144, 288]
			: (COLUMN_WIDTH_BOUNDS[field.kind] ?? [120, 320]);
		const widest = Math.max(
			measure(header) + 64,
			...formattedValues.map((value) => measure(value) + 32)
		);
		return Math.ceil(Number_.clamp({ minimum: kindMin, maximum: kindMax })(widest));
	}
	import {
		getCollectionClientForSurface,
		getCollectionRecordScope,
		getCollectionSurfaceRuntime,
		resolveCollectionSurface,
		resolveCollectionViewKey,
		setCollectionClientContext
	} from '#lib/collection-runtime';

	type ColumnConfig = CollectionTableColumn<TRow>;

	interface GridRow extends Record<string, unknown> {
		__collectionTableRowId: string;
		record: TRow;
	}

	let {
		client,
		collection,
		view,
		query,
		initialFilters = [],
		disabled = false,
		recordMetadata,
		selectable = false,
		class: className,
		rootClass,
		borderless = false,
		bounded = true,
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
	const { t } = useI18n();
	const surfaceRuntime = getCollectionSurfaceRuntime();
	const collectionSurface = $derived(
		resolveCollectionSurface(surfaceRuntime?.surfaces, String(collection))
	);

	const definition = $derived(
		workspaceClient.collections[String(collection)] as CollectionDefinition<
			CollectionType<TRow, object>
		> // stupidity: boundary-cast — the generated client and runtime manifest share collection keys.
	);
	const operations = $derived(
		client.db[collection] as unknown as CollectionOperations<CollectionType<TRow, object>> // stupidity: boundary-cast — Svelte's generic component boundary erases the inferred collection row override; the client key remains constrained by TName.
	);
	const recordIdField = 'id';
	const recordScope = getCollectionRecordScope();
	const resolvedView = $derived(
		resolveCollectionViewKey(
			view,
			`${surfaceRuntime?.appId() ?? 'unhosted'}:${String(collection)}`,
			recordScope?.()
		)
	);
	const resolvedDetailRouteKey = $derived(
		createCollectionRouteKey({
			view: resolvedView
		})
	);
	onMount(() => surfaceRuntime?.claimView(resolvedView));
	const detailNavigation = getCollectionNavigationContext();
	// svelte-ignore state_referenced_locally -- this table's route identity is fixed for its mount.
	const releaseDetailClient = detailNavigation?.registerDetailClient(
		resolvedDetailRouteKey,
		workspaceClient
	);
	onDestroy(() => releaseDetailClient?.());
	const searchEnabled = $derived(features.search !== false);
	const filterEnabled = $derived(features.filter !== false);
	const effectiveSelectable = $derived(
		selectable ||
			exportPipelines.some((pipeline) => pipeline.requiresSelection) ||
			importPipelines.some((pipeline) => pipeline.requiresSelection)
	);
	let registeredColumns: readonly ColumnConfig[] = $state([]);
	let initialFitApplied = $state(false);
	let cursors = $state<Array<string | undefined>>([undefined]);
	const configuredColumns = new Map<object, ColumnConfig>();

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

	function resolvedRecordMetadata(record: TRow): readonly ResolvedCollectionRecordMetadata[] {
		return resolvedCollectionRecordMetadata(record, recordMetadata, t);
	}
	/**
	 * The one search + filter + page model this table runs on.
	 *
	 * `TableAPI` used to hold a second copy of the search string and the page, and every narrowing
	 * had to remember to call `resetToFirstPage()` before it took effect. The reset is a property of
	 * the model, not a courtesy each handler pays it, so it lives in `CollectionQueryState` now and
	 * the table only keeps what is genuinely its own: the cursor for each page it has visited.
	 */
	// svelte-ignore state_referenced_locally
	const queryState = new CollectionQueryState<TRow>({
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
		registeredColumns.length === 0
			? t('table.metadataError', { collection: String(collection) })
			: ''
	);

	function metadataFor(column: ColumnConfig): CollectionField<Extract<keyof TRow, string>> {
		const field = definition.fields.find((candidate) => candidate.name === column.key);
		if (!field) {
			throw new Error(
				`CollectionTable "${String(collection)}" declares unknown column "${String(column.key)}".`
			);
		}
		if (isSystemCollectionField(field.name)) {
			throw new Error(
				`CollectionTable "${String(collection)}" cannot declare framework field "${field.name}".`
			);
		}
		return field;
	}

	function renderCell(column: ColumnConfig, row: TRow) {
		const value = Reflect.get(row, column.key);
		return renderSnippet(defaultCell, { column, row, value });
	}

	const gridColumns = $derived.by((): TCreateColumnProps<GridRow, unknown>[] =>
		withSelectionColumn(
			registeredColumns.map((column) => {
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
			t
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

	const orderBy = $derived.by((): CollectionQuery<TRow>['orderBy'] => {
		if (tableApi.sort.current.length === 0) return undefined;
		// Index the registered columns once per derived computation instead of re-searching the
		// list for every entry in the sort array.
		const columnsByKey = new Map(registeredColumns.map((column) => [String(column.key), column]));
		return tableApi.sort.current.reduce<NonNullable<CollectionQuery<TRow>['orderBy']>>(
			(result, entry) => {
				const fieldName = entry.field.startsWith('default.')
					? entry.field.slice('default.'.length)
					: entry.field;
				const column = columnsByKey.get(fieldName);
				return column ? { ...result, [column.key]: entry.order } : result;
			},
			{}
		);
	});
	const defaultOrderBy = $derived(query?.orderBy);
	const showAbout = $derived(Boolean(description || query?.where));

	// Auto card-role hints from column annotations, filled by field structure where unset (RFC V.2d).
	const cardRoles = $derived({
		title: registeredColumns.find((column) => column.card === 'title')?.key as string | undefined,
		subtitle: registeredColumns
			.filter((column) => column.card === 'subtitle')
			.map((column) => String(column.key)),
		badge: registeredColumns.find((column) => column.card === 'badge')?.key as string | undefined
	});
	const autoCard: AutoCardModel = $derived(
		deriveAutoCard(
			definition.fields,
			registeredColumns.map((column) => String(column.key)),
			{ roles: cardRoles }
		)
	);

	const createEnabled = $derived(features.create !== false);
	const operationsEnabled = $derived(
		exportPipelines.length > 0 || importPipelines.length > 0 || integrations.length > 0
	);
	const createLabel = $derived(createCollectionActionLabel(String(collection), t));

	const automaticRelationshipWith = $derived.by(() =>
		Object.fromEntries(
			registeredColumns.flatMap((column) => {
				const relation = metadataFor(column).relation;
				return relation ? [[relation.name, true] as const] : [];
			})
		)
	);

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
			cursors = [undefined];
			queryState.setPageIndex(0);
		}
	);

	const rowsQueryInput = $derived.by(() => {
		if (disabled) return null;
		return {
			operations,
			query: {
				...query,
				with: { ...automaticRelationshipWith, ...(query?.with ?? {}) },
				search:
					queryState.search === ''
						? undefined
						: { mode: 'lexical' as const, term: queryState.search },
				orderBy: orderBy ?? defaultOrderBy,
				limit: queryState.pageSize,
				after: cursors[queryState.pageIndex]
			},
			filterOptions: queryState.queryOptions
		};
	});
	const rowsQuery = $derived(
		rowsQueryInput
			? rowsQueryInput.operations.findMany(rowsQueryInput.query, rowsQueryInput.filterOptions)
			: null
	);
	const pageRows = $derived(rowsQuery?.current);

	/**
	 * The cursor for the next page is learned as soon as this one loads, rather than at the moment
	 * someone presses "next". The shared pagination bar moves the page index and knows nothing about
	 * cursors — it should not have to.
	 */
	watch(
		() => ({ pageIndex: queryState.pageIndex, cursor: rowsQuery?.nextCursor }),
		({ pageIndex, cursor }) => {
			if (cursor) cursors[pageIndex + 1] = cursor;
		},
		{ lazy: false }
	);

	const countQueryInput = $derived.by(() => {
		if (disabled) return null;
		return {
			operations,
			query: {
				where: query?.where,
				search:
					queryState.search === ''
						? undefined
						: { mode: 'lexical' as const, term: queryState.search },
				columns: query?.columns,
				bypass_secret: query?.bypass_secret
			},
			filterOptions: queryState.queryOptions
		};
	});
	const countQuery = $derived(
		countQueryInput
			? countQueryInput.operations.count(countQueryInput.query, countQueryInput.filterOptions)
			: null
	);
	let columnTextMeasurement = $state.raw<{
		readonly ready: boolean;
		readonly measure?: (text: string) => number;
	}>({ ready: false });
	onMount(() => {
		const context = document.createElement('canvas').getContext('2d');
		if (context) context.font = '13px "Geist Variable", ui-sans-serif, system-ui, sans-serif';
		columnTextMeasurement = {
			ready: true,
			...(context ? { measure: (text: string) => context.measureText(text).width } : {})
		};
	});

	function recordId(row: TRow): string {
		const value = Reflect.get(row, recordIdField);
		if (typeof value !== 'string' || value.length === 0) {
			throw new Error('CollectionTable records require a id.');
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
		() => ({ rows: pageRows, columns: registeredColumns, measurement: columnTextMeasurement }),
		({ rows, columns, measurement }) => {
			if (initialFitApplied || !measurement.ready || !rows || columns.length === 0) return;
			const widths = Object.fromEntries(
				columns.map((column) => {
					const field = metadataFor(column);
					const header = column.label ?? field.label ?? humanize(column.key);
					const values = rows.map((row) =>
						formatDataValue(field, Reflect.get(row, column.key), undefined, t)
					);
					return [
						String(column.key),
						column.width ?? fitCollectionColumnWidth(field, values, header, measurement.measure)
					];
				})
			);
			tableApi.setContentFitWidths(widths, true);
			initialFitApplied = true;
		},
		{ lazy: false }
	);

	watch(
		() => countQuery?.current,
		(total) => tableApi.setTotalRows(total ?? 0),
		{ lazy: false }
	);

	const gridRowActions = $derived([
		openRecordAction,
		...(rowActions?.length ? [gridRowAction] : [])
	]);
	const errorMessage = $derived(
		rowsQuery?.error?.message ?? countQuery?.error?.message ?? metadataError
	);
	const activeRecordId = $derived(
		detailNavigation?.resolveRecordId({
			collectionName: String(collection),
			routeKey: resolvedDetailRouteKey
		})
	);
	// A missing query resource or an undefined first value is still "unknown", never an empty
	// collection. Keep the loader visible until the first locally-synced or server-proven result
	// arrives; only a resolved [] may render the empty state.
	const tableLoading = $derived(
		!disabled && (rowsQuery == null || (rowsQuery.current === undefined && rowsQuery.error == null))
	);
	const selectedRecords = $derived(
		tableApi.data
			.filter((row) => tableApi.rowSelection.current[row.__collectionTableRowId])
			.map((row) => row.record)
	);
	let createOpen = $state(false);

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

	/** One compact marker on the dense grid; list and Kanban surfaces render every metadata item. */
	function rowLeadingAccent(row: GridRow): { markerClass: string; tooltip: string } | null {
		return collectionRecordLeadingAccent(resolvedRecordMetadata(row.record));
	}

	function recordActionTabIndex(hovered: boolean, active: boolean): 0 | -1 {
		return hovered || active ? 0 : -1;
	}

	function recordTitle(record: TRow): string {
		if (autoCard.title.kind !== 'field') return humanize(String(collection));
		return labelTermText(Reflect.get(record, autoCard.title.name)) ?? humanize(String(collection));
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

{#snippet defaultCell({ column, row, value }: { column: ColumnConfig; row: TRow; value: unknown })}
	<DataRenderer
		field={metadataFor(column)}
		{value}
		row={row as Record<string, unknown>}
		mode="display"
		renderer={column.renderer as FieldRendererComponent | undefined}
		rendererProps={column.rendererProps as Readonly<Record<string, unknown>> | undefined}
		relationOptions={column.relationOptions}
	/>
{/snippet}

{#snippet gridRowAction({ row, hovered }: { row: RowAPI<GridRow, unknown>; hovered: boolean })}
	{#each rowActions ?? [] as action}
		{@const context: CollectionTableRowActionContext<TRow> = {
			row: row.raw.record,
			hovered,
			metadata: resolvedRecordMetadata(row.raw.record)
		}}
		{@render action(context)}
	{/each}
{/snippet}

{#snippet openRecordAction({ row, hovered }: { row: RowAPI<GridRow, unknown>; hovered: boolean })}
	{@const { id: recordId } = row}
	{@const isDetailActive = activeRecordId === recordId}
	<button
		type="button"
		aria-label={t('table.detailOpen')}
		aria-pressed={isDetailActive}
		tabindex={recordActionTabIndex(hovered, isDetailActive)}
		class={cn(
			'inline-flex size-8 items-center justify-center rounded-md border border-border bg-card text-muted-foreground shadow-xs outline-none transition-colors hover:bg-muted hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
			isDetailActive && 'border-brand/40 bg-accent text-accent-foreground',
			!isDetailActive && !hovered && 'opacity-0'
		)}
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

{#snippet toolbarActions({ Action }: CollectionToolbarComposition<TRow>)}
	{#if createEnabled}
		<Action
			label={createLabel}
			icon="lucide:plus"
			variant="default"
			pending={operations.pending > 0}
			unavailable={disabled ? t('table.viewDisabled') : undefined}
			onRun={() => {
				createOpen = true;
			}}
		/>
	{/if}
{/snippet}

{#snippet toolbar()}
	{#snippet appliedFilters()}
		<CollectionAppliedFilters
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
					disabled: operations.pending > 0
				}
			: undefined}
		actions={toolbarActions}
	/>
{/snippet}

{#snippet paginationBar()}
	<CollectionPagination
		query={queryState}
		total={tableApi.totalRows}
		hasNextPage={Boolean(rowsQuery?.nextCursor)}
		{disabled}
		selectedCount={effectiveSelectable ? selectedRecords.length : undefined}
	/>
{/snippet}

{#snippet autoListCard(record: TRow)}
	<Stack gap="xs">
		{@const titleName = autoCard.title.kind === 'field' ? autoCard.title.name : null}
		{#if titleName}
			{@const titleColumn = registeredColumns.find((column) => String(column.key) === titleName)}
			{#if titleColumn}
				<DataRenderer
					field={metadataFor(titleColumn)}
					value={Reflect.get(record, titleColumn.key)}
					row={record as Record<string, unknown>}
					mode="display"
					renderer={titleColumn.renderer as FieldRendererComponent | undefined}
					rendererProps={titleColumn.rendererProps as Readonly<Record<string, unknown>> | undefined}
					relationOptions={titleColumn.relationOptions}
				/>
			{/if}
		{:else}
			<p class="flex min-h-9 items-center text-sm font-medium">{humanize(String(collection))}</p>
		{/if}
		{#each [...autoCard.subtitles, ...(autoCard.badge ? [autoCard.badge] : [])] as name (name)}
			{@const cardColumn = registeredColumns.find((column) => String(column.key) === name)}
			{#if cardColumn && (autoCard.title.kind !== 'field' || name !== autoCard.title.name)}
				<DataRenderer
					field={metadataFor(cardColumn)}
					value={Reflect.get(record, cardColumn.key)}
					row={record as Record<string, unknown>}
					mode="display"
					renderer={cardColumn.renderer as FieldRendererComponent | undefined}
					rendererProps={cardColumn.rendererProps as Readonly<Record<string, unknown>> | undefined}
					relationOptions={cardColumn.relationOptions}
				/>
			{/if}
		{/each}
	</Stack>
{/snippet}

<div class="hidden" aria-hidden="true">
	{@render columns({
		Column: CollectionTablePart as unknown as CollectionTableColumnsComposition<TRow>['Column']
	})}
</div>

<Bound
	size="full"
	class="collection-table-responsive min-h-[24rem] w-full"
	style={bounded ? undefined : 'height: auto; max-height: none;'}
	data-collection-table-surface
	data-collection-table-bounded={bounded ? 'true' : 'false'}
>
	<!--
		One toolbar and one pagination bar for both halves of the surface. The wide grid and the narrow
		list show the same page of the same query; only their body differs, so only their body is
		rendered twice.
	-->
	<!--
		The table is its own tab content box when `rootClass` supplies the outline: toolbar, body and
		pagination share one border, and `borderless` drops the grid's own inner border so there is
		exactly one line around the whole surface rather than two. An unbounded table lets this box hug
		its content so a record-detail scrollport can own the vertical axis; a bounded application
		surface keeps the fixed height chain needed for virtual rows.
	-->
	<Cover
		as="div"
		gap="sm"
		top={toolbar}
		bottom={paginationBar}
		class={rootClass}
		style={bounded ? undefined : 'height: auto; max-height: none;'}
	>
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
			{borderless}
			{bounded}
			{emptyPlaceholder}
		/>

		<CollectionTableList
			rows={listRows}
			loading={tableLoading}
			error={errorMessage}
			selectable={effectiveSelectable}
			{disabled}
			{bounded}
			class={cn('collection-table-narrow', className)}
			ListCard={ListCard ?? autoListCard}
			{emptyPlaceholder}
			{rowActions}
			getRecordMetadata={resolvedRecordMetadata}
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
					close={() => {
						createOpen = false;
					}}
				/>
			{:else}
				<p class="text-sm text-destructive" role="alert">
					Collection "{String(collection)}" requires an explicit representation to create records.
				</p>
			{/if}
		</div>
	</Sheet.Content>
</Sheet.Root>

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
