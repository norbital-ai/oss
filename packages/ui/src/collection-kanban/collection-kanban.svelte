<script
	lang="ts"
	generics="TCollections extends CollectionRegistry, TName extends CollectionKanbanName<TCollections>"
>
	import { getErrorMessage, toError } from '@norbital-ai/std';
	import type {
		CollectionDefinition,
		CollectionField,
		CollectionRegistry,
		CollectionRow
	} from '@norbital-ai/std/collection';
	import { isSystemCollectionField } from '@norbital-ai/std/collection';
	import { humanize } from '@norbital-ai/std/string';
	import { Cover, Grid, Scroll, Stack } from '#lib/layout';
	import { cn } from '#lib/utils';
	import { useI18n } from '#lib/i18n';
	import { onMount } from 'svelte';
	import { Effect } from 'effect';
	import {
		getCollectionClientForSurface,
		getCollectionRecordScope,
		getCollectionSurfaceRuntime,
		resolveCollectionViewKey,
		setCollectionClientContext
	} from '#lib/collection-runtime';
	import {
		createCollectionRouteKey,
		getCollectionNavigationContext
	} from '#lib/collection-navigation/collection-navigation.svelte';
	import {
		deriveAutoCard,
		resolvedCollectionRecordMetadata,
		type AutoCardModel
	} from '#lib/collection-surface';
	import {
		deriveLanes,
		mergeAuthoredLanes,
		parseAuthoredLaneValues
	} from './collection-kanban-lanes.js';
	import { DataRenderer, type FieldRendererComponent } from '#lib/data-renderer';
	import CollectionKanbanSkeleton from './collection-kanban-skeleton.svelte';
	import CollectionKanbanLane from './collection-kanban-lane.svelte';
	import CollectionKanbanPart, {
		setCollectionKanbanPartContext
	} from './collection-kanban-part.svelte';
	import { CollectionQueryState } from '#lib/collection-query';
	import { CollectionActionToolbar } from '#lib/collection-toolbar';
	import {
		CollectionRecordMetadataView,
		collectionRecordLeadingAccent,
		collectionRecordMutationReason,
		type ResolvedCollectionRecordMetadata
	} from '#lib/collection-record-metadata';
	import type {
		CollectionKanbanField,
		CollectionKanbanFieldsComposition,
		CollectionKanbanName,
		CollectionKanbanProps
	} from '#lib/collection-kanban/collection-kanban.types';

	type Row = CollectionRow<TCollections[TName]>;
	type FieldConfig = CollectionKanbanField<Row>;
	/**
	 * The board is one live prefix, grouped here by the lane field. Live, so another person's move
	 * arrives without a refresh; one prefix, so the optimistic overlay the sync engine already paints
	 * on every live read moves a card the moment `update` is called and moves it back by itself if
	 * the authority refuses — no lane override map, no reconciliation, no rollback. The old grouped
	 * read was answered once and never registered, which is why all three existed.
	 */
	// ponytail: one 500-row prefix for the whole board; a board past that wants pagination per lane,
	// which is a per-lane live query with its own limit, not a bigger prefix.
	const BOARD_ROW_LIMIT = 500;

	let {
		client,
		collection,
		view,
		groupBy,
		lanes,
		rows = 1,
		query: collectionQuery,
		recordMetadata,
		selectable = false,
		title,
		description,
		navigation,
		exportPipelines = [],
		importPipelines = [],
		bulkPipelines = [],
		integrations = [],
		fields,
		Card,
		onCardMove,
		class: className
	}: CollectionKanbanProps<TCollections, TName> = $props();
	// svelte-ignore state_referenced_locally -- a mounted collection surface keeps one generated client.
	const workspaceClient = getCollectionClientForSurface(client, 'CollectionKanban');
	setCollectionClientContext(() => workspaceClient);
	const { t } = useI18n();
	const surfaceRuntime = getCollectionSurfaceRuntime();
	const recordScope = getCollectionRecordScope();
	const resolvedView = $derived(
		resolveCollectionViewKey(
			view,
			`${surfaceRuntime?.appId() ?? 'unhosted'}:${String(collection)}`,
			recordScope?.()
		)
	);
	onMount(() => surfaceRuntime?.claimView(resolvedView));
	const definition = $derived(
		workspaceClient.collections[String(collection)] as CollectionDefinition<TCollections[TName]> // stupidity: boundary-cast — the generated client and runtime manifest share collection keys.
	);
	// Lane moves are one `update` per card; a collection with no declared write has no surface here.
	const writes = $derived(client.collection[collection]);
	const writePending = $derived((writes?.pending ?? 0) > 0);
	const recordIdField = 'id';
	const effectiveSelectable = $derived(
		selectable ||
			exportPipelines.some((pipeline) => pipeline.requiresSelection) ||
			importPipelines.some((pipeline) => pipeline.requiresSelection) ||
			bulkPipelines.some((pipeline) => pipeline.requiresSelection)
	);
	const resolvedDetailRouteKey = $derived(
		createCollectionRouteKey({
			view: resolvedView
		})
	);
	const detailNavigation = getCollectionNavigationContext();
	const configuredFields = new Map<object, FieldConfig>();
	let registeredFields: readonly FieldConfig[] = $state([]);

	function syncFields(): void {
		registeredFields = [...configuredFields.values()];
	}

	setCollectionKanbanPartContext({
		setField: (token, field) => {
			configuredFields.set(token, field as FieldConfig);
			syncFields();
		},
		removeField: (token) => {
			configuredFields.delete(token);
			syncFields();
		}
	});

	function metadataFor(fieldConfig: FieldConfig): CollectionField {
		const field = definition.fields.find((candidate) => candidate.name === fieldConfig.key);
		if (!field) {
			throw new Error(
				`CollectionKanban "${String(collection)}" declares unknown field "${String(fieldConfig.key)}".`
			);
		}
		if (isSystemCollectionField(field.name)) {
			throw new Error(
				`CollectionKanban "${String(collection)}" cannot declare framework field "${field.name}".`
			);
		}
		return field;
	}

	// Lane derivation (RFC V.3): authored `lanes` pick/order the subset and override labels/colours;
	// otherwise lanes come from the groupBy field's enum values in model order.
	const groupByField = $derived(definition.fields.find((field) => field.name === groupBy));
	const derivedLanes = $derived(deriveLanes(groupByField));
	const laneMeta = $derived(mergeAuthoredLanes(derivedLanes, lanes));
	const resolvedLaneValues = $derived(
		lanes && lanes.length > 0
			? parseAuthoredLaneValues(lanes)
			: derivedLanes.map((lane) => lane.value)
	);

	// No page size to remember: a board asks for lanes, not pages.
	const queryState = new CollectionQueryState<Row>();
	const automaticRelationshipWith = $derived.by(() =>
		Object.fromEntries(
			registeredFields.flatMap((fieldConfig) => {
				const relation = metadataFor(fieldConfig).relation;
				return relation ? [[relation.name, true] as const] : [];
			})
		)
	);
	const query = $derived(
		client.db[collection].findMany(
			{
				...collectionQuery,
				with: { ...automaticRelationshipWith, ...(collectionQuery?.with ?? {}) },
				search: queryState.search === '' ? collectionQuery?.search : queryState.search,
				orderBy: collectionQuery?.orderBy,
				limit: BOARD_ROW_LIMIT
			},
			queryState.queryOptions
		)
	);
	const boardRows = $derived((query.current ?? []) as readonly Row[]);
	let moveError = $state('');
	let activeDrag: { recordId: string; lane: string } | null = $state(null);
	let selectedRecordIds = $state(new Set<string>());
	const recordById = $derived.by(() => {
		const records = new Map<string, Row>();
		for (const record of boardRows) {
			const id = Reflect.get(record, recordIdField);
			if (id != null) records.set(String(id), record);
		}
		return records;
	});
	const metadataById = $derived.by(() => {
		const metadata = new Map<string, readonly ResolvedCollectionRecordMetadata[]>();
		for (const [recordId, record] of recordById) {
			metadata.set(recordId, resolvedCollectionRecordMetadata(record, recordMetadata, t));
		}
		return metadata;
	});
	const updateRestrictionReasonById = $derived.by(() => {
		const reasons = new Map<string, string>();
		for (const [recordId, metadata] of metadataById) {
			const reason = collectionRecordMutationReason(metadata, 'update');
			if (reason) reasons.set(recordId, reason);
		}
		return reasons;
	});
	const updateRestrictedRecordIds = $derived(new Set(updateRestrictionReasonById.keys()));
	const leadingAccentFor = (recordId: string) =>
		collectionRecordLeadingAccent(metadataById.get(recordId) ?? []);
	// Declared lanes are the columns, in model order, even when empty; a lane field with no
	// declared values takes its columns from the rows. Authored `lanes` name a subset, so a row
	// outside it is not on this board.
	const groups = $derived.by((): Array<[string, Row[], string[]]> => {
		const declared = resolvedLaneValues.length > 0;
		const grouped = new Map(
			resolvedLaneValues.map((lane) => [lane, { records: [] as Row[], recordIds: [] as string[] }])
		);
		for (const record of boardRows) {
			const lane = String(Reflect.get(record, groupBy) ?? '');
			let target = grouped.get(lane);
			if (target === undefined) {
				if (declared) continue;
				target = { records: [], recordIds: [] };
				grouped.set(lane, target);
			}
			target.records.push(record);
			const id = Reflect.get(record, recordIdField);
			if (id != null) target.recordIds.push(String(id));
		}
		return [...grouped.entries()].map(([lane, { records, recordIds }]) => [
			lane,
			records,
			recordIds
		]);
	});
	// A selection is only ever of rows on the board: derived, so a row leaving the prefix leaves it.
	const visibleSelection = $derived(
		new Set([...selectedRecordIds].filter((recordId) => recordById.has(recordId)))
	);
	const selectedRecords = $derived(
		[...visibleSelection].map((recordId) => recordById.get(recordId) as Row)
	);
	const allVisibleSelected = $derived(
		recordById.size > 0 && visibleSelection.size === recordById.size
	);
	const selectionControls = $derived(
		effectiveSelectable
			? {
					totalRows: recordById.size,
					allSelected: allVisibleSelected,
					toggleAll: toggleAllVisible
				}
			: undefined
	);
	const actionsDisabled = $derived(query.loading || writePending);
	const laneLayoutCount = $derived(
		Math.max(groups.length, lanes?.length ?? derivedLanes.length, 1)
	);
	const requestedRowCount = $derived(Number.isFinite(rows) ? Math.max(1, Math.floor(rows)) : 1);
	const resolvedRowCount = $derived(Math.min(requestedRowCount, laneLayoutCount));
	const resolvedColumnCount = $derived(Math.ceil(laneLayoutCount / resolvedRowCount));
	const activeRecordId = $derived(
		detailNavigation?.resolveRecordId({
			collectionName: String(collection),
			routeKey: resolvedDetailRouteKey
		})
	);
	function openRecord(record: Row): void {
		if (!detailNavigation)
			throw new Error('CollectionKanban requires a record navigation provider.');
		const id = Reflect.get(record, recordIdField);
		if (id == null) return;
		detailNavigation.open({
			collectionName: String(collection),
			recordId: String(id),
			routeKey: resolvedDetailRouteKey
		});
	}

	function openRecordById(recordId: string): void {
		const record = recordById.get(recordId);
		if (record) openRecord(record);
	}

	function toggleSelection(recordId: string): void {
		if (!effectiveSelectable) return;
		const next = new Set(selectedRecordIds);
		if (next.has(recordId)) next.delete(recordId);
		else next.add(recordId);
		selectedRecordIds = next;
	}

	function toggleAllVisible(): void {
		selectedRecordIds = allVisibleSelected ? new Set() : new Set(recordById.keys());
	}

	function commitCardMove(
		record: Row,
		fromLane: string,
		toLane: string
	): Effect.Effect<void, Error> {
		const authoredMove = onCardMove;
		if (authoredMove) {
			return authoredMove({ record, fromLane, toLane }).pipe(
				Effect.mapError((cause) => toError(cause))
			);
		}
		// The generated client paints `toLane` on the live prefix the moment `update` is called and
		// unpaints it if the authority refuses; the wait below is only for the message.
		return Effect.gen(function* () {
			const id = Reflect.get(record, recordIdField);
			if (id == null)
				return yield* Effect.fail(new Error(`Cannot move a record without ${recordIdField}.`));
			if (writes === undefined)
				return yield* Effect.fail(
					new Error(`Collection ${String(collection)} declares no update.`)
				);
			const mutation = yield* Effect.tryPromise({
				try: () => writes.update(String(id), { [groupBy]: toLane }),
				catch: (cause) => toError(cause)
			});
			// `await update()` means only that this tab accepted the in-memory overlay. A board move is
			// complete only after the authority accepts (or successfully rebases) it; otherwise a rejected
			// move looks successful until refresh and silently jumps back to its original lane.
			const settlement = yield* Effect.tryPromise({
				try: () => mutation.settlement.wait(),
				catch: (cause) => toError(cause)
			});
			if (settlement.kind === 'accepted' || settlement.kind === 'rebased') return;
			return yield* Effect.fail(
				new Error(
					settlement.kind === 'rejected' ? settlement.message : settlement.quarantine.message
				)
			);
		});
	}

	function moveRecord({
		recordId,
		fromLane,
		toLane
	}: {
		recordId: string;
		fromLane: string;
		toLane: string;
	}): void {
		if (fromLane === toLane || writePending || updateRestrictedRecordIds.has(recordId)) return;
		const record = recordById.get(recordId);
		if (!record) return;
		moveError = '';
		void Effect.runPromise(
			commitCardMove(record, fromLane, toLane).pipe(
				Effect.catch((cause) =>
					Effect.sync(() => {
						moveError = getErrorMessage(cause);
					})
				)
			)
		);
	}

	const cardRoles = $derived.by(() => ({
		title: registeredFields.find((field) => field.card === 'title')?.key,
		subtitle: registeredFields
			.filter((field) => field.card === 'subtitle')
			.map((field) => String(field.key)),
		badge: registeredFields.find((field) => field.card === 'badge')?.key
	}));

	// The card is inferred only from the explicit field declaration, never by enumerating schema.
	const autoCard: AutoCardModel = $derived(
		deriveAutoCard(
			definition.fields,
			registeredFields.map((field) => String(field.key)),
			{ roles: cardRoles }
		)
	);
