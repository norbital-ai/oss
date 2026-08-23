<script
	lang="ts"
	generics="TCollections extends CollectionRegistry, TName extends CollectionKanbanName<TCollections>"
>
	import type {
		CollectionDefinition,
		CollectionGroupedResult,
		CollectionRegistry,
		CollectionRow,
		RemoteQuery
	} from '@norbital-ai/std/collection';
	import { resolveRecordLabel } from '@norbital-ai/std/collection';
	import { humanize } from '@norbital-ai/std/string';
	import { watch } from 'runed';
	import { Cover, Grid, Inline, Scroll, Stack } from '#lib/layout';
	import { cn } from '#lib/utils';
	import { useI18n, type UiKeys } from '#lib/i18n';
	import { type Translate } from '#lib/data-renderer';
	import { onMount } from 'svelte';
	import { Effect } from 'effect';
	import {
		getCollectionClientForSurface,
		getCollectionRecordScope,
		getCollectionSurfaceRuntime,
		resolveCollectionViewKey,
		setCollectionClientContext
	} from '#lib/collection-runtime';
	import { badgeColorClass } from '#lib/collection-table/collection-card-colors';
	import {
		createCollectionTableRouteKey,
		getCollectionTableNavigationContext
	} from '../collection-table/collection-table-navigation.svelte.js';
	import {
		deriveAutoCard,
		deriveColumnFieldNames,
		deriveLanes,
		formatAutoCardBadge,
		formatAutoCardField,
		formatAutoCardSubtitle,
		mergeAuthoredLanes,
		parseAuthoredLaneValues,
		resolvedRecordMetadataFor,
		type AutoCardModel
	} from '#lib/collection-table/collection-card-derivation';
	import CollectionKanbanSkeleton from './collection-kanban-skeleton.svelte';
	import CollectionKanbanLane from './collection-kanban-lane.svelte';
	import { CollectionQueryState } from '#lib/collection-query';
	import { CollectionActionToolbar } from '#lib/collection-toolbar';
	import {
		CollectionRecordMetadataView,
		collectionRecordMutationReason,
		type ResolvedCollectionRecordMetadata
	} from '#lib/collection-record-metadata';
	import type {
		CollectionKanbanName,
		CollectionKanbanProps
	} from '#lib/collection-kanban/collection-kanban.types';

	interface OptimisticKanbanMove {
		apply: () => void;
		commit: () => Effect.Effect<void, Error>;
		rollback: () => void;
	}

	/**
	 * Keeps the visual move immediate while preserving the query as the source of truth.
	 * A failed mutation restores the record to its server-backed lane; mutation invalidation owns
	 * refreshing the query after a successful commit.
	 */
	function runOptimisticKanbanMove(move: OptimisticKanbanMove): Effect.Effect<void, Error> {
		return Effect.sync(move.apply).pipe(
			Effect.flatMap(() => move.commit()),
			Effect.catch((cause) =>
				Effect.sync(move.rollback).pipe(Effect.flatMap(() => Effect.fail(cause)))
			)
		);
	}

	type Row = CollectionRow<TCollections[TName]>;
	interface BoardResultState {
		result: CollectionGroupedResult<Row>;
		hasLoaded: boolean;
	}

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
		exportPipelines = [],
		importPipelines = [],
		integrations = [],
		Card,
		onCardMove,
		class: className
	}: CollectionKanbanProps<TCollections, TName> = $props();
	// svelte-ignore state_referenced_locally -- a mounted collection surface keeps one generated client.
	const workspaceClient = getCollectionClientForSurface(client, 'CollectionKanban');
	setCollectionClientContext(() => workspaceClient);
	const { t } = useI18n<UiKeys>();
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
	const operations = $derived(client.db[collection]);
	const recordIdField = 'id';
	const effectiveSelectable = $derived(
		selectable ||
			exportPipelines.some((pipeline) => pipeline.requiresSelection) ||
			importPipelines.some((pipeline) => pipeline.requiresSelection)
	);
	const resolvedDetailRouteKey = $derived(
		createCollectionTableRouteKey({
			view: resolvedView
		})
	);
	const detailNavigation = getCollectionTableNavigationContext();

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

	// Query inputs are pure derived data. Creating the stateful RemoteQuery belongs in the watcher
	// callback so query resource writes never occur inside a derived computation.
	let boardQuery = $state<BoardResultState>({
		result: {},
		hasLoaded: false
	});
	// No page size to remember: a board asks for lanes, not pages.
	const queryState = new CollectionQueryState<Row>();
	const queryInput = $derived.by(() => ({
		operations: client.db[collection],
		query: {
			...collectionQuery,
			search: queryState.search || collectionQuery?.search,
			orderBy: collectionQuery?.orderBy,
			group: {
				by: groupBy,
				lanes: resolvedLaneValues.length > 0 ? [...resolvedLaneValues] : undefined
			}
		},
		filterOptions: queryState.queryOptions
	}));
	let query = $state<RemoteQuery<CollectionGroupedResult<Row>>>();
	watch(
		() => queryInput,
		(input) => {
			query = input.operations.findGrouped(input.query, input.filterOptions);
		},
		{ lazy: false }
	);
	watch(
		() => query?.current,
		(current) => {
			if (current == null) return;
			boardQuery.result = current;
			boardQuery.hasLoaded = true;
		},
		{ lazy: false }
	);
	let laneOverrides = $state(new Map<string, string>());
	let moveError = $state('');
	let activeDrag: { recordId: string; lane: string } | null = $state(null);
	let selectedRecordIds = $state(new Set<string>());
	const recordById = $derived.by(() => {
		const records = new Map<string, Row>();
		for (const group of Object.values(boardQuery.result)) {
			for (const record of group) {
				const id = Reflect.get(record, recordIdField);
				if (id != null) records.set(String(id), record);
			}
		}
		return records;
	});
	const metadataById = $derived.by(() => {
		const metadata = new Map<string, readonly ResolvedCollectionRecordMetadata[]>();
		for (const [recordId, record] of recordById) {
			metadata.set(recordId, resolvedRecordMetadataFor(record, recordMetadata, t as Translate));
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
	const groups = $derived.by((): Array<[string, Row[], string[]]> => {
		const laneKeys =
			resolvedLaneValues.length > 0 ? resolvedLaneValues : Object.keys(boardQuery.result);
		const grouped = new Map(
			laneKeys.map((lane) => [lane, { records: [] as Row[], recordIds: [] as string[] }])
		);
		for (const [serverLane, records] of Object.entries(boardQuery.result)) {
			for (const record of records) {
				const id = Reflect.get(record, recordIdField);
				const recordId = id == null ? undefined : String(id);
				const targetLane =
					recordId == null ? serverLane : (laneOverrides.get(recordId) ?? serverLane);
				let target = grouped.get(targetLane);
				if (target === undefined) {
					target = { records: [], recordIds: [] };
					grouped.set(targetLane, target);
				}
				target.records.push(record);
				if (recordId != null) target.recordIds.push(recordId);
			}
		}
		return [...grouped.entries()].map(([lane, { records, recordIds }]) => [
			lane,
			records,
			recordIds
		]);
	});
	const selectedRecords = $derived(
		[...selectedRecordIds]
			.map((recordId) => recordById.get(recordId))
			.filter((record): record is Row => record != null)
	);
	const allVisibleSelected = $derived(
		recordById.size > 0 &&
			[...recordById.keys()].every((recordId) => selectedRecordIds.has(recordId))
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
	const actionsDisabled = $derived((query?.loading ?? false) || operations.pending > 0);
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

	function setRecordLane(recordId: string, lane: string | undefined): void {
		const next = new Map(laneOverrides);
		if (lane == null) next.delete(recordId);
		else next.set(recordId, lane);
		laneOverrides = next;
	}

	function serverLaneFor(recordId: string): string | undefined {
		for (const [lane, records] of Object.entries(boardQuery.result)) {
			if (records.some((record) => String(Reflect.get(record, recordIdField)) === recordId)) {
				return lane;
			}
		}
		return undefined;
	}

	watch(
		() => boardQuery.result,
		() => {
			if (laneOverrides.size === 0) return;
			const next = new Map(laneOverrides);
			let changed = false;
			for (const [recordId, optimisticLane] of laneOverrides) {
				if (serverLaneFor(recordId) !== optimisticLane) continue;
				next.delete(recordId);
				changed = true;
			}
			if (changed) laneOverrides = next;
		}
	);

	watch(
		() => recordById,
		(records) => {
			if (selectedRecordIds.size === 0) return;
			const next = new Set([...selectedRecordIds].filter((recordId) => records.has(recordId)));
			if (next.size !== selectedRecordIds.size) selectedRecordIds = next;
		}
	);

	function commitCardMove(
		record: Row,
		fromLane: string,
		toLane: string
	): Effect.Effect<void, Error> {
		const authoredMove = onCardMove;
		if (authoredMove) {
			return authoredMove({ record, fromLane, toLane }).pipe(
				Effect.mapError((cause) => (cause instanceof Error ? cause : new Error(String(cause))))
			);
		}
		// Default optimistic move: write `toLane` into the groupBy field.
		return Effect.gen(function* () {
			const id = Reflect.get(record, recordIdField);
			if (id == null)
				return yield* Effect.fail(new Error(`Cannot move a record without ${recordIdField}.`));
			yield* Effect.tryPromise(() => operations.mutate({ id: String(id), [groupBy]: toLane }));
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
		if (fromLane === toLane || operations.pending > 0 || updateRestrictedRecordIds.has(recordId))
			return;
		const record = recordById.get(recordId);
		if (!record) return;
		moveError = '';
		void Effect.runPromise(
			runOptimisticKanbanMove({
				apply: () => setRecordLane(recordId, toLane),
				commit: () => commitCardMove(record, fromLane, toLane),
				rollback: () => setRecordLane(recordId, undefined)
			}).pipe(
				Effect.catch((cause) =>
					Effect.sync(() => {
						moveError = cause instanceof Error ? cause.message : String(cause);
					})
				)
			)
		);
	}

	// Auto card (RFC V.3): identical derivation to the table's mobile card from field structure.
	const autoCard: AutoCardModel = $derived(
		deriveAutoCard(definition.fields, deriveColumnFieldNames(definition.fields), {
			hasRecordLabel: Boolean(definition.recordLabel)
		})
	);
	/**
	 * The kanban derives its whole card from field structure — there are no authored columns here to
	 * ask, so the schema formatter is the entire resolution. A caller who needs more supplies the
	 * `Card` snippet and this path is not taken at all.
	 */
	function cardText(name: string, record: Row): string {
		return formatAutoCardField(definition.fields, name, record, t as Translate);
	}

	function autoCardTitle(record: Row): string {
		if (autoCard.title.kind === 'field') {
			const text = cardText(autoCard.title.name, record);
			if (text && text !== '—') return text;
		}
		const label = resolveRecordLabel(definition.recordLabel ?? null, record);
		if (label) return label;
		const id = Reflect.get(record, recordIdField);
		return id == null ? humanize(String(collection)) : String(id);
	}
</script>

{#snippet autoCardSnippet(record: Row)}
	{@const subtitle = formatAutoCardSubtitle(autoCard, (name) => cardText(name, record))}
	{@const badge = formatAutoCardBadge(autoCard, record, (name) => cardText(name, record))}
	<Inline align="start" justify="between" gap="md">
		<Stack gap="xs">
			<p class="min-w-0 truncate font-medium">{autoCardTitle(record)}</p>
			{#if subtitle}<p class="min-w-0 truncate text-sm text-muted-foreground">{subtitle}</p>{/if}
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
			filterPersistenceKey={resolvedView}
			operations={{
				exportPipelines,
				importPipelines,
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
				loading={!boardQuery.hasLoaded && (query?.loading ?? true)}
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
					{selectedRecordIds}
					mutationPending={operations.pending > 0}
					{updateRestrictedRecordIds}
					{updateRestrictionReasonById}
					renderCard={kanbanCard}
					renderMetadata={kanbanMetadata}
					onOpen={openRecordById}
					onToggleSelection={toggleSelection}
					onMove={(move) => void moveRecord(move)}
					onDragStart={(recordId, lane) => (activeDrag = { recordId, lane })}
					onDragEnd={() => (activeDrag = null)}
				/>
			{/each}
			{#if query?.error}<p class="text-sm text-destructive">{query.error.message}</p>{/if}
		</Grid>
	</Scroll>
</Cover>
