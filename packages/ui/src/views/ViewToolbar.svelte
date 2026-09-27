<script lang="ts" module>
	import type { Snippet } from 'svelte';
	import type { ActionInputOf, ActionKey, AutomationInputOf, AutomationKey, Row } from './bolt.js';

	type IdIn<R> = R extends { readonly id: infer I extends string } ? I : string;
	/**
	 * Where an item sits in the actions menu: `bulk` (over the selected rows), `import` (with Import and Export CSV), or
	 * `general`. Default: `bulk` for an item that `requiresSelection`, else `general`.
	 */
	export type ToolbarGroup = 'bulk' | 'import' | 'general';
	/** What every actions-menu item carries: its words, its place, and why it cannot run now (shown instead of `description`). */
	type ItemMeta<R> = {
		label: string;
		/** One line under the label. */
		description?: string;
		/** An Iconify id (`lucide:upload`); default by kind. */
		icon?: string;
		group?: ToolbarGroup;
		/** Turns row selection on; the item is disabled until rows are selected. */
		requiresSelection?: true;
		/** Why the item cannot run now (over this selection), or null when it can. */
		disabled?: (selected: IdIn<R>[]) => string | null;
	};
	/**
	 * An author's actions-menu item (§3.6): a collection action over the selection, an automation whose run the toolbar
	 * shows, or the page's own handler (`run`: an import, a template download, a view toggle). The toolbar owns every
	 * page-level action: none sits in the app header or above the view.
	 */
	export type ToolbarItem<R = Row> =
		| { [A in ActionKey]: ItemMeta<R> & { action: A; input?: (selected: IdIn<R>[]) => ActionInputOf<A>; confirm?: string } }[ActionKey]
		| { [A in AutomationKey]: ItemMeta<R> & { start: A; input: (selected: IdIn<R>[]) => AutomationInputOf<A> } }[AutomationKey]
		| ItemMeta<R> & { run: (selected: IdIn<R>[]) => unknown };
	/**
	 * A view's whole chrome, one shape on `Table`, `Board`, `Map` and `Pivot`. Every key defaults from the collection's
	 * declaration and the viewer's grants; `toolbar={false}` renders none.
	 */
	export type Toolbar<R = Row> = false | {
		/** Default: the collection's label. */
		title?: string | false;
		/** Behind the info icon. Default: the collection's declared description, else its model's. */
		description?: string | false;
		/** Default on where the collection declares search fields. */
		search?: boolean;
		/** The filter-and-sort popover (rule 16b). Default on. */
		filter?: boolean;
		/** Author items in the actions menu, after the collection's callables; `false` hides the menu. */
		actions?: readonly ToolbarItem<R>[] | false;
		/** "Export CSV" of the rows in view. Default on; replaced by "Export" when the collection declares an export pipeline. */
		export?: boolean;
		/** "Delete selected" when the viewer may delete (turns selection on). Default off. */
		delete?: boolean;
		/** Row checkboxes (`Table`). Default: on when an item needs the selection. */
		select?: boolean;
		/** The New button: the record sheet in create mode, or the author's own (a prefilled create). Default: the viewer may create. */
		new?: boolean | (() => void);
		/** The page's own scope controls (a period picker, an entity picker), placed in the toolbar before search. Never actions. */
		controls?: Snippet;
	};
	type Exporter = { fields: readonly string[]; labels: readonly string[]; read: () => PromiseLike<unknown> };
</script>

