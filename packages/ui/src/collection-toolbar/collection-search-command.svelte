<script lang="ts">
	/**
	 * The search box as a command line.
	 *
	 * Plain text is the lexical search it always was. A leading `/` names the intent instead —
	 * `/semantic` takes a sentence to the embedding index; `/<index>` takes a target through the
	 * capture form that index declared, because a colour, a coordinate or a fingerprint is a form,
	 * not a phrase. The box captures the intent and shows the right control for it; what it commits
	 * is the one search string the query sends as it is: `text`, `/semantic text`, `/<index> {json}`.
	 */
	import type {
		CollectionRecord,
		CollectionSearch,
		CollectionSimilarityIndex
	} from '@norbital-ai/std/collection';
	import { COLLECTION_SEARCH_MAX_LENGTH, parseCollectionSearch } from '@norbital-ai/std/collection';
	import { humanize } from '@norbital-ai/std/string';
	import Icon from '@iconify/svelte';
	import { debounce } from 'es-toolkit/function';
	import { onDestroy } from 'svelte';
	import { Button } from '#lib/button';
	import type { FilterCollectionDefinition } from '#lib/collection-filter';
	import { getOptionalCollectionClientContext } from '#lib/collection-runtime';
	import { Combobox } from '#lib/combobox';
	import { useI18n, type UiKeys } from '#lib/i18n';
	import { Input } from '#lib/input';
	import { Cluster, Inline, Stack } from '#lib/layout';
	import { NumberTuple, type NumberTupleValue } from '#lib/number-tuple';
	import { cn } from '#lib/utils';

	type Mode =
		| Readonly<{ readonly kind: 'lexical' }>
		| Readonly<{ readonly kind: 'semantic' }>
		| Readonly<{ readonly kind: 'nearest'; readonly index: CollectionSimilarityIndex }>;

	const { t } = useI18n<UiKeys>();

	let {
		placeholder,
		semantic = false,
		similarity = [],
		collections = {},
		initial = null,
		disabled = false,
		onChange,
		inputRef = $bindable(null)
	}: {
		/** What plain text searches, named by the schema. */
		placeholder: string;
		semantic?: boolean;
		similarity?: readonly CollectionSimilarityIndex[];
		/** Every collection the surface knows, so a `reference` control can name and label its records. */
		collections?: Readonly<Record<string, FilterCollectionDefinition>>;
		initial?: CollectionSearch | null;
		disabled?: boolean;
		/** `null` clears; a lexical command with an empty term never arrives. */
		onChange: (command: CollectionSearch | null) => void;
		inputRef?: HTMLInputElement | null;
	} = $props();

	let tupleRef = $state<NumberTuple | null>(null);

	/**
	 * The records a `reference` control offers: the target collection's rows, labelled by its
	 * record label. One query per control, live from the client the surface already holds.
	 */
	const records = getOptionalCollectionClientContext()?.records;
	const referenceQuery = (
		collection: string,
		where: Readonly<Record<string, string | number | boolean>> | undefined
	) =>
		records?.findMany(collection, {
			...(where === undefined
				? {}
				: { where: Object.fromEntries(Object.entries(where).map(([k, v]) => [k, { eq: v }])) }),
			limit: 200
		}) ?? null;
	const referenceLabel = (collection: string, record: CollectionRecord): string => {
		const key = collections[collection]?.recordLabel;
		const value = key == null ? undefined : record[key];
		return typeof value === 'string' && value !== '' ? value : String(record.id ?? '');
	};

	/**
	 * `/semantic` is the platform's own, listed on every collection: the built-in search by meaning
	 * is one command everywhere, greyed where no column is searchable rather than absent, so the box
	 * reads the same on every table. A declared index may not take the name (`defineCollection`
	 * refuses it).
	 */
	type Command = Readonly<{
		name: string;
		label: string;
		/** The mode choosing it enters; `unavailable` lists it greyed with the reason instead. */
		mode: Mode;
		unavailable?: string;
	}>;
	const commands = $derived<readonly Command[]>([
		{
			name: 'semantic',
			label: t('table.searchModeSemantic'),
			mode: { kind: 'semantic' },
			...(semantic ? {} : { unavailable: t('table.searchSemanticUnavailable') })
		},
		...similarity.map((index) => ({
			name: index.name,
			label: index.label ?? humanize(index.name),
			mode: { kind: 'nearest' as const, index }
		}))
	]);
	const modeOf = (name: string): Mode | undefined => {
		const command = commands.find((candidate) => candidate.name === name);
		return command === undefined || command.unavailable !== undefined ? undefined : command.mode;
	};
	/** A committed `/<index>` argument back into its capture form; anything unreadable is empty. */
	function parsedTarget(json: string): Readonly<Record<string, unknown>> {
		try {
			const value: unknown = JSON.parse(json);
			return typeof value === 'object' && value !== null && !Array.isArray(value)
				? (value as Readonly<Record<string, unknown>>)
				: {};
		} catch {
			return {};
		}
	}

	// svelte-ignore state_referenced_locally -- the box owns its draft independently of query refreshes.
	const seed = parseCollectionSearch(initial ?? '');
	// svelte-ignore state_referenced_locally
	let mode = $state<Mode>(
		seed.command === undefined ? { kind: 'lexical' } : (modeOf(seed.command) ?? { kind: 'lexical' })
	);
	// svelte-ignore state_referenced_locally
	let term = $state(mode.kind === 'nearest' ? '' : seed.term);
	// svelte-ignore state_referenced_locally
	let target = $state<Readonly<Record<string, unknown>>>(
		mode.kind === 'nearest' ? parsedTarget(seed.term) : {}
	);

	/** `/` at the start opens the command list; the rest of the text filters it. */
	const commandDraft = $derived(term.startsWith('/') ? term.slice(1).trim().toLowerCase() : null);
	const commandChoices = $derived(
		commandDraft === null
			? []
			: commands.filter(
					(command) =>
						commandDraft === '' ||
						command.name.startsWith(commandDraft) ||
						command.label.toLowerCase().includes(commandDraft)
				)
	);
	/** The choice Enter takes: the first listed command that can be chosen. */
	const firstChoice = $derived(commandChoices.find((command) => command.unavailable === undefined));

	const commit = debounce((command: CollectionSearch | null) => onChange(command), 180);
	onDestroy(() => commit.cancel());

	const commitTerm = (): void => {
		const value = term.trim().normalize('NFC');
		if (commandDraft !== null || value === '') {
			commit(null);
			return;
		}
		commit(mode.kind === 'semantic' ? `/semantic ${value}` : value);
	};

	/** A nearest command needs every required control; until then the box searches nothing. */
	const commitTarget = (
		index: CollectionSimilarityIndex,
		next: Readonly<Record<string, unknown>>
	): void => {
		target = next;
		const complete = index.input.every(
			(field) =>
				field.optional === true ||
				(next[field.name] !== undefined && next[field.name] !== null && next[field.name] !== '')
		);
		commit(complete ? `/${index.name} ${JSON.stringify(next)}` : null);
	};

	const choose = (name: string): void => {
		const next = modeOf(name);
		if (next === undefined) return;
		mode = next;
		term = '';
		target = next.kind === 'nearest' ? seeded(next.index) : {};
		commit(null);
		// The numbers are what a person came to type: the caret lands in the first cell.
		queueMicrotask(() => (next.kind === 'nearest' ? tupleRef?.focusFirst() : inputRef?.focus()));
	};

	const clear = (): void => {
		mode = { kind: 'lexical' };
		term = '';
		target = {};
		commit(null);
		inputRef?.focus();
	};

	const onKeydown = (event: KeyboardEvent): void => {
		if (commandDraft !== null && event.key === 'Enter') {
			event.preventDefault();
			if (firstChoice !== undefined) choose(firstChoice.name);
			return;
		}
		if (event.key === 'Backspace' && term === '' && mode.kind !== 'lexical') {
			event.preventDefault();
			clear();
		}
	};

	/**
	 * The capture form: the numbers are one delimited field keyed as one line — a reading off an
	 * instrument — and every selector (an enum: the light, the frame) or text sits ahead of it.
	 */
	const tupleSegments = (index: CollectionSimilarityIndex) =>
		index.input
			.filter((field) => field.kind === 'number')
			.map((field) => ({
				name: field.name,
				label: field.label ?? humanize(field.name),
				...(field.min === undefined ? {} : { min: field.min }),
				...(field.max === undefined ? {} : { max: field.max }),
				...(field.step === undefined ? {} : { step: field.step })
			}));
	const selectors = (index: CollectionSimilarityIndex) =>
		index.input.filter((field) => field.kind !== 'number');
	const tupleValue = (index: CollectionSimilarityIndex): NumberTupleValue =>
		Object.fromEntries(
			index.input
				.filter((field) => field.kind === 'number')
				.map((field) => {
					const value = target[field.name];
					return [field.name, typeof value === 'number' ? value : null];
				})
		);
	/** An enum with one value, or the first value, is the selector's opening state. */
	const seeded = (index: CollectionSimilarityIndex): Readonly<Record<string, unknown>> =>
		Object.fromEntries(
			index.input.flatMap((field) =>
				field.kind === 'enum' && field.values?.[0] !== undefined && field.optional !== true
					? [[field.name, field.values[0]]]
					: []
			)
		);
	export const active = (): boolean =>
		mode.kind === 'nearest' ? Object.keys(target).length > 0 : term.trim() !== '';
	export const modeLabel = (): string | null =>
		mode.kind === 'lexical' ? null : `/${mode.kind === 'nearest' ? mode.index.name : 'semantic'}`;
