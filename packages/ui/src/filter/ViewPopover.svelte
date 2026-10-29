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
	import ToolbarFilter from '../model/toolbar/ToolbarFilter.svelte';
	import { cn } from '../primitives/utils.js';
	import type { Json } from '../client/contract.js';
	import { useBolt } from '../client/context.js';
	import {
		complete,
		fromWhere,
		nodeParts,
		ORDER_MAX_KEYS,
		pathLabel,
		pathOf,
		sortText,
		type Node as FilterRow,
		type Part,
		type SortKey
	} from './filter.js';
	import FilterNode from './FilterNode.svelte';
	import FilterSummary from './FilterSummary.svelte';
	import Glyph from '../primitives/icon/Glyph.svelte';
	import { recordLabels } from '../record/labels.svelte.js';
	import { humanize, msg } from '../text/messages.js';
	import { useKinds } from '../kinds/context.js';
	import type { ViewState } from './view-state.svelte.js';
	import { watch } from 'runed';

	let {
		view,
		catalog,
		model,
		author,
		sortable
	}: {
		view: ViewState;
		catalog: { readonly [c: string]: ModelExposure };
		model: string;
		/** The author's `where`: shown, never removable. */
		author?: Json;
		sortable: readonly string[];
	} = $props();
	const bolt = useBolt();
	const kinds = useKinds();
	const named = recordLabels(bolt, () => kinds.catalog ?? catalog);
	let open = $state(false),
		text = $state(''),
		busy = $state(false),
		applied = $state(false),
		failed = $state(false);
	watch(
		() => [open, view, view.offersKey],
		() => {
			if (open) fork(view.loadOffers());
		}
	);
	let details: HTMLDetailsElement | null = $state(null);
	const blank: FilterRow = { t: 'cond', path: '', op: 'eq', arg: null };
	// the badge counts what applies: an incomplete row (a field, no value yet) is not sent
	const count = $derived(view.rows.filter(complete).length + view.order.length);
	const describes = $derived(bolt.describe !== undefined);
	/** The catalogue's words for an operator on a path (the fallback is the machine operator). */
	const opWords = (op: string, path: string) =>
		view.offers.find((o) => o.op === op && pathOf(o.path).endsWith(path))?.opLabel ?? op;
	const authorParts = $derived.by((): Part[] | null => {
		if (author === undefined || author === null) return null;
		const rows = fromWhere(catalog, model, author);
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
		[o[i], o[i + d]] = [o[i + d]!, o[i]!];
		view.setOrder(o);
	};
	function describe(e: SubmitEvent) {
		e.preventDefault();
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

<!-- portaled, so a sticky table header never paints over it  -->
<ToolbarFilter
	bind:open
	{count}
	label={msg(bolt, 'view.filterSort', 'Filter and sort')}
	panelClass="w-[min(46rem,calc(100vw-2rem))]"
	onOpenChange={(o) => {
		if (o) {
			applied = failed = false;
			if (details) details.open = !describes;
		}
	}}
>
	<header class="flex items-center gap-2" data-view-header>
		{#if describes}
			<form class="flex min-w-0 flex-1 gap-2" onsubmit={describe} data-describe>
				<input
					class={cn(CONTROL, 'h-9 min-w-0 flex-1')}
					type="text"
					maxlength={500}
					bind:value={text}
					oninput={() => (applied = failed = false)}
					disabled={busy}
					placeholder={msg(bolt, 'view.describe', 'Describe what to show…')}
					aria-label={msg(bolt, 'view.describe', 'Describe what to show…')}
				/>
				<button
					type="submit"
					disabled={busy || text.trim() === ''}
					class="bg-primary text-primary-foreground grid size-9 shrink-0 place-items-center rounded-md disabled:opacity-50"
					aria-label={msg(bolt, 'view.apply', 'Apply filter and sort')}
				>
					<Icon
						icon={busy ? 'lucide:loader-circle' : 'lucide:arrow-right'}
						class={cn('size-4', busy && 'animate-spin')}
					/>
				</button>
			</form>
		{:else}<p class="flex-1 text-sm font-medium">
				{msg(bolt, 'view.title', 'Filters & sort')}
			</p>{/if}
		{#if view.rows.length + view.order.length > 0}
			<button
				type="button"
				class="text-muted-foreground hover:text-foreground shrink-0 text-xs"
				data-clear
				onclick={() => view.clear()}>{msg(bolt, 'view.clearAll', 'Clear all')}</button
			>
		{/if}
	</header>
	{#if busy}<p role="status" class="text-muted-foreground text-xs" data-view-loading>
			{msg(bolt, 'view.applying', 'Applying filter and sort…')}
		</p>
	{:else if applied}<p role="status" class="text-xs text-primary" data-view-applied>
			{msg(bolt, 'view.applied', 'Filter and sort applied')}
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
	<details bind:this={details} open={!describes} class="group" data-view-details>
		<summary
			class="text-muted-foreground hover:text-foreground flex cursor-pointer list-none items-center gap-1 text-xs"
			data-show-builder
		>
			<Icon
				icon="lucide:chevron-right"
				class="size-3.5 transition-transform group-open:rotate-90"
			/>
			{msg(bolt, 'view.editConditions', 'Edit conditions')}{#if count > 0}
				({count}){/if}
		</summary>
		<div class="mt-3 flex flex-col gap-3" data-view-builder>
			{#if authorParts !== null}
				<p
					class="bg-muted/50 text-muted-foreground flex items-center gap-1 rounded-sm px-2 py-1.5 text-xs"
					data-author-where
				>
					<Glyph name="lock" class="size-3 shrink-0" /><span class="shrink-0"
						>{msg(bolt, 'view.always', 'Always')}:</span
					>
					<FilterSummary parts={authorParts} />
				</p>
			{/if}
			<section class="flex flex-col gap-1.5" data-filter-rows>
				{#if view.rows.length > 1}
					<p class="text-muted-foreground text-xs" data-rows-heading>
						{msg(bolt, 'view.matchAll', 'Show records that match all of:')}
					</p>
				{/if}
				{#each view.rows as n, i (i)}
					{#if i > 0}
						<!-- top-level rows always all hold (each is its own link clause); "Add group" holds an any-of -->
						<span
							class="text-muted-foreground text-[11px] font-medium tracking-wide uppercase"
							data-join="and">{msg(bolt, 'view.and', 'and')}</span
						>
					{/if}
					<FilterNode
						node={n}
						{catalog}
						{model}
						offers={view.offers}
						top
						onChange={(x) => setRow(i, x)}
						onRemove={() => view.setRows(view.rows.filter((_, j) => j !== i))}
					/>
				{/each}
				<div class="flex gap-3 text-xs">
					<button
						type="button"
						class="text-muted-foreground hover:text-foreground"
						data-add-condition
						onclick={() => view.setRows([...view.rows, blank])}
						>+ {msg(bolt, 'view.addCondition', 'Add condition')}</button
					>
					<button
						type="button"
						class="text-muted-foreground hover:text-foreground"
						data-add-group
						onclick={() => view.setRows([...view.rows, { t: 'group', join: 'or', of: [blank] }])}
						>+ {msg(bolt, 'view.addGroup', 'Add group')}</button
					>
				</div>
			</section>

			{#if sortable.length > 0 || view.order.length > 0}
				<section class="flex flex-col gap-1.5 border-t pt-3" data-sort-rows>
					<p class="text-muted-foreground text-xs font-medium">
						{msg(bolt, 'view.sort', 'Sort')}
					</p>
					{#each view.order as k, i (k.field)}
						<div class="flex items-center gap-1.5" data-sort={k.field}>
							{#if k.near !== undefined}
								<!-- nearest first from a described place: shown, not re-pointed here -->
								<span class="text-sm" data-sort-near>{sortText(catalog, model, k, humanize)}</span>
							{:else}
								<Combobox
									class="w-auto"
									aria-label={msg(bolt, 'view.sortField', 'Sort by')}
									value={k.field}
									onChange={(f) => {
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
									aria-label={msg(bolt, 'view.direction', 'Direction')}
									value={k.dir}
									onChange={(d) => {
										if (d !== null) setKey(i, { ...k, dir: d });
									}}
									options={[
										{ value: 'asc' as const, label: msg(bolt, 'view.asc', 'Ascending') },
										{ value: 'desc' as const, label: msg(bolt, 'view.desc', 'Descending') }
									]}
								/>
							{/if}
							<button
								type="button"
								class="text-muted-foreground hover:bg-muted grid size-9 place-items-center rounded-sm disabled:opacity-40"
								disabled={i === 0}
								aria-label={msg(bolt, 'view.up', 'Move up')}
								onclick={() => move(i, -1)}>↑</button
							>
							<button
								type="button"
								class="text-muted-foreground hover:bg-muted grid size-9 place-items-center rounded-sm disabled:opacity-40"
								disabled={i === view.order.length - 1}
								aria-label={msg(bolt, 'view.down', 'Move down')}
								onclick={() => move(i, 1)}>↓</button
							>
							<span class="flex-1"></span>
							<button
								type="button"
								class="text-muted-foreground hover:bg-muted grid size-9 place-items-center rounded-sm"
								aria-label={msg(bolt, 'view.removeRow', 'Remove')}
								data-remove
								onclick={() => view.setOrder(view.order.filter((_, j) => j !== i))}>×</button
							>
						</div>
					{/each}
					{#if view.order.length < ORDER_MAX_KEYS && sortable.some((f) => !view.order.some((o) => o.field === f))}
						<button
							type="button"
							class="text-muted-foreground hover:text-foreground self-start text-xs"
							data-add-sort
							onclick={() =>
								view.setOrder([
									...view.order,
									{
										field: sortable.find((f) => !view.order.some((o) => o.field === f))!,
										dir: 'asc'
									}
								])}>+ {msg(bolt, 'view.addSort', 'Add sort')}</button
						>
					{/if}
				</section>
			{/if}
		</div>
	</details>
</ToolbarFilter>