<script lang="ts">
	import { Button } from '../primitives/button/index.js';
	import * as Popover from '../primitives/popover/index.js';
	import { useKinds, type CollectionExposure } from '../kinds/context.js';
	import FormView from '../form/form.svelte';
	import type { Json } from './bolt.js';
	import { getAllContexts, tick, untrack, onDestroy } from 'svelte';
	import Editor from '../kinds/editor.svelte';
	import { initial, problems } from '../kinds/kind.js';
	import { uiText } from '../primitives/utils.js';
	import { offerContexts, openRecord, useBolt, type Outcome } from './bolt.js';
	import { nodeText, pathLabel } from './filter.js';
	import { filesOf, humanize, label, msg, refOf, rowsOf, searchIndexes, SEMANTIC_SEARCH, show, SLASH, unref, valueAt, type SearchIndex } from './model.js';
	import type { ViewState } from './view-state.svelte.js';
	import Glyph, { type GlyphName } from './Glyph.svelte';
	import Icon from '../primitives/icon/icon-wrapper.svelte';
	import RunStatus from './RunStatus.svelte';
	import ViewPopover from './ViewPopover.svelte';
	import { notify } from './notify.js';
	import { recordLabels } from './live.svelte.js';

	let {
		config = {}, collection, view, catalog, source = collection, author, sortable = [], q = $bindable(''), searchable = false,
		selected, onSettled, exporter, onAdd, onProbe,
	}: {
		config?: Toolbar | undefined;
		/** The collection the defaults come from; `''` for a source without one. */
		collection: string;
		view?: ViewState;
		catalog: { readonly [c: string]: CollectionExposure };
		/** The view popover's collection (a local array's `$local`). */
		source?: string;
		author?: Json;
		sortable?: readonly string[];
		q?: string;
		searchable?: boolean;
		/** The selected ids when the view selects rows (then a record action runs over one of them). */
		selected?: readonly string[] | undefined;
		/** After an act over the selection settles. */
		onSettled?: () => void;
		exporter?: Exporter;
		/** A local array's "Add row", in New's place. */
		onAdd?: () => void;
		/** A typed index's search (`/<similarity>` or `/<query>` and its input), or `null` back to the box's text; absent: the view shows no ranked rows. */
		onProbe?: (probe: { name: string; via: 'similar' | 'query'; input: Json } | null) => void;
	} = $props();
	const bolt = useBolt();
	const kinds = useKinds();
	const cfg = $derived(config === false ? null : config ?? {});
	const x = $derived(catalog[collection] ?? kinds.catalog?.[collection]);
	const title = $derived(cfg?.title === false ? '' : cfg?.title ?? (collection === '' ? '' : label(bolt, collection)));
	const about = $derived(cfg?.description === false ? '' : cfg?.description ?? x?.description ?? '');
	const offered = $derived(searchable && cfg?.search !== false);
	// L-BOLT-495: `/` at the start of the box lists the collection's search indexes; the picked one is a chip. `semantic`
	// keeps the box as its text (`/semantic <text>`, rule 16); a typed similarity swaps the box for its input's editors and
	// hands the view its probe. Backspace on an empty box (or the chip's ×) is back to the lexical search.
	const t = uiText();
	const lexical = $derived(collection === '' || (x?.search?.length ?? 0) > 0);
	const indexes = $derived(offered ? searchIndexes(x, onProbe !== undefined, { meaning: t('searchMeaning'), raw: t('searchRaw'), view: t('searchView') }) : []);
	// the search icon exists only over something searchable: the collection's search fields or a declared index
	const canSearch = $derived(offered && (lexical || indexes.length > 0));
	const fieldsSearched = $derived((x?.search ?? []).map((s) => pathLabel(catalog, collection, s, humanize)));
	let index = $state<string | null>(untrack(() => SEMANTIC_SEARCH.test(q) ? 'semantic' : null));
	let text = $state(untrack(() => q.replace(SEMANTIC_SEARCH, '')));
	let values = $state<{ [f: string]: Json }>({});
	let box = $state<HTMLInputElement>();
	const chosen = $derived(indexes.find((i) => i.name === index));
	// a `/…` with no index chosen is the picker's, never a search term: the rows stay unfiltered
	const picking = $derived(index === null && SLASH.test(text));
	const menuOf = $derived(picking ? indexes.filter((i) => i.name.startsWith(text.slice(1))) : []);
	const ready = $derived(chosen?.input !== undefined && Object.entries(chosen.input).every(([f, k]) => problems(k, values[f] ?? null).size === 0));
	// what the view reads: the text, `/semantic <text>`, or nothing while a typed index or the `/` list holds the box
	const send = () => (q = index === 'semantic' ? (text.trim() === '' ? '' : `/semantic ${text}`) : index === null && lexical && !SLASH.test(text) ? text : '');
	async function pick(i: SearchIndex) {
		if (i.why !== null) return;
		index = i.name;
		text = '';
		values = Object.fromEntries(Object.entries(i.input ?? {}).map(([f, k]) => [f, initial(k)]));
		send();
		await tick();
		box?.focus();
	}
	function clear() {
		if (chosen?.input !== undefined) onProbe?.(null);
		index = null;
		send();
	}
	function typing(value: string) {
		text = value;
		const named = index === null ? /^\/(\S+)\s$/.exec(value)?.[1] : undefined;
		const i = indexes.find((x) => x.name === named);
		if (i !== undefined && i.why === null) return void pick(i);
		send();
	}
	function key(e: KeyboardEvent) {
		if (e.key === 'Backspace' && index !== null && text === '') { e.preventDefault(); clear(); }
		else if (e.key === 'Enter' && menuOf.length > 0) {
			e.preventDefault();
			const first = menuOf.find((i) => i.why === null);
			if (first !== undefined) void pick(first);
		}
	}
	const canFilter = $derived(view !== undefined && cfg?.filter !== false);
	const canNew = $derived(cfg?.new !== false && (onAdd !== undefined || typeof cfg?.new === 'function' || (collection !== '' && x?.create !== undefined)));
	// the page's contexts ride into the shell's sheet, which mounts outside the page (its create scope)
	const contexts = getAllContexts();
	// svelte-ignore state_referenced_locally
	onDestroy(collection === '' ? () => {} : offerContexts(collection, contexts));
	const create = () => onAdd ? onAdd() : typeof cfg?.new === 'function' ? cfg.new() : openRecord(collection, 'new', contexts);
	const searchHint = $derived.by(() => {
		const f = (x?.search ?? []).slice(0, 3).map((s) => pathLabel(catalog, collection, s, humanize));
		return f.length === 0 ? msg(bolt, 'table.search', 'Search') : msg(bolt, 'table.searchIn', 'Search {fields}', { fields: f.join(', ') });
	});

	// ── the actions menu: callables, the integration's run, export, delete-selected, the author's items ──
	const callables = $derived(cfg?.actions === false ? [] : Object.entries(x?.actions ?? {}).flatMap(([name, a]) => a.target === 'record' && selected === undefined ? [] : [{ name, ...a }]));
	const picked = $derived(selected ?? []);
	const items = $derived(cfg?.actions === false || cfg?.actions === undefined ? [] : cfg.actions);
	const sync = $derived(cfg?.actions !== false && x?.integration === true);
	// the collection's `+pipeline.ts` feeds the viewer may run, each a `<c>.pipeline` run (§3.3.5)
	const feeds = $derived(cfg?.actions === false ? undefined : x?.pipeline);
	const canImport = $derived(feeds?.import !== undefined && kinds.upload !== undefined);
	const canExport = $derived(cfg?.actions !== false && cfg?.export !== false && exporter !== undefined && feeds?.export === undefined);
	const canDelete = $derived(cfg?.actions !== false && cfg?.delete === true && x?.delete === true);
	// every entry of the menu, each in its group (bulk, import, general); a callable's entry opens its form inline
	type Entry = { key: string; group: ToolbarGroup; glyph: GlyphName; icon?: string; text: string; hint?: string; why: string | null; onclick: () => void;
		danger?: true; form?: { callable: string; target: string | undefined } };
	const entries = $derived.by((): Entry[] => {
		const ids = [...picked] as never;
		const selectFirst = msg(bolt, 'view.selectRows', 'Select rows first');
		return [
			...callables.map((c): Entry => {
				const callable = `${collection}.${c.name}`;
				return { key: callable, group: c.target === 'record' ? 'bulk' : 'general', glyph: 'play', text: humanize(c.name), hint: c.description,
					why: c.target === 'record' && picked.length !== 1 ? msg(bolt, 'view.selectOne', 'Select one row') : null,
					onclick: () => (form = form === callable ? null : callable), form: { callable, target: c.target } };
			}),
			...items.map((item): Entry => ({ key: `item:${item.label}`, group: item.group ?? (item.requiresSelection ? 'bulk' : 'general'),
				glyph: 'start' in item ? 'sync' : 'play', text: item.label, why: item.disabled?.(ids) ?? (item.requiresSelection && picked.length === 0 ? selectFirst : null),
				onclick: () => run(item), ...(item.icon === undefined ? {} : { icon: item.icon }), ...(item.description === undefined ? {} : { hint: item.description }) })),
			...(sync ? [{ key: 'sync', group: 'import', glyph: 'sync', text: msg(bolt, 'view.sync', 'Sync now'), hint: msg(bolt, 'view.syncHint', 'Pull the latest records from the source'),
				why: null, onclick: () => start(`${collection}.integration`, { mode: 'pull' }) } satisfies Entry] : []),
			...(canImport ? [{ key: 'import', group: 'import', glyph: 'upload', text: msg(bolt, 'view.import', 'Import…'), hint: feeds?.import, why: null,
				onclick: () => picker?.click() } satisfies Entry] : []),
			...(feeds?.export !== undefined ? [{ key: 'export-feed', group: 'import', glyph: 'download', text: msg(bolt, 'view.exportFeed', 'Export'), hint: feeds.export, why: null,
				onclick: () => start(`${collection}.pipeline`, { mode: 'export' }) } satisfies Entry] : []),
			...(canExport ? [{ key: 'export', group: 'import', glyph: 'download', text: msg(bolt, 'table.export', 'Export CSV'), hint: msg(bolt, 'view.exportHint', 'The rows in view, as shown'),
				why: null, onclick: exportCsv } satisfies Entry] : []),
			...(canDelete ? [{ key: 'delete', group: 'bulk', glyph: 'trash', text: msg(bolt, 'table.delete', 'Delete selected'), why: picked.length === 0 ? selectFirst : null,
				onclick: remove, danger: true } satisfies Entry] : []),
		];
	});
	const groups = $derived(([['bulk', msg(bolt, 'view.group.bulk', 'Bulk')], ['import', msg(bolt, 'view.group.import', 'Import & export')], ['general', msg(bolt, 'view.group.general', 'General')]] as const)
		.map(([g, title]) => ({ g, title, of: entries.filter((e) => e.group === g) })).filter((x) => x.of.length > 0));
	const menu = $derived(entries.length > 0);

	let searchOpen = $state(false), menuOpen = $state(false), busy = $state(false);
	// the icon reads as on while a search holds the view
	const searching = $derived(text !== '' || index !== null);
	let picker = $state<HTMLInputElement>();
	let form = $state<string | null>(null);
	let notice = $state<string | null>(null);
	let runs = $state<{ automation: string; id: string }[]>([]);
	const say = (o: Outcome, saved?: string) => {
		notify(bolt, o, saved);
		if (o.kind === 'committed') for (const f of filesOf(o.output)) window.open(bolt.fileUrl(f), '_blank', 'noopener');
		if (o.kind === 'committed' || o.kind === 'pendingApproval') onSettled?.();
	};
	const start = (automation: string, input: Json) => {
		runs = [...runs, { automation, id: bolt.start(automation, input).id }];
		menuOpen = false;
	};
	async function run(item: ToolbarItem) {
		const ids = [...picked];
		if ('run' in item) { menuOpen = false; return void (await item.run(ids as never)); }
		if ('start' in item) return start(item.start, item.input(ids) as Json);
		if (item.confirm !== undefined && !confirm(item.confirm)) return;
		menuOpen = false;
		say(await bolt.act(item.action, (item.input?.(ids) ?? { target: ids }) as Json));
	}
	// the file is uploaded to `<c>.$import` (the member's own), then the run reads it back as the feed's input
	async function importFile(file: File | undefined) {
		if (file === undefined || kinds.upload === undefined) return;
		busy = true;
		try {
			const ref = await kinds.upload(file, `${collection}.$import`);
			start(`${collection}.pipeline`, { mode: 'import', file: ref.id });
		} catch (e) {
			notice = e instanceof Error ? e.message : String(e);
		} finally {
			busy = false;
			if (picker) picker.value = '';
		}
	}
	async function remove() {
		if (!confirm(msg(bolt, 'table.confirmDelete', 'Delete {n} rows?', { n: picked.length }))) return;
		menuOpen = false;
		say(await bolt.act(`${collection}.delete`, { target: [...picked] }), msg(bolt, 'outcome.deleted', 'Deleted'));
	}
	// a download the browser builds (§3.6): the rows in view, the view's columns, labels as shown
	async function exportCsv() {
		if (exporter === undefined) return;
		busy = true;
		try {
			const rows = unref(kinds.catalog, collection, exporter.fields, rowsOf(await exporter.read()), bolt.locale);
			const cell = (s: string) => /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
			const text = [exporter.labels, ...rows.map((r) => exporter.fields.map((f) => refOf(r, f)?.text ?? show(valueAt(r, f), bolt.locale)))]
				.map((line) => line.map(cell).join(',')).join('\r\n');
			const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([text], { type: 'text/csv' })), download: `${collection || 'rows'}.csv` });
			a.click();
			URL.revokeObjectURL(a.href);
			menuOpen = false;
		} catch (e) {
			notice = e instanceof Error ? e.message : String(e);
		} finally {
			busy = false;
		}
	}
	const named = recordLabels(bolt, () => kinds.catalog ?? catalog);
	const chips = $derived(view === undefined ? [] : view.rows.map((n, i) => ({ i, text: nodeText(catalog, source, n, humanize, named) })));