</script>

{#snippet autoCardField(name: string, record: Row, className?: string)}
	{@const fieldConfig = registeredFields.find((candidate) => String(candidate.key) === name)}
	{#if fieldConfig}
		<DataRenderer
			field={metadataFor(fieldConfig)}
			value={Reflect.get(record, fieldConfig.key)}
			row={record as Record<string, unknown>}
			mode="display"
			class={className}
			renderer={fieldConfig.renderer as FieldRendererComponent | undefined}
			rendererProps={fieldConfig.rendererProps as Readonly<Record<string, unknown>> | undefined}
			relationOptions={fieldConfig.relationOptions}
		/>
	{/if}
{/snippet}

{#snippet autoCardSnippet(record: Row)}
	<Stack gap="xs">
		{#if autoCard.title.kind === 'field'}
			{@render autoCardField(autoCard.title.name, record, 'font-medium')}
		{:else}
			<p class="flex min-h-9 items-center text-sm font-medium">
				{humanize(String(collection))}
			</p>
		{/if}
		{#each [...autoCard.subtitles, ...(autoCard.badge ? [autoCard.badge] : [])] as name (name)}
			{#if autoCard.title.kind !== 'field' || name !== autoCard.title.name}
				{@render autoCardField(name, record)}
			{/if}
		{/each}
	</Stack>
{/snippet}

{#snippet kanbanCard(recordId: string)}
	{@const record = recordById.get(recordId)}
	{#if record}
		{#if Card}{@render Card(record)}{:else}{@render autoCardSnippet(record)}{/if}
	{/if}
{/snippet}

{#snippet kanbanMetadata(recordId: string)}
	<CollectionRecordMetadataView metadata={metadataById.get(recordId) ?? []} />
{/snippet}

{#snippet kanbanToolbar()}
	<Stack gap="xs">
		<CollectionActionToolbar
			{client}
			{collection}
			query={queryState}
			{title}
			about={description ? { description } : undefined}
			{navigation}
			filterPersistenceKey={resolvedView}
			operations={{
				exportPipelines,
				importPipelines,
				bulkPipelines,
				integrations,
				selectedRows: selectedRecords,
				selectionControls,
				disabled: actionsDisabled
			}}
		/>
		{#if moveError}
			<p role="alert" class="shrink-0 text-sm text-destructive">{moveError}</p>
		{/if}
	</Stack>
{/snippet}

<div class="hidden" aria-hidden="true">
	{@render fields({
		Field: CollectionKanbanPart as unknown as CollectionKanbanFieldsComposition<Row>['Field']
	})}
</div>

<Cover
	as="div"
	gap="sm"
	class="collection-kanban min-h-[24rem]"
	data-dragging={activeDrag != null}
	top={kanbanToolbar}
>
	<Scroll
		axis="x"
		name={t('kanban.lanesRegion')}
		class={cn('scroll-smooth', activeDrag ? 'snap-none' : 'snap-x snap-mandatory', className)}
	>
		<Grid
			minimum="compact"
			gap="md"
			class="h-full content-start pb-1"
			style={`grid-template-columns: repeat(${resolvedColumnCount}, minmax(min(18rem, 100%), 1fr)); grid-template-rows: repeat(${resolvedRowCount}, minmax(0, 1fr));`}
		>
			<CollectionKanbanSkeleton
				loading={query.loading && boardRows.length === 0}
				empty={groups.length === 0}
				lanes={lanes?.length ?? 3}
			/>
			{#each groups as [lane, records, recordIds], index (lane)}
				<CollectionKanbanLane
					{lane}
					label={laneMeta.get(lane)?.label ?? humanize(lane)}
					color={laneMeta.get(lane)?.color}
					{recordIds}
					previousLane={groups[index - 1]?.[0]}
					nextLane={groups[index + 1]?.[0]}
					movable={true}
					selectable={effectiveSelectable}
					selectedRecordIds={visibleSelection}
					mutationPending={writePending}
					{updateRestrictedRecordIds}
					{updateRestrictionReasonById}
					renderCard={kanbanCard}
					renderMetadata={kanbanMetadata}
					getLeadingAccent={leadingAccentFor}
					onOpen={openRecordById}
					onToggleSelection={toggleSelection}
					onMove={(move) => void moveRecord(move)}
					onDragStart={(recordId, lane) => (activeDrag = { recordId, lane })}
					onDragEnd={() => (activeDrag = null)}
				/>
			{/each}
			{#if query.error}<p class="text-sm text-destructive">{query.error.message}</p>{/if}
		</Grid>
	</Scroll>
</Cover>
