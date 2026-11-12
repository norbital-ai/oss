<script lang="ts">
	import { Effect } from 'effect';
	import { fork } from '../effect/index.js';
	// The view popover of `Table` and `Board` (rule 16b, P34): one filter-and-sort toolbar icon. The main control is
	// "Describe what to show…" (when the host can describe, rule 16a); the author's scope read-only, relations by their
	// label; explicit conditions and sort (≤ 4 keys) stay in a collapsed accordion when a describer is available.
	import type { ModelExposure } from '../kinds/context.js';
	import Icon from '@iconify/svelte';
	import { CONTROL } from '../kinds/classes.js';
	import Combobox from '../primitives/combobox/combobox.svelte';
	import { cn } from '../primitives/utils.js';
	import type { Json } from '../client/contract.js';
	import { useBolt } from '../client/context.js';
	import { fromWhere } from './where.js';
	import { nodeParts, pathLabel, sortText, type Part } from './text.js';
	import { ORDER_MAX_KEYS, type SortKey } from './order.js';
	import { pathOf } from './catalog.js';
	import type { Node as FilterRow } from './node.js';
	import FilterNode from './FilterNode.svelte';
	import AddFilter from './AddFilter.svelte';
	import FilterSummary from './FilterSummary.svelte';
	import Glyph from '../primitives/icon/Glyph.svelte';
	import { record_labels } from '../record/labels.svelte.js';
	import { humanize, msg } from '../text/messages.js';
	import { useKinds } from '../kinds/context.js';
	import type { ViewState } from './view-state.svelte.js';
	import type { FilterVariables } from './operators.js';
	import { watch } from 'runed';

	let {
		view,
		catalog,
		model,
		author,
		sortable,
		active = true,
		expanded,
		readonly = false,
		variables
	}: {
		view: Pick<
			ViewState,
			| 'rows'
			| 'order'
			| 'offers'
			| 'offersKey'
			| 'loadOffers'
			| 'notice'
			| 'setRows'
			| 'setOrder'
			| 'clear'
			| 'describe'
		>;
		catalog: { readonly [c: string]: ModelExposure };
		model: string;
		/** The author's `where`: shown, never removable. */
		author?: Json;
		sortable: readonly string[];
		active?: boolean;
		expanded?: boolean;
		readonly?: boolean;
		variables?: FilterVariables;
	} = $props();
	const bolt = useBolt();
	const kinds = useKinds();
	const named = record_labels(bolt, () => kinds.catalog ?? catalog);
	let text = $state(''),
		busy = $state(false),
		applied = $state(false),
		failed = $state(false);
	watch(
		() => [active, view, view.offersKey],
		() => {
			if (active && !readonly) fork(view.loadOffers());
		}
	);
	const blank: FilterRow = { t: 'cond', path: '', op: 'eq', arg: null };
	// the badge counts what applies: an incomplete row (a field, no value yet) is not sent
	const describes = $derived(bolt.describe !== undefined);
	/** The catalogue's words for an operator on a path (the fallback is the machine operator). */
	const opWords = (op: string, path: string) =>
		view.offers.find((o) => o.op === op && pathOf(o.path).endsWith(path))?.opLabel ?? op;
	const authorParts = $derived.by((): Part[] | null => {
		if (author === undefined || author === null) return null;
		const rows = fromWhere(catalog, model, author, model, '', variables);
		return rows === null
			? [{ role: 'value', text: JSON.stringify(author) }]
			: rows.flatMap((n, i) => [
					...(i === 0 ? [] : [{ role: 'join' as const, text: 'and' }]),
					...nodeParts(catalog, model, n, humanize, named, opWords, bolt.locale)
				]);
	});
	const setRow = (i: number, n: FilterRow) =>
		view.setRows(view.rows.map((x, j) => (j === i ? n : x)));
	const setKey = (i: number, k: SortKey) =>
		view.setOrder(view.order.map((x, j) => (j === i ? k : x)));
	const move = (i: number, d: -1 | 1) => {
		const o = [...view.order];
		const selected = o[i], neighbor = o[i + d];
		if (selected === undefined || neighbor === undefined) return;
		[o[i], o[i + d]] = [neighbor, selected];
		view.setOrder(o);
	};
	function addSort(): void {
		const field = sortable.find((f) => !view.order.some((o) => o.field === f));
		if (field !== undefined) view.setOrder([...view.order, { field, dir: 'asc' }]);
	}
	function describe(e?: Event) {
		e?.preventDefault();
		if (busy || text.trim() === '') return;
		busy = true;
		applied = failed = false;
		fork(
			view.describe(text).pipe(
				Effect.tap((value) =>
					Effect.sync(() => {
						applied = value;
						failed = !value;
					})
				),
				Effect.ensuring(
					Effect.sync(() => {
						busy = false;
					})
				)
			)
		);
	}
