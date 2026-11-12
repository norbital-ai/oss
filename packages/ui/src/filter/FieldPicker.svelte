<script lang="ts">
	import type { UiContext } from '../client/contract.js';
	// The view popover's field tree with search (rule 16b): own fields, one-relations (a record condition, or expanded to
	// the target's fields, two hops) and, at the top, many-relations — exactly the paths the engine's catalogue offers.
	import FieldIndicator from './FieldIndicator.svelte';
	import * as Popover from '../primitives/popover/index.js';
	import { SvelteSet } from 'svelte/reactivity';
	import { tick } from 'svelte';
	import type { ModelExposure } from '../kinds/context.js';
	import { cn, stepActive } from '../primitives/utils.js';
	import { CONTROL } from '../kinds/classes.js';
	import { bolt_of } from '../client/context.js';
	import { filterable, INDEX, offeredPaths, resolve, childOf, type FilterStep, type Offer } from './catalog.js';
	import { pathLabel } from './text.js';
	import { humanize, msg } from '../text/messages.js';
	import type { Kind } from '@norbital-ai/std/kind';

	type Entry = { path: string; label: string; depth: number; many?: true; open?: boolean };
	let {
		ctx,
		catalog,
		model,
		offers,
		prefix = [],
		value,
		many = true,
		on_pick
	}: {
		ctx: UiContext;
		catalog: { readonly [c: string]: ModelExposure };
		model: string;
		/** The engine's catalogue for the view. */
		offers: readonly Offer[];
		/** The many-relation steps this picker sits under, so catalogue paths match. */
		prefix?: readonly FilterStep[];
		/** The chosen path (or many-relation); '' when none. */
		value: string;
		/** Offer many-relations (only at a view's top level). */
		many?: boolean;
		on_pick(path: string, many: boolean): void;
	} = $props();
	const bolt = $derived(bolt_of(ctx));
	let open = $state(false),
		query = $state(''),
		active = $state(0);
	let search = $state<HTMLInputElement | null>(null),
		list = $state<HTMLElement | null>(null);
	const expanded = new SvelteSet<string>();
	const offered = $derived(offeredPaths(offers, prefix));
	/** The view's own model (not under a many-relation): its search index and embedding are the toolbar's search box. */
	const root = $derived(prefix.length === 0);
	/** Machine data no member reads as a value: an embedding, or JSON with no typed shape (a record or list of bare JSON). */
	const opaque = (k: Kind | undefined): boolean =>
		k?.kind === 'vector' ||
		(k?.kind === 'json' &&
			(k.shape === undefined ||
				k.shape.kind === 'json' ||
				(k.shape.kind === 'record' && k.shape.of.kind === 'json')));

	function level(c: string, prefix: string, depth: number, all: boolean): Entry[] {
		const x = catalog[c];
		if (x === undefined) return [];
		const out: Entry[] = [];
		for (const f of [...Object.keys(x.fields), 'created_at', 'updated_at']) {
			if (
				x.relations?.[f] !== undefined ||
				opaque(x.fields[f]) ||
				(!filterable(x, f) && f !== 'created_at' && f !== 'updated_at')
			)
				continue;
			const path = prefix + f;
			if (
				resolve(catalog, model, path) !== null &&
				offered.conditions.has(path) &&
				!out.some((e) => e.path === path)
			)
				out.push({ path, label: pathLabel(catalog, c, f, humanize), depth });
		}
		// a related record's search index and embedding, where the engine's catalogue offers them
		if (depth > 0 || !root)
			for (const f of Object.keys(INDEX))
				if (offered.conditions.has(prefix + f) && resolve(catalog, model, prefix + f) !== null)
					out.push({ path: prefix + f, label: pathLabel(catalog, c, f, humanize), depth });
		for (const [fk, rel] of Object.entries(x.relations ?? {})) {
			for (const target of rel.targets) {
				const step = rel.targets.length > 1 ? `${fk}:${target}` : fk;
				const path = prefix + step;
				if (!offered.conditions.has(path)) continue;
				const canOpen = depth < 2 && catalog[target] !== undefined;
				const isOpen = all || expanded.has(path);
				out.push({
					path,
					label: pathLabel(catalog, c, step, humanize),
					depth,
					...(canOpen ? { open: isOpen } : {})
				});
				if (canOpen && isOpen)
					out.push(
						...level(
							target,
							`${path}.`,
							depth + 1,
							all
						)
					);
			}
		}
		if (depth === 0 && many)
			for (const rel of x.many ?? [])
				if (offered.many.has(rel))
					out.push({ path: rel, label: pathLabel(catalog, c, rel, humanize), depth, many: true });
		return out;
	}
	const entries = $derived.by(() => {
		const q = query.trim().toLowerCase();
		if (q === '') return level(model, '', 0, false);
		// a search walks the whole tree and shows each hit with its full path
		return level(model, '', 0, true)
			.map((e) => ({
				...e,
				label: pathLabel(catalog, model, e.path, humanize),
				depth: 0,
				open: undefined
			}))
			.filter((e) => e.label.toLowerCase().includes(q));
	});
	const selected = $derived(value === '' ? null : resolve(catalog, model, value));
	const selectedMany = $derived(childOf(catalog, model, value) !== undefined);
	const shown = $derived(value === '' ? '' : pathLabel(catalog, model, value, humanize));
	const pick = (e: Entry) => {
		on_pick(e.path, e.many === true);
		open = false;
		query = '';
	};
	/** The active row's id, announced from the box it leaves focus in. */
	const activeId = $derived(entries[active] === undefined ? undefined : `field-option-${active}`);
	function keydown(event: KeyboardEvent) {
		if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
			if (entries.length === 0) return;
			event.preventDefault();
			active = stepActive(entries.length, active, event.key === 'ArrowDown' ? 1 : -1);
			void tick().then(() =>
				list
					?.querySelector<HTMLElement>(`[data-index="${active}"]`)
					?.scrollIntoView({ block: 'nearest' })
			);
		} else if (event.key === 'Enter' && event.target === search) {
			const entry = entries[active];
			if (entry === undefined) return;
			event.preventDefault();
			pick(entry);
		}
	}