</script>

{#snippet menuRow(e: Entry)}
	<button type="button" class="hover:bg-accent flex w-full items-start gap-2 rounded-sm px-2 py-1.5 text-left text-sm disabled:cursor-not-allowed disabled:opacity-50 {e.danger ? 'text-destructive' : ''}"
		disabled={e.why !== null || busy} title={e.why ?? undefined} onclick={e.onclick} data-menu-item={e.key}>
		{#if e.icon}<Icon name={e.icon} class="text-muted-foreground mt-0.5 size-4 shrink-0" />{:else}<Glyph name={e.glyph} class="text-muted-foreground mt-0.5 size-4 shrink-0" />{/if}
		<span class="min-w-0 flex-1"><span class="block font-medium">{e.text}</span>
			{#if e.hint || e.why}<span class="text-muted-foreground block text-xs">{e.why ?? e.hint}</span>{/if}</span>
	</button>
{/snippet}

{#if cfg !== null}
	<div class="@container flex min-w-0 flex-col gap-1.5" data-view-toolbar>
		{#if canImport}<input bind:this={picker} type="file" accept=".json,application/json" class="hidden" data-view-import
			onchange={(e) => importFile(e.currentTarget.files?.[0])} />{/if}
		<div class="flex min-w-0 flex-wrap items-center gap-1">
			{#if title}<h2 class="min-w-0 truncate text-sm font-semibold" data-view-title>{title}</h2>{/if}
			{#if about}
				<!-- a popover, not a hover tooltip: a tap on a phone opens it too -->
				<Popover.Root>
					<Popover.Trigger class="text-muted-foreground hover:bg-accent hover:text-foreground grid size-8 shrink-0 place-items-center rounded-sm"
						aria-label={msg(bolt, 'view.about', 'About {what}', { what: title || label(bolt, collection) })} title={about} data-view-about><Glyph name="info" /></Popover.Trigger>
					<Popover.Content align="start" class="w-[min(22rem,calc(100vw-1rem))] p-3 text-sm leading-relaxed" data-view-description>{about}</Popover.Content>
				</Popover.Root>
			{/if}
			<span class="flex-1"></span>
			{#if cfg.controls}<div class="flex min-w-0 flex-wrap items-center gap-1" data-view-controls>{@render cfg.controls()}</div>{/if}
			{#if canSearch}
				<!-- the search is an icon: its popover opens with the box focused, and says what it searches and which
				     `/` commands the collection offers -->
				<Popover.Root bind:open={searchOpen}>
					<Popover.Trigger>
						{#snippet child({ props })}
							<Button {...props} size="icon" variant="ghost" class={searching ? 'bg-accent' : ''} hint={searchHint} aria-label={searchHint} data-search-toggle>
								<Glyph name="search" />
							</Button>
						{/snippet}
					</Popover.Trigger>
					<Popover.Content align="end" class="flex w-[min(26rem,calc(100vw-1rem))] flex-col gap-2 p-2" data-search-panel
						onOpenAutoFocus={(e) => { e.preventDefault(); box?.focus(); }}>
						<div class="border-input bg-background focus-within:ring-ring/50 flex min-h-8 flex-wrap items-center gap-1 rounded-sm border px-2 shadow-xs focus-within:ring-[3px]">
							<Glyph name="search" class="text-muted-foreground size-4 shrink-0" />
							{#if index !== null}
								<span class="bg-accent inline-flex h-6 shrink-0 items-center gap-1 rounded-full pr-1 pl-2 text-xs" title={chosen?.hint} data-search-index={index}>
									/{index}<button type="button" class="hover:bg-background grid size-4 place-items-center rounded-full" aria-label={t('searchClear')} onclick={clear}><Glyph name="x" class="size-3" /></button>
								</span>
							{/if}
							{#if chosen?.input !== undefined}
								<!-- a typed similarity: its input fields' own editors, run on submit through the view's similar read -->
								<form class="flex flex-1 flex-wrap items-end gap-2 py-1.5" data-similar-input={index}
									onsubmit={(e) => { e.preventDefault(); if (ready) onProbe?.({ name: index!, via: chosen?.via ?? 'similar', input: { ...values } }); }}>
									{#each Object.entries(chosen.input) as [f, k] (f)}
										<div class="grid min-w-24 gap-1 text-xs" data-similar-field={f}><span class="text-muted-foreground">{k.label ?? humanize(f)}</span>
											<Editor kind={k} value={values[f] ?? null} onChange={(v) => (values = { ...values, [f]: v })} name={f} /></div>
									{/each}
									<Button type="submit" size="sm" disabled={!ready} data-similar-run><Glyph name="search" />{t('searchRun')}</Button>
								</form>
							{:else}
								<input bind:this={box} class="h-8 min-w-0 flex-1 bg-transparent text-base outline-none @xl:text-sm" type="search"
									placeholder={index === 'semantic' ? t('searchMeaning') : lexical ? `${searchHint}${indexes.length > 0 ? ` · ${t('searchCommands')}` : ''}` : t('searchPick')} aria-label={searchHint}
									value={text} oninput={(e) => typing(e.currentTarget.value)}
									onkeydown={(e) => { if (e.key === 'Enter' && !picking) searchOpen = false; else key(e); }} data-search />
							{/if}
						</div>
						{#if picking}
							<div class="grid gap-0.5" role="listbox" data-search-indexes>
								{#if menuOf.length === 0}<p class="text-muted-foreground px-2 py-1.5 text-sm" data-search-none>{indexes.length === 0 ? t('searchNone') : t('noResults')}</p>{/if}
								{#each menuOf as i (i.name)}
									<button type="button" role="option" aria-selected="false" class="hover:bg-accent rounded-sm px-2 py-1.5 text-left text-sm disabled:cursor-not-allowed disabled:opacity-60"
										disabled={i.why !== null} title={i.why ?? i.hint} onclick={() => pick(i)} data-search-option={i.name}>
										<span class="block font-medium">/{i.name}</span><span class="text-muted-foreground block text-xs">{i.why ?? i.hint}</span>
									</button>
								{/each}
							</div>
						{:else if index === null && text === ''}
							<!-- what this box searches, and the commands `/` offers -->
							<div class="text-muted-foreground grid gap-1.5 px-1 pb-1 text-xs" data-search-help>
								{#if lexical && fieldsSearched.length > 0}
									<p data-search-fields>{t('searchFields').replace('{fields}', fieldsSearched.join(', '))}</p>
								{/if}
								{#if indexes.length > 0}
									<p class="font-medium">{t('searchCommands')}</p>
									{#each indexes as i (i.name)}
										<button type="button" class="hover:bg-accent hover:text-foreground -mx-1 flex items-baseline gap-2 rounded-sm px-1 py-0.5 text-left disabled:cursor-not-allowed disabled:opacity-60"
											disabled={i.why !== null} title={i.why ?? i.hint} onclick={() => pick(i)} data-search-command={i.name}>
											<span class="text-foreground font-mono">/{i.name}</span><span class="truncate">{i.why ?? i.hint}</span>
										</button>
									{/each}
								{/if}
							</div>
						{/if}
					</Popover.Content>
				</Popover.Root>
			{/if}
			{#if canFilter && view !== undefined}<ViewPopover {view} {catalog} collection={source} {author} {sortable} />{/if}
			{#if menu}
				<Popover.Root bind:open={menuOpen}>
					<Popover.Trigger>
						{#snippet child({ props })}
							<Button {...props} size="icon" variant="ghost" hint={msg(bolt, 'view.actions', 'Actions')} aria-label={msg(bolt, 'view.actions', 'Actions')} data-view-actions>
								<Glyph name="zap" />
							</Button>
						{/snippet}
					</Popover.Trigger>
					<Popover.Content align="end" class="flex max-h-[min(70dvh,36rem)] w-[min(24rem,calc(100vw-1rem))] flex-col gap-0.5 overflow-y-auto p-1.5" data-view-menu>
						{#each groups as grp, gi (grp.g)}
							<p class={['text-muted-foreground px-2 pb-1 text-xs font-medium', gi === 0 ? 'pt-1' : 'mt-1 border-t pt-2']} data-menu-group={grp.g}>{grp.title}</p>
							{#each grp.of as e (e.key)}
								{@render menuRow(e)}
								{#if e.form !== undefined && form === e.form.callable}
									<div class="border-border mx-1 mb-1 rounded-md border p-2">
										<FormView of={{ action: e.form.callable } as never} {...e.form.target === 'record' ? { id: picked[0] as never } : {}}
											onOutcome={(o) => { say(o as Outcome); if (o.kind === 'committed') { form = null; menuOpen = false; } }} />
									</div>
								{/if}
							{/each}
						{/each}
					</Popover.Content>
				</Popover.Root>
			{/if}
			{#if canNew}
				<Button size="default" class="px-2.5 @xl:px-3" aria-label={msg(bolt, 'table.new', 'New')} data-view-new
					onclick={create}>
					<Glyph name="plus" /><span class="hidden @xl:inline">{onAdd ? msg(bolt, 'table.add', 'Add row') : msg(bolt, 'table.new', 'New')}</span>
				</Button>
			{/if}
		</div>
		{#if chips.length > 0 || (view?.order.length ?? 0) > 0}
			<div class="flex flex-wrap items-center gap-1 text-xs" data-view-chips>
				{#each chips as c (c.i)}
					<span class="bg-muted/60 inline-flex h-6 max-w-full items-center gap-1 rounded-full border pr-1 pl-2" data-filter-chip>
						<span class="truncate">{c.text}</span>
						<button type="button" class="hover:bg-accent grid size-4 place-items-center rounded-full" aria-label={msg(bolt, 'view.removeFilter', 'Remove filter')}
							onclick={() => view?.setRows(view.rows.filter((_, j) => j !== c.i))}><Glyph name="x" class="size-3" /></button>
					</span>
				{/each}
				{#each view?.order ?? [] as k, i (k.field)}
					<span class="bg-muted/60 inline-flex h-6 items-center gap-1 rounded-full border pr-1 pl-2" data-sort-chip>
						<span>{pathLabel(catalog, source, k.field, humanize)} {k.dir === 'asc' ? '↑' : '↓'}</span>
						<button type="button" class="hover:bg-accent grid size-4 place-items-center rounded-full" aria-label={msg(bolt, 'view.removeSort', 'Remove sort')}
							onclick={() => view?.setOrder(view.order.filter((_, j) => j !== i))}><Glyph name="x" class="size-3" /></button>
					</span>
				{/each}
			</div>
		{/if}
		{#if view?.notice}<p role="status" class="text-muted-foreground text-xs" data-view-notice>{view.notice}</p>{/if}
		{#if notice}<p role="status" class="text-muted-foreground text-xs">{notice}</p>{/if}
		{#each runs as r (r.id)}<RunStatus automation={r.automation} run={r.id} />{/each}
	</div>
{/if}