</script>

<div class="flex min-w-0 flex-col gap-2" data-filter-panel>
	<header class="flex items-center gap-2" data-view-header>
		{#if describes && !readonly}
			<div class="flex min-w-0 flex-1 gap-2" data-describe>
				<input
					class={cn(CONTROL, 'flex-1')}
					type="text"
					maxlength={500}
					bind:value={text}
					oninput={() => (applied = failed = false)}
					onkeydown={(event) => {
						if (event.key === 'Enter') describe(event);
					}}
					disabled={busy}
					placeholder={msg(bolt, 'view.describe')}
					aria-label={msg(bolt, 'view.describe')}
				/>
				<button
					type="button"
					onclick={() => describe()}
					disabled={busy || text.trim() === ''}
					class="bg-primary text-primary-foreground grid size-8 shrink-0 place-items-center rounded-md disabled:opacity-50"
					aria-label={msg(bolt, 'view.apply')}
				>
					<Icon
						icon={busy ? 'lucide:loader-circle' : 'lucide:arrow-right'}
						class={cn('size-4', busy && 'animate-spin')}
					/>
				</button>
			</div>
		{:else}<p class="flex-1 text-sm font-medium">
				{msg(bolt, 'view.title')}
			</p>{/if}
		{#if !readonly && view.rows.length + view.order.length > 0}
			<button
				type="button"
				class="text-muted-foreground hover:text-foreground shrink-0 text-xs"
				data-clear
				onclick={() => view.clear()}>{msg(bolt, 'view.clearAll')}</button
			>
		{/if}
	</header>
	{#if busy}<p role="status" class="text-muted-foreground text-xs" data-view-loading>
			{msg(bolt, 'view.applying')}
		</p>
	{:else if applied}<p role="status" class="text-xs text-primary" data-view-applied>
			{msg(bolt, 'view.applied')}
		</p>{/if}
	<!-- a description that built nothing is an error the person must act on, never a quiet note beside "applied" -->
	{#if failed && view.notice}<p
			role="alert"
			class="text-destructive flex items-center gap-1 text-xs"
			data-view-error
		>
			<Icon icon="lucide:circle-alert" class="size-3.5 shrink-0" />{view.notice}
		</p>
	{:else if view.notice}<p role="status" class="text-muted-foreground text-xs" data-view-notice>
			{view.notice}
		</p>{/if}
	{#if authorParts !== null}
		<p class="text-muted-foreground flex flex-wrap items-center gap-1.5 text-xs" data-author-where>
			<Glyph name="lock" class="size-3 shrink-0" /><span class="shrink-0"
				>{msg(bolt, 'view.always')}:<span class="sr-only"
					>{msg(bolt, 'view.prefilter')}</span
				></span
			>
			<FilterSummary parts={authorParts} class="whitespace-normal break-words overflow-visible [&_[data-part=field]]:font-normal" />
		</p>
	{/if}

	<details open={expanded ?? !describes} class="group" data-view-details>
		<summary
			class="text-muted-foreground hover:text-foreground flex cursor-pointer list-none items-center gap-1 text-xs"
			data-show-builder
		>
			<Icon
				icon="lucide:chevron-right"
				class="size-3.5 transition-transform group-open:rotate-90"
			/>
			{msg(bolt, 'view.matchAll')}
		</summary>
		<div class="compact-controls mt-2 flex flex-col gap-2" data-view-builder>
			<section class="flex flex-col gap-1.5" data-filter-rows>
				{#each view.rows as n, i (i)}
					{#if readonly}
						<FilterSummary
							parts={nodeParts(catalog, model, n, humanize, named, opWords, bolt.locale)}
							class="whitespace-normal break-words overflow-visible text-xs text-muted-foreground [&_[data-part=field]]:font-normal [&_[data-part=value]]:text-muted-foreground"
						/>
					{:else}
						<FilterNode
							node={n}
							{catalog}
							{model}
							offers={view.offers}
							{variables}
							top
							on_change={(x) => setRow(i, x)}
							on_remove={() => view.setRows(view.rows.filter((_, j) => j !== i))}
						/>
					{/if}
				{/each}
				{#if !readonly}
					<AddFilter
						on_condition={() => view.setRows([...view.rows, blank])}
						on_group={() => view.setRows([...view.rows, { t: 'group', join: 'or', of: [blank] }])}
					/>
				{/if}
			</section>

			{#if sortable.length > 0 || view.order.length > 0}
				<details class="border-t pt-2" data-sort-rows>
					<summary class="text-muted-foreground cursor-pointer text-xs"
						>{msg(bolt, 'view.sort')} ({view.order.length})</summary
					>
					<div class="mt-2 flex flex-col gap-1.5">
						{#each view.order as k, i (k.field)}
							<div class="flex items-center gap-1.5" data-sort={k.field}>
								{#if readonly || k.near !== undefined}
									<!-- nearest first from a described place: shown, not re-pointed here -->
									<span class="text-sm" data-sort-near>{sortText(catalog, model, k, humanize)}</span
									>
								{:else}
									<Combobox
										class="w-auto"
										aria-label={msg(bolt, 'view.sortField')}
										value={k.field}
										on_change={(f) => {
											if (f !== null) setKey(i, { ...k, field: f });
										}}
										options={sortable
											.filter((f) => f === k.field || !view.order.some((o) => o.field === f))
											.map((f) => ({
												value: f,
												label: pathLabel(catalog, model, f, humanize)
											}))}
									/>
									<Combobox
										class="w-auto"
										aria-label={msg(bolt, 'view.direction')}
										value={k.dir}
										on_change={(d) => {
											if (d !== null) setKey(i, { ...k, dir: d });
										}}
										options={[
											{ value: 'asc' as const, label: msg(bolt, 'view.asc') },
											{ value: 'desc' as const, label: msg(bolt, 'view.desc') }
										]}
									/>
								{/if}
								{#if !readonly}
									<button
										type="button"
										class="text-muted-foreground hover:bg-muted grid size-8 place-items-center rounded-sm disabled:opacity-40"
										disabled={i === 0}
										aria-label={msg(bolt, 'view.up')}
										onclick={() => move(i, -1)}>↑</button
									>
									<button
										type="button"
										class="text-muted-foreground hover:bg-muted grid size-8 place-items-center rounded-sm disabled:opacity-40"
										disabled={i === view.order.length - 1}
										aria-label={msg(bolt, 'view.down')}
										onclick={() => move(i, 1)}>↓</button
									>
									<span class="flex-1"></span>
									<button
										type="button"
										class="text-muted-foreground hover:bg-muted grid size-8 place-items-center rounded-sm"
										aria-label={msg(bolt, 'view.removeRow')}
										data-remove
										onclick={() => view.setOrder(view.order.filter((_, j) => j !== i))}>×</button
									>
								{/if}
							</div>
						{/each}
						{#if !readonly && view.order.length < ORDER_MAX_KEYS && sortable.some((f) => !view.order.some((o) => o.field === f))}
							<button
								type="button"
								class="text-muted-foreground hover:text-foreground self-start text-xs"
								data-add-sort
								onclick={addSort}>+ {msg(bolt, 'view.addSort')}</button
							>
						{/if}
					</div>
				</details>
			{/if}
		</div>
	</details>
</div>

<style>
	.compact-controls :global([role='combobox']),
	.compact-controls :global([data-field-picker]),
	.compact-controls :global(input:not([type='checkbox'])) {
		height: 1.5rem;
		min-height: 1.5rem;
		padding: 0.125rem 0.25rem;
		border: 0;
		border-bottom: 1px dashed var(--color-border);
		border-radius: 0;
		background: transparent;
		box-shadow: none;
		--hit-target: 1.5rem;
	}
	.compact-controls :global([role='combobox']) {
		width: auto;
		max-width: 100%;
	}
	.compact-controls :global([data-field-picker]) {
		width: auto;
		max-width: 14rem;
		height: auto;
	}
	.compact-controls :global([role='combobox']:hover),
	.compact-controls :global([data-field-picker]:hover),
	.compact-controls :global(input:hover) {
		border-bottom-color: var(--color-muted-foreground);
	}
	.compact-controls :global([role='combobox']:focus-visible),
	.compact-controls :global([data-field-picker]:focus-visible),
	.compact-controls :global(input:focus-visible) {
		border-bottom-color: var(--color-primary);
		outline: 2px solid var(--color-ring);
		outline-offset: 1px;
	}
	.compact-controls :global([role='combobox'] svg),
	.compact-controls :global([data-field-picker] > svg) {
		width: 0.625rem;
		height: 0.625rem;
	}
	@media (pointer: coarse) {
		.compact-controls :global([role='combobox']),
		.compact-controls :global([data-field-picker]),
		.compact-controls :global(input:not([type='checkbox'])) {
			min-height: 2rem;
			--hit-target: 2rem;
		}
	}
</style>
