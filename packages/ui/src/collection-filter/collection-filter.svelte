<script lang="ts">
	import type {
		CollectionField,
		CollectionFilter,
		CollectionRelatedMatch
	} from '@norbital-ai/std/collection';
	import Icon from '@iconify/svelte';
	import { Effect, Schema } from 'effect';
	import { PersistedState } from 'runed';
	import { humanize } from '@norbital-ai/std/string';
	import {
		getCollectionFilterInference,
		type CollectionFilterInferenceAnswer
	} from './collection-filter-inference.js';
	import { Button } from '#lib/button';
	import { Combobox } from '#lib/combobox';
	import { DataRenderer } from '#lib/data-renderer';
	import { useI18n } from '#lib/i18n';
	import { Indicator } from '#lib/indicator';
	import { Grid, Inline, Scroll, Stack } from '#lib/layout';
	import * as Popover from '#lib/popover';
	import { TreeCombobox } from '#lib/tree-combobox';
	import {
		collectionFilterClause,
		collectionFilterFieldTree,
		collectionFilterFields,
		type CollectionFilterField,
		type FilterCollectionDefinition
	} from './collection-filter-fields.js';
	import {
		collectionFilterOperandField,
		collectionFilterOperatorNeedsValue,
		collectionFilterOperatorOptions,
		collectionFilterQueryOperator,
		type CollectionFilterOperator
	} from './collection-filter-operators.js';
	import type { CollectionInitialFilter } from '#lib/collection-surface';

	type Filter = {
		id: number;
		field: string | null;
		operator: CollectionFilterOperator | null;
		value: unknown;
		/** The related group this condition belongs to; absent for a condition on the row itself. */
		group?: number;
	};
	type RelatedMatch = 'some' | 'none' | 'every' | 'count' | 'sum' | 'min' | 'max' | 'avg';
	type Comparison = 'gte' | 'gt' | 'lte' | 'lt' | 'eq';
	/**
	 * A condition on related records: which relationship, how many of its rows must match, and —
	 * as ordinary condition rows carrying this group's id — what each such row must satisfy. The
	 * conditions hold on one related row together, so "open" and "invoice" mean the same message.
	 */
	type RelatedGroup = {
		id: number;
		relation: string | null;
		match: RelatedMatch;
		/** With count or an aggregate: how the measure compares with `value`. */
		comparison: Comparison;
		value: number;
		/** With an aggregate: the related numeric column it measures. */
		of: string | null;
	};
	const measures = (match: RelatedMatch): boolean =>
		match === 'count' || match === 'sum' || match === 'min' || match === 'max' || match === 'avg';
	const aggregates = (match: RelatedMatch): match is 'sum' | 'min' | 'max' | 'avg' =>
		measures(match) && match !== 'count';
	let {
		definition,
		collections,
		disabled = false,
		initialFilters = [],
		persistenceKey,
		onChange
	}: {
		definition: FilterCollectionDefinition;
		collections: Readonly<Record<string, FilterCollectionDefinition>>;
		disabled?: boolean;
		/** Conditions this view opens with, seeded as ordinary removable rows. */
		initialFilters?: readonly CollectionInitialFilter[];
		/** View key the "operator cleared the seed" decision is remembered against. */
		persistenceKey?: string;
		onChange: (filters: readonly CollectionFilter[]) => void;
	} = $props();

	const { t } = useI18n();

	const isString = Schema.is(Schema.String);

	let filters = $state<Filter[]>([]);
	let groups = $state<RelatedGroup[]>([]);
	let nextId = $state(0);
	const filterFields = $derived(collectionFilterFields(definition, collections));
	const fieldTree = $derived(collectionFilterFieldTree(filterFields, t));
	const relationships = $derived(definition.relationships ?? []);
	const activeCount = $derived(
		filters.filter((filter) => filter.group === undefined && filterIsActive(filter)).length +
			groups.filter((group) => group.relation !== null).length
	);
	const RELATED_MATCHES: ReadonlyArray<{ value: RelatedMatch; label: string }> = [
		{ value: 'some', label: 'has any' },
		{ value: 'none', label: 'has none' },
		{ value: 'every', label: 'all match' },
		{ value: 'count', label: 'count' },
		{ value: 'sum', label: 'sum of' },
		{ value: 'min', label: 'min of' },
		{ value: 'max', label: 'max of' },
		{ value: 'avg', label: 'average of' }
	];
	const COMPARISONS: ReadonlyArray<{ value: Comparison; label: string }> = [
		{ value: 'gte', label: 'at least' },
		{ value: 'gt', label: 'more than' },
		{ value: 'lte', label: 'at most' },
		{ value: 'lt', label: 'less than' },
		{ value: 'eq', label: 'exactly' }
	];

	/** The related collection's numeric columns, which an aggregate may measure. */
	function numericFields(groupId: number): ReadonlyArray<{ value: string; label: string }> {
		return groupFields(groupId)
			.filter(
				(field) =>
					field.path.length === 1 &&
					['number', 'numeric', 'integer'].includes(field.field.kind) &&
					field.field.array !== true
			)
			.map((field) => ({
				value: field.value,
				label: field.field.label ?? humanize(field.field.name)
			}));
	}

	/** The related collection's own fields, for the conditions inside a group. */
	function groupFields(groupId: number): readonly CollectionFilterField[] {
		const relation = relationships.find(
			(candidate) => candidate.name === groups.find((group) => group.id === groupId)?.relation
		);
		const target = relation === undefined ? undefined : collections[relation.target];
		return target === undefined ? [] : collectionFilterFields(target, collections);
	}

	function fieldsFor(filter: Filter): readonly CollectionFilterField[] {
		return filter.group === undefined ? filterFields : groupFields(filter.group);
	}

	/**
	 * The seed, and whether this operator has already thrown it away.
	 *
	 * Interactive filters are deliberately not persisted — every mount starts from an empty builder —
	 * so a seed would otherwise reappear on each reload no matter how many times it was dismissed.
	 * What *is* remembered is the signature of the seed the operator cleared. Comparing signatures
	 * rather than storing a bare boolean means an author who later changes the default gets it
	 * applied again, instead of it staying invisible forever because of a decision taken about a
	 * different condition.
	 */
	const seedSignature = $derived(
		initialFilters.length === 0
			? null
			: JSON.stringify(
					initialFilters.map((seed) => [seed.field, seed.operator, seed.value ?? null])
				)
	);
	// svelte-ignore state_referenced_locally -- the view a builder belongs to is fixed for its lifetime.
	const clearedSeed = new PersistedState<string | null>(
		`${persistenceKey ?? 'unkeyed'}.filterSeed.cleared`,
		null
	);
	/** Rows that arrived from the seed, so clearing one can be told apart from clearing your own. */
	let seededIds = $state(new Set<number>());
	let seedSettled = $state(false);

	/**
	 * Adopt the seeded rows once, as soon as the field picker has arrived. A latch, not a
	 * derivation: it settles permanently and publishes the adopted rows to the host.
	 */
	function settleFilterSeed(
		enabled: boolean,
		signature: string | null,
		fields: typeof filterFields,
		cleared: string | null,
		seeds: readonly CollectionInitialFilter[]
	): void {
		if (seedSettled) return;
		if (!enabled) return;
		if (signature === null) return;
		// The field picker is derived from the collection definition, which may not have arrived yet;
		// seeding against an empty field list would silently drop every row.
		if (fields.length === 0) return;
		if (cleared === signature) {
			seedSettled = true;
			return;
		}
		// Index the picker once per seeding pass instead of re-searching it per seed row.
		const knownFieldValues = new Set(fields.map((field) => field.value));
		const seeded = seeds.flatMap((seed) => {
			if (!knownFieldValues.has(seed.field)) return [];
			return [{ id: nextId++, field: seed.field, operator: seed.operator, value: seed.value }];
		});
		seedSettled = true;
		if (seeded.length === 0) return;
		seededIds = new Set(seeded.map((row) => row.id));
		filters = seeded;
		publish();
	}

	// Named here rather than hidden behind the call: this latch is waiting on the field picker to
	// arrive, and a reader should see that at the declaration. Tracking is unchanged.
	$effect(() => {
		settleFilterSeed(true, seedSignature, filterFields, clearedSeed.current, initialFilters);
	});

	function markSeedCleared(): void {
		if (seedSignature !== null) clearedSeed.current = seedSignature;
	}

	function selectedField(filter: Filter): CollectionFilterField | undefined {
		return fieldsFor(filter).find((field) => field.value === filter.field);
	}

	function filterIsActive(filter: Filter): boolean {
		if (!filter.field || !filter.operator) return false;
		if (!collectionFilterOperatorNeedsValue(filter.operator)) return true;
		if (filter.value == null) return false;
		if (isString(filter.value)) return filter.value.trim().length > 0;
		if (Array.isArray(filter.value)) return filter.value.length > 0;
		return true;
	}

	function clauseOf(filter: Filter): CollectionFilter[] {
		if (!filterIsActive(filter)) return [];
		const field = selectedField(filter);
		if (!field || !filter.operator || !filter.field) return [];
		const operator = collectionFilterQueryOperator(field.field, filter.operator);
		if (!collectionFilterOperatorNeedsValue(filter.operator)) {
			return [collectionFilterClause(field, operator, true)];
		}
		const operand = operator === 'ilike' ? `%${String(filter.value).trim()}%` : filter.value;
		return [collectionFilterClause(field, operator, operand)];
	}

	function groupClause(group: RelatedGroup): CollectionFilter[] {
		if (group.relation === null) return [];
		const match = group.match;
		if (measures(match) && !Number.isFinite(group.value)) return [];
		if (match === 'count' && (!Number.isInteger(group.value) || group.value < 0)) return [];
		if (aggregates(match) && group.of === null) return [];
		const related: CollectionRelatedMatch = aggregates(match)
			? { aggregate: match, of: group.of ?? '', comparison: group.comparison, value: group.value }
			: match === 'count'
				? { count: group.comparison, value: group.value }
				: { quantifier: match as 'some' | 'none' | 'every' };
		return [
			{
				path: [group.relation],
				operator: 'related',
				related,
				where: filters.filter((filter) => filter.group === group.id).flatMap(clauseOf)
			}
		];
	}

	function publish(): void {
		onChange([
			...filters.filter((filter) => filter.group === undefined).flatMap(clauseOf),
			...groups.flatMap(groupClause)
		]);
	}

	function addGroup(): void {
		groups = [
			...groups,
			{ id: nextId++, relation: null, match: 'some', comparison: 'gte', value: 1, of: null }
		];
	}

	function updateGroup(id: number, change: Partial<RelatedGroup>): void {
		groups = groups.map((group) => (group.id === id ? { ...group, ...change } : group));
		publish();
	}

	function removeGroup(id: number): void {
		groups = groups.filter((group) => group.id !== id);
		filters = filters.filter((filter) => filter.group !== id);
		publish();
	}

	function addGroupCondition(groupId: number): void {
		filters = [
			...filters,
			{ id: nextId++, field: null, operator: null, value: undefined, group: groupId }
		];
	}

	/**
	 * The composer: a description in words becomes the builder's rows.
	 *
	 * Offered only when the host supplied an inference. Each answer is the whole filter — the rows
	 * already applied, refined by the request — and lands as ordinary rows, so every condition the
	 * model chose can be read, edited or removed exactly like one added by hand. Nothing it could not
	 * map is applied; those phrases are shown instead.
	 */
	const infer = getCollectionFilterInference();
	const ASK_PAUSE_MS = 450;
	let askText = $state('');
	let askPending = $state(false);
	let askError = $state<string | null>(null);
	let askUnresolved = $state<readonly string[]>([]);
	let askTimer: ReturnType<typeof setTimeout> | undefined;
	let askController: AbortController | undefined;

	function describeFields(fields: readonly CollectionFilterField[]) {
		return fields.slice(0, 200).map((filterField) => ({
			value: filterField.value,
			label: filterField.path.map((segment) => humanize(segment)).join(' › '),
			kind: filterField.field.kind,
			nullable: filterField.field.nullable,
			...(filterField.field.array === true ? { array: true } : {}),
			...(filterField.field.values === undefined ? {} : { values: [...filterField.field.values] }),
			...(filterField.lookupTarget === undefined ? {} : { target: filterField.lookupTarget }),
			operators: collectionFilterOperatorOptions(filterField.field).map(({ value }) => value)
		}));
	}

	/** The row's own fields, then each relationship with the related collection's fields. */
	function inferenceFields() {
		return [
			...describeFields(filterFields),
			...relationships.flatMap((relation) => {
				const target = collections[relation.target];
				return target === undefined
					? []
					: [
							{
								value: `@${relation.name}`,
								label: humanize(relation.name),
								kind: 'relation',
								nullable: false,
								target: relation.target,
								operators: ['related'],
								fields: describeFields(collectionFilterFields(target, collections))
							}
						];
			})
		].slice(0, 300);
	}

	/** A `related` answer becomes a group and its conditions, exactly as if built by hand. */
	function adoptRelated(condition: { field: string; value?: unknown }):
		| {
				group: RelatedGroup;
				rows: Filter[];
		  }
		| undefined {
		const relation = relationships.find((candidate) => `@${candidate.name}` === condition.field);
		const value = condition.value;
		if (relation === undefined || typeof value !== 'object' || value === null) return undefined;
		const match = Reflect.get(value, 'match');
		if (!RELATED_MATCHES.some((option) => option.value === match)) return undefined;
		const comparison = Reflect.get(value, 'comparison');
		const of = Reflect.get(value, 'of');
		const group: RelatedGroup = {
			id: nextId++,
			relation: relation.name,
			match: match as RelatedMatch,
			comparison: COMPARISONS.some((option) => option.value === comparison)
				? (comparison as Comparison)
				: 'gte',
			value: Number(Reflect.get(value, 'value') ?? 1),
			of: typeof of === 'string' ? of : null
		};
		const target = collections[relation.target];
		const fields = target === undefined ? [] : collectionFilterFields(target, collections);
		const where: unknown = Reflect.get(value, 'where') ?? [];
		const rows = (Array.isArray(where) ? where : []).flatMap((nested: unknown) => {
			if (typeof nested !== 'object' || nested === null) return [];
			const field = fields.find((candidate) => candidate.value === Reflect.get(nested, 'field'));
			const operator = field
				? collectionFilterOperatorOptions(field.field).find(
						(option) => option.value === Reflect.get(nested, 'operator')
					)?.value
				: undefined;
			return field === undefined || operator === undefined
				? []
				: [
						{
							id: nextId++,
							field: field.value,
							operator,
							value: Reflect.get(nested, 'value'),
							group: group.id
						}
					];
		});
		return { group, rows };
	}

	function ask(text: string): void {
		clearTimeout(askTimer);
		askController?.abort();
		if (infer === undefined || text.trim().length === 0) return;
		const controller = new AbortController();
		askController = controller;
		askPending = true;
		askError = null;
		const request = {
			collection: definition.name,
			text: text.trim().slice(0, 500),
			fields: inferenceFields(),
			current: [
				...filters
					.filter((filter) => filter.group === undefined && filterIsActive(filter))
					.map((filter) => ({
						field: filter.field ?? '',
						operator: filter.operator ?? '',
						...(filter.value === undefined ? {} : { value: filter.value })
					})),
				...groups
					.filter((group) => group.relation !== null)
					.map((group) => ({
						field: `@${group.relation}`,
						operator: 'related',
						value: {
							match: group.match,
							...(measures(group.match)
								? { comparison: group.comparison, value: group.value }
								: {}),
							...(group.of === null ? {} : { of: group.of }),
							where: filters
								.filter((filter) => filter.group === group.id && filterIsActive(filter))
								.map((filter) => ({
									field: filter.field ?? '',
									operator: filter.operator ?? '',
									...(filter.value === undefined ? {} : { value: filter.value })
								}))
						}
					}))
			]
		};
		// The same request against the same filter asks the model nothing twice.
		const cacheKey = JSON.stringify([request.collection, request.text, request.current]);
		const cached = askCache.get(cacheKey);
		Effect.runPromise(
			cached === undefined ? infer(request, controller.signal) : Effect.succeed(cached),
			{
				signal: controller.signal
			}
		).then(
			(answer) => {
				if (controller.signal.aborted) return;
				askPending = false;
				askCache.set(cacheKey, answer);
				askHistory = [request.text, ...askHistory.filter((entry) => entry !== request.text)].slice(
					0,
					20
				);
				historyIndex = -1;
				const offered = new Map(filterFields.map((field) => [field.value, field]));
				const related = answer.conditions.flatMap((condition) => {
					const adopted = condition.operator === 'related' ? adoptRelated(condition) : undefined;
					return adopted === undefined ? [] : [adopted];
				});
				const rows = answer.conditions.flatMap((condition) => {
					const field = offered.get(condition.field);
					const operator = collectionFilterOperatorOptions(
						field?.field ?? { name: '', kind: '', nullable: false }
					).find((option) => option.value === condition.operator)?.value;
					return field === undefined || operator === undefined
						? []
						: [{ id: nextId++, field: condition.field, operator, value: condition.value }];
				});
				if (filters.some((filter) => seededIds.has(filter.id))) markSeedCleared();
				// The answer is the whole filter, related groups included.
				filters = [...rows, ...related.flatMap((adopted) => adopted.rows)];
				groups = related.map((adopted) => adopted.group);
				askUnresolved = answer.unresolved;
				publish();
			},
			(cause: unknown) => {
				if (controller.signal.aborted) return;
				askPending = false;
				askError = cause instanceof Error ? cause.message : String(cause);
			}
		);
	}

	/** Earlier requests, newest first, recalled with ↑ and ↓ like a shell. */
	let askHistory = $state<readonly string[]>([]);
	let historyIndex = -1;
	const askCache = new Map<string, CollectionFilterInferenceAnswer>();

	function recall(step: 1 | -1): void {
		const next = Math.min(askHistory.length - 1, Math.max(-1, historyIndex + step));
		historyIndex = next;
		askText = next === -1 ? '' : (askHistory[next] ?? '');
	}

	function onAskInput(value: string): void {
		askText = value;
		clearTimeout(askTimer);
		askTimer = setTimeout(() => ask(askText), ASK_PAUSE_MS);
	}

	function addFilter(): void {
		filters = [...filters, { id: nextId++, field: null, operator: null, value: undefined }];
	}

	function setField(id: number, fieldName: string): void {
		const row = filters.find((filter) => filter.id === id);
		const field = (row === undefined ? filterFields : fieldsFor(row)).find(
			(candidate) => candidate.value === fieldName
		);
		if (!field) return;
		const operator = collectionFilterOperatorOptions(field.field)[0]?.value ?? null;
		filters = filters.map((filter) =>
			filter.id === id ? { ...filter, field: fieldName, operator, value: undefined } : filter
		);
		publish();
	}

	function setOperator(id: number, operator: CollectionFilterOperator): void {
		filters = filters.map((filter) =>
			filter.id === id ? { ...filter, operator, value: undefined } : filter
		);
		publish();
	}

	function setValue(id: number, value: unknown): void {
		filters = filters.map((filter) => (filter.id === id ? { ...filter, value } : filter));
		publish();
	}

	function removeFilter(id: number): void {
		if (seededIds.has(id)) markSeedCleared();
		filters = filters.filter((filter) => filter.id !== id);
		publish();
	}

	function clear(): void {
		if (filters.some((filter) => seededIds.has(filter.id))) markSeedCleared();
		filters = [];
		groups = [];
		publish();
	}
