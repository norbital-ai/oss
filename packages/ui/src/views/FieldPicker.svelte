<script lang="ts">
	// The view popover's field tree with search (rule 16b): own fields, one-relations (a record condition, or expanded to
	// the target's fields, two hops) and, at the top, many-relations. Tight rows: no leading icon column, no top gap.
	import { SvelteSet } from 'svelte/reactivity';
	import type { CollectionExposure } from '../kinds/context.js';
	import { cn } from '../primitives/utils.js';
	import { CONTROL } from '../kinds/classes.js';
	import { useBolt } from './bolt.js';
	import { filterable, opsFor, pathLabel, resolve } from './filter.js';
	import { humanize, msg } from './model.js';

	type Entry = { path: string; label: string; depth: number; many?: true; open?: boolean };
	let { catalog, collection, value, many = true, onPick }: {
		catalog: { readonly [c: string]: CollectionExposure };
		collection: string;
		/** The chosen path (or many-relation); '' when none. */
		value: string;
		/** Offer many-relations (only at a view's top level). */
		many?: boolean;
		onPick(path: string, many: boolean): void;
	} = $props();
	const bolt = useBolt();
	let open = $state(false), query = $state('');
	const expanded = new SvelteSet<string>();

	function level(c: string, prefix: string, depth: number, all: boolean): Entry[] {
		const x = catalog[c];
		if (x === undefined) return [];
		const out: Entry[] = [];
		for (const f of [...Object.keys(x.fields), 'created_at', 'updated_at']) {
			if (x.relations?.[f] !== undefined || (!filterable(x, f) && f !== 'created_at' && f !== 'updated_at')) continue;
			const r = resolve(catalog, collection, prefix + f);
			if (r !== null && opsFor(r).length > 0 && !out.some((e) => e.path === prefix + f)) out.push({ path: prefix + f, label: pathLabel(catalog, c, f, humanize), depth });
		}
		for (const [fk, rel] of Object.entries(x.relations ?? {})) {
			for (const step of rel.targets.length > 1 ? rel.targets.map((t) => `${fk}:${t}`) : [fk]) {
				const path = prefix + step;
				if (resolve(catalog, collection, path) === null) continue;
				const canOpen = depth < 2 && catalog[step.includes(':') ? step.split(':')[1]! : rel.targets[0]!] !== undefined;
				const isOpen = all || expanded.has(path);
				out.push({ path, label: pathLabel(catalog, c, step, humanize), depth, ...(canOpen ? { open: isOpen } : {}) });
				if (canOpen && isOpen) out.push(...level(step.includes(':') ? step.split(':')[1]! : rel.targets[0]!, `${path}.`, depth + 1, all));
			}
		}
		if (depth === 0 && many) for (const rel of x.many ?? []) out.push({ path: rel, label: pathLabel(catalog, c, rel, humanize), depth, many: true });
		return out;
	}
	const entries = $derived.by(() => {
		const q = query.trim().toLowerCase();
		if (q === '') return level(collection, '', 0, false);
		// a search walks the whole tree and shows each hit with its full path
		return level(collection, '', 0, true).map((e) => ({ ...e, label: pathLabel(catalog, collection, e.path, humanize), depth: 0, open: undefined }))
			.filter((e) => e.label.toLowerCase().includes(q));
	});
	const shown = $derived(value === '' ? '' : pathLabel(catalog, collection, value, humanize));
	const pick = (e: Entry) => { onPick(e.path, e.many === true); open = false; query = ''; };
</script>

<div class="relative" onfocusout={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) open = false; }}
	onkeydown={(e) => { if (e.key === 'Escape' && open) { e.stopPropagation(); open = false; } }} role="presentation">
	<button type="button" class={cn(CONTROL, 'flex w-40 items-center justify-between gap-1 px-2 text-left')} aria-haspopup="listbox" aria-expanded={open}
		data-field-picker onclick={() => (open = !open)}>
		<span class={cn('min-w-0 truncate', value === '' && 'text-muted-foreground font-normal')}>{shown || msg(bolt, 'view.field', 'Field')}</span>
		<svg viewBox="0 0 24 24" class="text-muted-foreground size-3.5 shrink-0" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m7 15 5 5 5-5M7 9l5-5 5 5" /></svg>
	</button>
	{#if open}
		<div class="bg-popover absolute top-full left-0 z-40 mt-1 flex w-64 flex-col gap-1 rounded-md border p-1 shadow-md" data-field-list>
			<!-- svelte-ignore a11y_autofocus -->
			<input class="border-input bg-background h-8 w-full rounded-sm border px-2 text-sm outline-none" type="search" autofocus
				placeholder={msg(bolt, 'view.searchFields', 'Search fields')} bind:value={query} />
			<ul class="max-h-64 overflow-auto" role="listbox">
				{#each entries as e (e.path)}
					<li class="flex items-center" role="option" aria-selected={e.path === value} style={e.depth > 0 ? `padding-left:${e.depth * 0.75}rem` : undefined}>
						<button type="button" class={cn('hover:bg-muted min-w-0 flex-1 truncate rounded-sm px-2 py-1.5 text-left text-sm', e.path === value && 'bg-muted')}
							data-path={e.path} onclick={() => pick(e)}>
							{e.label}{#if e.many}<span class="text-muted-foreground ml-1 text-xs">{msg(bolt, 'view.related', 'related records')}</span>{/if}
						</button>
						{#if e.open !== undefined}
							<button type="button" class="text-muted-foreground hover:bg-muted grid size-7 shrink-0 place-items-center rounded-sm" data-expand={e.path}
								aria-label={msg(bolt, 'view.expand', 'Fields of {field}', { field: e.label })} aria-expanded={e.open}
								onclick={() => expanded.has(e.path) ? expanded.delete(e.path) : expanded.add(e.path)}>
								<svg viewBox="0 0 24 24" class={cn('size-3.5 transition-transform', e.open && 'rotate-90')} fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m9 18 6-6-6-6" /></svg>
							</button>
						{/if}
					</li>
				{:else}
					<li class="text-muted-foreground px-2 py-1.5 text-xs">{msg(bolt, 'view.noFields', 'No matching fields')}</li>
				{/each}
			</ul>
		</div>
	{/if}
</div>
