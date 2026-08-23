<script
	lang="ts"
	generics="TCollections extends CollectionRegistry = CollectionRegistry, TName extends CollectionName<TCollections> = CollectionName<TCollections>, TRow extends object = CollectionTableRow<TCollections, TName>"
>
	import type {
		CollectionDefinition,
		CollectionField,
		CollectionFieldName,
		CollectionOperations,
		CollectionQuery,
		CollectionRegistry,
		CollectionType,
		CollectionRecord
	} from '@norbital-ai/std/collection';
	import { resolveRecordLabel } from '@norbital-ai/std/collection';
	import { humanize } from '@norbital-ai/std/string';
	import Icon from '@iconify/svelte';
	import { Number as Number_ } from 'effect';
	import { onMount } from 'svelte';
	import * as Popover from '#lib/popover';
	import * as Sheet from '#lib/sheet';
	import { cn, renderSnippet, RenderComponentConfig, RenderSnippetConfig } from '#lib/utils';
	import { useI18n, type UiKeys } from '#lib/i18n';
	import { DataRenderer } from '#lib/data-renderer';
	import { formatDataValue, type Translate } from '#lib/data-renderer';
	import { Cover, Inline, Stack, Bound } from '#lib/layout';
	import { CollectionQueryState } from '#lib/collection-query';
	import {
		CollectionActionToolbar,
		CollectionPagination,
		type CollectionToolbarComposition
	} from '#lib/collection-toolbar';
	import { CollectionForm } from '#lib/collection-form';
	import {
		collectionRecordMetadataDescription,
		type ResolvedCollectionRecordMetadata
	} from '#lib/collection-record-metadata';
	import {
		createActionLabel,
		deriveAutoCard,
		formatAutoCardBadge,
		formatAutoCardField,
		formatAutoCardSubtitle,
		isSystemField,
		resolvedRecordMetadataFor,
		type AutoCardModel
	} from '#lib/collection-table/collection-card-derivation';
	import { toast } from 'svelte-sonner';
	import { watch } from 'runed';
	import CollectionTablePart, {
		setCollectionTablePartContext
	} from './collection-table-part.svelte';
	import CollectionGrid from './internal/collection-grid.svelte';
	import CollectionTableList from './collection-table-list.svelte';
	import CollectionTableAppliedFilters from './collection-table-applied-filters.svelte';
	import {
		createCollectionTableRouteKey,
		getCollectionTableNavigationContext
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
	} from '#lib/collection-table/collection-table.types';
	import { collectionTableColumnCanSort } from '#lib/collection-table/collection-table.types';
	import { badgeColorClass } from '#lib/collection-table/collection-card-colors';

	const COLUMN_WIDTH_BOUNDS: Readonly<Record<string, readonly [number, number]>> = {
		boolean: [72, 112],
		clock_time: [96, 144],
		date: [120, 168],
		timestamp: [168, 240],
		timestamptz: [168, 240],
		datetime: [168, 240],
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
		setCollectionClientContext,
		setCollectionRecordScope
	} from '#lib/collection-runtime';

	type Row = TRow;
	type ColumnConfig = CollectionTableColumn<Row>;

	interface GridRow extends Record<string, unknown> {
		__collectionTableRowId: string;
		record: Row;
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
	const operations = $derived(
		client.db[collection] as CollectionOperations<CollectionType<Row, object, object>> // stupidity: boundary-cast — Svelte's generic component boundary erases the inferred collection row.
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
		createCollectionTableRouteKey({
			view: resolvedView
		})
	);
	onMount(() => surfaceRuntime?.claimView(resolvedView));
	const detailNavigation = getCollectionTableNavigationContext();
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

	function resolvedRecordMetadata(record: Row): readonly ResolvedCollectionRecordMetadata[] {
		return resolvedRecordMetadataFor(record, recordMetadata, t as Translate);
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
		registeredColumns.length === 0
			? t('table.metadataError', { collection: String(collection) })
			: ''
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
			t as Translate
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
		// Index the registered columns once per derived computation instead of re-searching the
		// list for every entry in the sort array.
		const columnsByKey = new Map(registeredColumns.map((column) => [String(column.key), column]));
		return tableApi.sort.current.reduce<NonNullable<CollectionQuery<Row>['orderBy']>>(
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
			{ roles: cardRoles, hasRecordLabel: Boolean(definition.recordLabel) }
		)
	);

	const createEnabled = $derived(features.create !== false);
	const operationsEnabled = $derived(
		exportPipelines.length > 0 || importPipelines.length > 0 || integrations.length > 0
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
		const column = registeredColumns.find((candidate) => String(candidate.key) === name);
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
				search: queryState.search || undefined,
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
				search: queryState.search || undefined,
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

	function recordId(row: Row): string {
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
		() => ({ rows: pageRows, columns: registeredColumns }),
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

	function flagMarkerClass(
		metadata: Extract<ResolvedCollectionRecordMetadata, { readonly kind: 'flag' }>
	): string {
		switch (metadata.tone) {
			case 'info':
				return 'w-1 bg-info';
			case 'success':
				return 'w-1 bg-success';
			case 'warning':
				return 'w-1 bg-warning';
			case 'danger':
				return 'w-1 bg-destructive';
			case 'neutral':
				return 'w-1 bg-muted-foreground';
		}
	}

	/** One compact marker on the dense grid; list and Kanban surfaces render every metadata item. */
	function rowLeadingAccent(row: GridRow): { markerClass: string; tooltip: string } | null {
		const metadata = resolvedRecordMetadata(row.record);
		const primary = metadata[0];
		if (!primary) return null;
		const tooltip = metadata.map(collectionRecordMetadataDescription).join(' • ');
		if (primary.kind === 'flag') return { markerClass: flagMarkerClass(primary), tooltip };
		return {
			markerClass:
				primary.source === 'system'
					? 'inset-y-1 w-1 rounded-r-full bg-brand'
					: 'w-px bg-muted-foreground',
			tooltip
		};
	}

	function recordActionTabIndex(hovered: boolean, active: boolean): 0 | -1 {
		return hovered || active ? 0 : -1;
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
			hovered,
			metadata: resolvedRecordMetadata(row.raw.record)
		}}
		{@render action(context)}
	{/each}
{/snippet}

{#snippet openRecordAction({ row, hovered }: { row: RowAPI<GridRow, unknown>; hovered: boolean })}
	{@const isDetailActive = activeRecordId === row.id}
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

{#snippet toolbarActions({ Action }: CollectionToolbarComposition<Row>)}
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
	<Action
		label={t('table.refreshCollectionData')}
		icon="lucide:refresh-cw"
		iconOnly
		pending={rowsQuery?.loading === true || countQuery?.loading === true}
		unavailable={disabled ? t('table.viewDisabled') : undefined}
		onRun={() => {
			void rowsQuery?.refresh();
			void countQuery?.refresh();
		}}
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
			<span
				class={cn(
					'inline-flex max-w-full shrink-0 items-center gap-1 truncate rounded-full border px-2 py-0.5 text-xs font-medium',
					badgeColorClass()
				)}>{badge.label}</span
			>
		{/if}
	</Inline>
{/snippet}

<div class="hidden" aria-hidden="true">
	{@render columns({ Column: CollectionTablePart })}
</div>

<Bound
	size="full"
	class="collection-table-responsive min-h-[24rem] w-full"
	data-collection-table-surface
>
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
			{borderless}
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
				<CollectionForm
					{client}
					{collection}
					onAfterSubmit={() => {
						createOpen = false;
					}}
				/>
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