</script>

{#snippet conditionRow(filter: Filter, tree: typeof fieldTree)}
	{@const field = selectedField(filter)}
	{@const operatorOptions = field ? collectionFilterOperatorOptions(field.field) : []}
	<!-- One field column on a phone, three from `sm` up. The template is carried in a
				     custom property so the breakpoint stays a class while `Grid` owns the track
				     declaration. -->
	<Grid
		gap="sm"
		tracks="var(--filter-row-columns)"
		align="center"
		class="min-w-0 [--filter-row-columns:minmax(0,1fr)_2rem] sm:[--filter-row-columns:repeat(3,minmax(0,1fr))_2rem]"
	>
		<div class="col-start-1 min-w-0 w-full sm:col-auto">
			<TreeCombobox
				rootItems={tree}
				value={filter.field ?? undefined}
				placeholder={t('table.chooseField')}
				searchPlaceholder={t('table.searchFields')}
				ariaLabel={t('table.chooseFilterField')}
				allowCleared={false}
				{disabled}
				onValueChange={(nextField) => nextField && setField(filter.id, nextField)}
			/>
		</div>
		{#if field}
			<Combobox
				options={[...operatorOptions]}
				value={filter.operator}
				searchable={false}
				class="col-start-1 h-8 min-w-0 w-full text-xs sm:col-auto"
				onValueChange={(operator) => operator && setOperator(filter.id, operator)}
			/>
		{:else}
			<span class="col-start-1 min-w-0 px-2 text-meta sm:col-auto">{t('table.chooseField')}</span>
		{/if}
		{#if field && filter.operator && collectionFilterOperatorNeedsValue(filter.operator)}
			{#key `${field.value}:${filter.operator}`}
				<DataRenderer
					field={collectionFilterOperandField(field.field, filter.operator, {
						target: field.lookupTarget,
						relationName: `__filter_${field.path.join('_')}`
					})}
					value={filter.value}
					mode="edit"
					class="col-start-1 h-8 min-w-0 w-full text-xs sm:col-auto"
					onValueChange={(value) => setValue(filter.id, value)}
				/>
			{/key}
		{:else}
			<span class="col-start-1 min-w-0 px-2 text-meta sm:col-auto">
				{field && filter.operator ? t('table.noValueNeeded') : t('table.chooseOperator')}
			</span>
		{/if}
		<Button
			type="button"
			variant="ghost"
			size="icon"
			class="col-start-2 row-start-1 size-8 sm:col-start-4"
			aria-label={t('table.filterRemove')}
			onclick={() => removeFilter(filter.id)}><Icon icon="lucide:x" class="size-3.5" /></Button
		>
	</Grid>
{/snippet}

<Popover.Root>
	<Popover.Trigger>
		{#snippet child({ props })}
			<Indicator visible={activeCount > 0} variant="info" size="sm">
				<Button
					{...props}
					type="button"
					variant="ghost"
					size="icon"
					class="size-8"
					aria-label={activeCount > 0 ? t('table.filterActive') : t('table.filterRecords')}
					aria-pressed={activeCount > 0}
					{disabled}
				>
					<Icon icon="lucide:list-filter" class="size-4" />
				</Button>
			</Indicator>
		{/snippet}
	</Popover.Trigger>
	<Popover.Content align="start" class="w-[min(calc(100vw-1rem),42rem)] max-w-full p-0">
		<Inline justify="between" gap="sm" class="border-b px-3 py-2">
			<Stack gap="none">
				<p class="text-xs font-medium">{t('table.filters')}</p>
				<p class="text-micro text-muted-foreground">{t('table.filtersAllMatch')}</p>
			</Stack>
			{#if filters.length > 0 || groups.length > 0}<Button
					type="button"
					variant="ghost"
					size="sm"
					class="h-7 text-xs"
					onclick={clear}>{t('table.clearAll')}</Button
				>{/if}
		</Inline>
		{#if infer !== undefined && filterFields.length > 0}
			<Stack gap="xs" class="border-b px-3 py-2">
				<Inline gap="xs" align="center" class="min-w-0">
					<Icon
						icon="lucide:sparkles"
						class="size-3.5 shrink-0 text-muted-foreground"
						aria-hidden="true"
					/>
					<input
						type="text"
						class="h-8 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
						placeholder={t('table.filterAsk')}
						aria-label={t('table.filterAskLabel')}
						maxlength={500}
						value={askText}
						{disabled}
						oninput={(event) => onAskInput(event.currentTarget.value)}
						onkeydown={(event) => {
							if (event.key === 'Enter') {
								event.preventDefault();
								ask(askText);
							} else if (event.key === 'ArrowUp' && askHistory.length > 0) {
								event.preventDefault();
								recall(1);
							} else if (event.key === 'ArrowDown' && historyIndex >= 0) {
								event.preventDefault();
								recall(-1);
							}
						}}
					/>
					{#if askPending}
						<Icon
							icon="lucide:loader-circle"
							class="size-3.5 shrink-0 animate-spin text-muted-foreground"
							aria-label={t('table.filterAskReading')}
						/>
					{/if}
				</Inline>
				{#if askError !== null}
					<p class="text-micro text-destructive" role="alert">
						{t('table.filterAskFailed', { error: askError })}
					</p>
				{:else if askUnresolved.length > 0}
					<p class="text-micro text-warning" aria-live="polite">
						{t('table.filterAskUnresolved', { phrases: askUnresolved.join(', ') })}
					</p>
				{/if}
			</Stack>
		{/if}
		<Scroll axis="y" name={t('table.appliedFilters')} class="max-h-80 min-w-0 p-3">
			<Stack gap="xs">
				{#if filters.length === 0 && groups.length === 0}
					<p class="py-2 text-center text-meta">
						{t('table.noFiltersApplied')}
					</p>
				{/if}
				{#each filters.filter((filter) => filter.group === undefined) as filter (filter.id)}
					{@render conditionRow(filter, fieldTree)}
				{/each}
				{#each groups as group (group.id)}
					{@const measured = measures(group.match)}
					<Stack gap="xs" class="rounded-md border p-2">
						<Grid
							gap="sm"
							tracks="var(--filter-row-columns)"
							align="center"
							class="min-w-0 [--filter-row-columns:minmax(0,1fr)_2rem] sm:[--filter-row-columns:repeat(3,minmax(0,1fr))_2rem]"
						>
							<Combobox
								options={relationships.map((relation) => ({
									value: relation.name,
									label: humanize(relation.name)
								}))}
								value={group.relation}
								emptyPlaceholder={t('table.filterRelatedChoose')}
								class="col-start-1 h-8 min-w-0 w-full text-xs sm:col-auto"
								onValueChange={(relation) => {
									if (!relation) return;
									filters = filters.filter((filter) => filter.group !== group.id);
									updateGroup(group.id, { relation, of: null });
								}}
							/>
							<Combobox
								options={[...RELATED_MATCHES]}
								value={group.match}
								searchable={false}
								class="col-start-1 h-8 min-w-0 w-full text-xs sm:col-auto"
								onValueChange={(match) => match && updateGroup(group.id, { match })}
							/>
							{#if aggregates(group.match) && group.relation !== null}
								<Combobox
									options={[...numericFields(group.id)]}
									value={group.of}
									emptyPlaceholder={t('table.filterRelatedColumn')}
									class="col-start-1 h-8 min-w-0 w-full text-xs sm:col-auto"
									onValueChange={(of) => of && updateGroup(group.id, { of })}
								/>
							{:else}
								<span class="col-start-1 min-w-0 px-2 text-meta sm:col-auto">
									{t('table.filterRelatedRows')}
								</span>
							{/if}
							<Button
								type="button"
								variant="ghost"
								size="icon"
								class="col-start-2 row-start-1 size-8 sm:col-start-4"
								aria-label={t('table.filterRemove')}
								onclick={() => removeGroup(group.id)}
								><Icon icon="lucide:x" class="size-3.5" /></Button
							>
						</Grid>
						{#if measured}
							<Inline gap="sm" class="min-w-0">
								<Combobox
									options={[...COMPARISONS]}
									value={group.comparison}
									searchable={false}
									class="h-8 min-w-0 w-40 text-xs"
									onValueChange={(comparison) =>
										comparison && updateGroup(group.id, { comparison })}
								/>
								<input
									type="number"
									min={group.match === 'count' ? 0 : undefined}
									step={group.match === 'count' ? 1 : 'any'}
									class="h-8 min-w-0 w-32 rounded-md border bg-transparent px-2 text-xs"
									aria-label={t('table.filterRelatedCount')}
									value={group.value}
									{disabled}
									oninput={(event) =>
										updateGroup(group.id, { value: Number(event.currentTarget.value) })}
								/>
							</Inline>
						{/if}
						{#if group.relation !== null}
							{@const tree = collectionFilterFieldTree(groupFields(group.id), t)}
							<Stack gap="xs" class="border-l pl-3">
								<p class="text-micro text-muted-foreground">{t('table.filterRelatedWhere')}</p>
								{#each filters.filter((filter) => filter.group === group.id) as filter (filter.id)}
									{@render conditionRow(filter, tree)}
								{/each}
								<Button
									type="button"
									variant="ghost"
									size="sm"
									class="h-7 w-fit text-xs"
									onclick={() => addGroupCondition(group.id)}
								>
									<Icon icon="lucide:plus" class="size-3.5" />
									{t('table.filterAdd')}
								</Button>
							</Stack>
						{/if}
					</Stack>
				{/each}
			</Stack>
		</Scroll>
		<footer class="border-t p-2">
			<Button
				type="button"
				variant="ghost"
				size="sm"
				class="h-7 text-xs"
				disabled={filterFields.length === 0}
				onclick={addFilter}
			>
				<Icon icon="lucide:plus" class="size-3.5" />
				{t('table.filterAdd')}
			</Button>
			{#if relationships.length > 0}
				<Button type="button" variant="ghost" size="sm" class="h-7 text-xs" onclick={addGroup}>
					<Icon icon="lucide:git-fork" class="size-3.5" />
					{t('table.filterRelatedAdd')}
				</Button>
			{/if}
		</footer>
	</Popover.Content>
</Popover.Root>
