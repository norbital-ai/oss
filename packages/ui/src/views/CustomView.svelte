<!--
@component
The standard toolbar over a custom view (a roster grid, a calendar, cards): title and description, search, the filter and
sort popover over the page's own rows, the actions menu and the page's scope controls. The body gets the rows they leave.
-->
<script lang="ts" module>
	import type { Snippet } from 'svelte';
	import type { Row } from './bolt.js';
	import type { Toolbar } from './ViewToolbar.svelte';

	/** A field the toolbar searches, filters and sorts on: its name, or `{ field, label }`. */
	export type CustomField<R> = (keyof R & string) | { field: keyof R & string; label: string };
	/** The props of `CustomView`. */
	export type CustomViewProps<R extends object = Row> = {
		/** The rows the custom view draws; the toolbar narrows and orders them. */
		of: readonly R[];
		fields: readonly CustomField<R>[];
		/** The URL prefix of the viewer's filter and sort. */
		key: string;
		/** Title, description, `actions`, `controls`, `new`; `export: true` adds "Export CSV" of the rows shown. */
		toolbar?: Exclude<Toolbar<R>, false>;
		/** The custom view, over the rows the search, filter and sort leave. */
		children: Snippet<[readonly R[]]>;
		/** No rows: the kit's `EmptyState` by default, this snippet instead, or `false` to draw the view empty (a calendar). */
		empty?: Snippet | false;
	};
</script>

<script lang="ts" generics="R extends object = Row">
	import Cover from '../layout/cover.svelte';
	import { Button } from '../primitives/button/index.js';
	import { useBolt } from './bolt.js';
	import EmptyState from './EmptyState.svelte';
	import { localExposure, matches, sortable, sortRows } from './filter.js';
	import { humanize, msg, searchRows } from './model.js';
	import { viewState } from './view-state.svelte.js';
	import ViewToolbar from './ViewToolbar.svelte';

	let { of, fields, key, toolbar = {}, children, empty }: CustomViewProps<R> = $props();
	const bolt = useBolt();
	const LOCAL = '$local';
	const names = $derived(fields.map((f) => typeof f === 'string' ? f : f.field));
	const labelOf = (f: string) => fields.flatMap((c) => typeof c !== 'string' && c.field === f ? [c.label] : [])[0] ?? humanize(f);
	const rows = $derived(of as readonly Row[]);
	const catalog = $derived({ [LOCAL]: localExposure(rows, names, labelOf) });
	const view = viewState(bolt, { key: () => key, collection: () => LOCAL, catalog: () => catalog, initialFilter: () => undefined });
	let q = $state('');
	const shown = $derived(sortRows(searchRows(rows, q, names).filter((r) => matches(r, { t: 'group', join: 'and', of: view.rows })), view.order));
	const exporter = $derived(toolbar.export === true ? { fields: names, labels: names.map(labelOf), read: () => Promise.resolve(shown) } : undefined);
</script>

{#snippet bar()}
	<ViewToolbar config={toolbar as Toolbar} collection="" {view} {catalog} source={LOCAL} sortable={sortable(catalog[LOCAL], false, catalog)} bind:q searchable {exporter} />
{/snippet}

<Cover gap="sm" top={bar}>
	{#if shown.length > 0 || empty === false}{@render children(shown as readonly Row[] as readonly R[])}
	{:else if empty}{@render empty()}
	{:else if rows.length > 0}
		<EmptyState variant="card" icon="search" title={msg(bolt, 'view.noMatch', 'Nothing matches this search or filter')} hint={msg(bolt, 'table.noMatchHint', 'Try a different search, or clear the filters.')}>
			<Button size="sm" variant="outline" onclick={() => { view.clear(); q = ''; }}>{msg(bolt, 'view.clearAll', 'Clear all')}</Button>
		</EmptyState>
	{:else}<EmptyState variant="card" title={msg(bolt, 'view.empty', 'Nothing here yet')} />{/if}
</Cover>