</script>

<Stack gap="xs">
	<Inline gap="xs" align="center" class="min-w-0">
		{#if mode.kind !== 'lexical'}
			<span
				class="shrink-0 rounded-sm bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground"
				title={t('table.searchModeHint')}
			>
				/{mode.kind === 'nearest' ? mode.index.name : 'semantic'}
			</span>
		{/if}
		{#if mode.kind === 'nearest'}
			{@const index = mode.index}
			{@const segments = tupleSegments(index)}
			<!-- Wraps: the tuple takes its own line when a selector leaves it too little room. -->
			<Cluster gap="xs" align="center" class="min-w-0 flex-1">
				{#each selectors(index) as field (field.name)}
					{#if field.kind === 'enum'}
						<div class="w-32 shrink-0">
							<Combobox
								options={(field.values ?? []).map((value) => ({
									value,
									label: value.replaceAll('_', ' ')
								}))}
								value={typeof target[field.name] === 'string' ? String(target[field.name]) : null}
								allowClear={field.optional === true}
								searchable={false}
								emptyPlaceholder={field.label ?? humanize(field.name)}
								{disabled}
								onValueChange={(value) =>
									commitTarget(index, { ...target, [field.name]: value ?? null })}
							/>
						</div>
					{:else if field.kind === 'reference' && field.collection !== undefined}
						{@const collection = field.collection}
						{@const query = referenceQuery(collection, field.where)}
						<div class="w-44 shrink-0">
							<Combobox
								options={(query?.current ?? []).map((record) => ({
									value: String(record.id),
									label: referenceLabel(collection, record)
								}))}
								value={typeof target[field.name] === 'string' ? String(target[field.name]) : null}
								allowClear={field.optional === true}
								emptyPlaceholder={field.label ?? humanize(field.name)}
								{disabled}
								onValueChange={(value) =>
									commitTarget(index, { ...target, [field.name]: value ?? null })}
							/>
						</div>
					{:else}
						<Input
							type="text"
							class="h-9 w-32 shrink-0"
							placeholder={field.label ?? humanize(field.name)}
							aria-label={field.label ?? humanize(field.name)}
							value={target[field.name] == null ? '' : String(target[field.name])}
							{disabled}
							oninput={(event) =>
								commitTarget(index, { ...target, [field.name]: event.currentTarget.value })}
						/>
					{/if}
				{/each}
				{#if segments.length > 0}
					<NumberTuple
						bind:this={tupleRef}
						{segments}
						value={tupleValue(index)}
						onchange={(next) => commitTarget(index, { ...target, ...next })}
						{disabled}
						class="min-w-56 flex-1"
					/>
				{/if}
			</Cluster>
		{:else}
			<Input
				bind:ref={inputRef}
				type="search"
				class="h-9 min-w-0 flex-1 text-base md:text-sm"
				value={term}
				maxlength={COLLECTION_SEARCH_MAX_LENGTH}
				placeholder={mode.kind === 'semantic' ? t('table.searchSemanticPlaceholder') : placeholder}
				aria-label={t('table.searchRecords')}
				oninput={(event) => {
					term = event.currentTarget.value;
					commitTerm();
				}}
				onkeydown={onKeydown}
				{disabled}
			/>
		{/if}
		{#if mode.kind !== 'lexical' || term !== ''}
			<Button type="button" variant="ghost" size="sm" class="h-9 shrink-0" onclick={clear}
				>{t('common.clear')}</Button
			>
		{/if}
	</Inline>
	{#if commandDraft !== null}
		<ul class="rounded-md border bg-popover p-1 text-sm shadow-md" role="listbox">
			{#each commandChoices as command (command.name)}
				<li>
					<button
						type="button"
						role="option"
						aria-selected={command === firstChoice}
						aria-disabled={command.unavailable !== undefined}
						class={cn(
							'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left hover:bg-accent',
							command === firstChoice && 'bg-accent',
							command.unavailable !== undefined && 'cursor-default opacity-50 hover:bg-transparent'
						)}
						onclick={() => choose(command.name)}
					>
						<span class="font-mono text-xs text-muted-foreground">/{command.name}</span>
						<span class="truncate">{command.label}</span>
						{#if command.unavailable !== undefined}
							<span class="truncate text-xs text-muted-foreground">· {command.unavailable}</span>
						{/if}
						<Icon
							icon={command.mode.kind === 'semantic' ? 'lucide:sparkles' : 'lucide:scan-search'}
							class="ml-auto size-3.5 shrink-0 text-muted-foreground"
							aria-hidden="true"
						/>
					</button>
				</li>
			{:else}
				<li class="px-2 py-1.5 text-muted-foreground">{t('table.searchNoCommand')}</li>
			{/each}
		</ul>
	{:else if mode.kind === 'lexical' && term === ''}
		<p class="text-meta">{t('table.searchModeHint')}</p>
	{/if}
</Stack>