</script>

<Popover.Root
	bind:open
	on_open_change={(next) => {
		if (next)
			active = Math.max(
				0,
				entries.findIndex((e) => e.path === value)
			);
	}}
>
	<Popover.Trigger>
		{#snippet child({ props })}
			<button
				{...props}
				type="button"
				class={cn(
					CONTROL,
					'flex h-auto min-h-8 w-36 max-w-full items-center justify-between gap-2 px-2 py-1 text-left'
				)}
				aria-label={shown
					? `${msg(bolt, 'view.field')}: ${shown}`
					: msg(bolt, 'view.field')}
				data-field-picker
			>
				<FieldIndicator {ctx} resolved={selected} many={selectedMany} nested={value.includes('.')} />
				<span
					class={cn(
						'min-w-0 flex-1 whitespace-normal break-words',
						value === '' && 'text-muted-foreground font-normal'
					)}>{shown || msg(bolt, 'view.field')}</span
				>
				<svg
					viewBox="0 0 24 24"
					class="text-muted-foreground size-3.5 shrink-0"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
					aria-hidden="true"><path d="m7 15 5 5 5-5M7 9l5-5 5 5" /></svg
				>
			</button>
		{/snippet}
	</Popover.Trigger>
	<Popover.Content
		align="start"
		class="flex w-64 flex-col gap-1 p-1"
		aria-label={msg(bolt, 'view.field')}
		data-field-list
		onkeydown={keydown}
	>
		<input
			bind:this={search}
			class="border-input bg-background h-8 w-full rounded-sm border px-2 text-sm outline-none"
			type="search"
			role="combobox"
			aria-autocomplete="list"
			aria-controls="field-options"
			aria-expanded="true"
			aria-activedescendant={activeId}
			placeholder={msg(bolt, 'view.searchFields')}
			bind:value={query}
			oninput={() => (active = 0)}
		/>
		<p class="text-muted-foreground px-2 py-1 text-xs">
			{msg(bolt, 'view.fieldHelp'
			)}
		</p>
		<ul bind:this={list} id="field-options" class="max-h-64 overflow-auto" role="listbox">
			{#each entries as e, i (e.path)}
				<li
					id={`field-option-${i}`}
					class="flex items-center"
					role="option"
					aria-selected={e.path === value}
					data-index={i}
					data-active={i === active ? 'true' : undefined}
					style={e.depth > 0 ? `padding-left:${e.depth * 0.75}rem` : undefined}
				>
					<button
						type="button"
						class={cn(
							'hover:bg-muted flex min-w-0 flex-1 items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm',
							(e.path === value || i === active) && 'bg-muted'
						)}
						data-path={e.path}
						onmousemove={() => (active = i)}
						onclick={() => pick(e)}
					>
						<FieldIndicator {ctx}
							resolved={resolve(catalog, model, e.path)}
							many={e.many === true}
							nested={e.path.includes('.')}
						/>
						<span class="min-w-0 flex-1 truncate">{e.label}</span>{#if e.many}{' '}<span
								class="text-muted-foreground text-xs"
								>{msg(bolt, 'view.related')}</span
							>{/if}
					</button>
					{#if e.open !== undefined}
						<button
							type="button"
							class="text-muted-foreground hover:bg-muted grid size-8 shrink-0 place-items-center rounded-sm"
							data-expand={e.path}
							aria-label={msg(bolt, 'view.expand', { field: e.label })}
							aria-expanded={e.open}
							onclick={() =>
								expanded.has(e.path) ? expanded.delete(e.path) : expanded.add(e.path)}
						>
							<svg
								viewBox="0 0 24 24"
								class={cn('size-3.5 transition-transform', e.open && 'rotate-90')}
								fill="none"
								stroke="currentColor"
								stroke-width="2"
								aria-hidden="true"><path d="m9 18 6-6-6-6" /></svg
							>
						</button>
					{/if}
				</li>
			{:else}
				<li class="text-muted-foreground px-2 py-1.5 text-xs">
					{msg(bolt, 'view.noFields')}
				</li>
			{/each}
		</ul>
	</Popover.Content>
</Popover.Root>
