<script lang="ts">
	/**
	 * The search box as a command line.
	 *
	 * Plain text is the lexical search it always was. A leading `/` names the intent instead —
	 * `/semantic` takes a sentence to the embedding index; `/<index>` takes a target through the
	 * capture form that index declared, because a colour, a coordinate or a fingerprint is a form,
	 * not a phrase. The box captures the intent and shows the right control for it; what it commits
	 * is one `CollectionSearch` command the query sends as it is.
	 */
	import type { CollectionSearch, CollectionSimilarityIndex } from '@norbital-ai/std/collection';
	import { COLLECTION_SEARCH_MAX_LENGTH } from '@norbital-ai/std/collection';
	import { humanize } from '@norbital-ai/std/string';
	import Icon from '@iconify/svelte';
	import { debounce } from 'es-toolkit/function';
	import { onDestroy } from 'svelte';
	import { Button } from '#lib/button';
	import { Combobox } from '#lib/combobox';
	import { useI18n, type UiKeys } from '#lib/i18n';
	import { Input } from '#lib/input';
	import { Inline, Stack } from '#lib/layout';
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
		initial = null,
		disabled = false,
		onChange,
		inputRef = $bindable(null)
	}: {
		/** What plain text searches, named by the schema. */
		placeholder: string;
		semantic?: boolean;
		similarity?: readonly CollectionSimilarityIndex[];
		initial?: CollectionSearch | null;
		disabled?: boolean;
		/** `null` clears; a lexical command with an empty term never arrives. */
		onChange: (command: CollectionSearch | null) => void;
		inputRef?: HTMLInputElement | null;
	} = $props();

	const commands = $derived([
		{ name: 'text', label: t('table.searchModeText'), kind: 'lexical' as const },
		...(semantic
			? [{ name: 'semantic', label: t('table.searchModeSemantic'), kind: 'semantic' as const }]
			: []),
		...similarity.map((index) => ({
			name: index.name,
			label: index.label ?? humanize(index.name),
			kind: 'nearest' as const,
			index
		}))
	]);
	const modeOf = (name: string): Mode | undefined => {
		const command = commands.find((candidate) => candidate.name === name);
		if (command === undefined) return undefined;
		return command.kind === 'nearest'
			? { kind: 'nearest', index: command.index }
			: { kind: command.kind };
	};

	// svelte-ignore state_referenced_locally -- the box owns its draft independently of query refreshes.
	let mode = $state<Mode>(
		initial?.mode === 'semantic'
			? { kind: 'semantic' }
			: initial?.mode === 'nearest'
				? (modeOf(initial.index) ?? { kind: 'lexical' })
				: { kind: 'lexical' }
	);
	// svelte-ignore state_referenced_locally
	let term = $state(initial !== null && initial.mode !== 'nearest' ? initial.term : '');
	// svelte-ignore state_referenced_locally
	let target = $state<Readonly<Record<string, unknown>>>(
		initial?.mode === 'nearest' ? initial.target : {}
	);

	/** `/` at the start opens the command list; the rest of the text filters it. */
	const commandDraft = $derived(term.startsWith('/') ? term.slice(1).trim().toLowerCase() : null);
	const commandChoices = $derived(
		commandDraft === null
			? []
			: commands.filter(
					(command) =>
						command.name !== 'text' &&
						(commandDraft === '' ||
							command.name.startsWith(commandDraft) ||
							command.label.toLowerCase().includes(commandDraft))
				)
	);

	const commit = debounce((command: CollectionSearch | null) => onChange(command), 180);
	onDestroy(() => commit.cancel());

	const commitTerm = (): void => {
		const value = term.trim().normalize('NFC');
		if (commandDraft !== null || value === '') {
			commit(null);
			return;
		}
		commit({ mode: mode.kind === 'semantic' ? 'semantic' : 'lexical', term: value });
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
		commit(complete ? { mode: 'nearest', index: index.name, target: next } : null);
	};

	const choose = (name: string): void => {
		const next = modeOf(name);
		if (next === undefined) return;
		mode = next;
		term = '';
		target = next.kind === 'nearest' ? seeded(next.index) : {};
		commit(null);
		queueMicrotask(() => inputRef?.focus());
	};

	const clear = (): void => {
		mode = { kind: 'lexical' };
		term = '';
		target = {};
		commit(null);
		inputRef?.focus();
	};

	const onKeydown = (event: KeyboardEvent): void => {
		if (commandDraft !== null && event.key === 'Enter' && commandChoices[0] !== undefined) {
			event.preventDefault();
			choose(commandChoices[0].name);
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
		mode.kind === 'lexical'
			? null
			: `/${commands.find((c) => c.kind === mode.kind && (mode.kind !== 'nearest' || c.name === mode.index.name))?.name ?? mode.kind}`;
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
			<Inline gap="xs" align="center" class="min-w-0 flex-1">
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
						{segments}
						value={tupleValue(index)}
						onchange={(next) => commitTarget(index, { ...target, ...next })}
						{disabled}
						class="min-w-0 flex-1"
					/>
				{/if}
			</Inline>
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
						aria-selected={command === commandChoices[0]}
						class={cn(
							'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left hover:bg-accent',
							command === commandChoices[0] && 'bg-accent'
						)}
						onclick={() => choose(command.name)}
					>
						<span class="font-mono text-xs text-muted-foreground">/{command.name}</span>
						<span class="truncate">{command.label}</span>
						<Icon
							icon={command.kind === 'semantic' ? 'lucide:sparkles' : 'lucide:scan-search'}
							class="ml-auto size-3.5 shrink-0 text-muted-foreground"
							aria-hidden="true"
						/>
					</button>
				</li>
			{:else}
				<li class="px-2 py-1.5 text-muted-foreground">{t('table.searchNoCommand')}</li>
			{/each}
		</ul>
	{:else if mode.kind === 'lexical' && (semantic || similarity.length > 0) && term === ''}
		<p class="text-meta">{t('table.searchModeHint')}</p>
	{/if}
</Stack>
