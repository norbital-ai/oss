<!--
@component
A grid of `rows` records by `cols` values (dates or a relation) whose cells hold the matching items of `of`, with optional background marks, create on an empty cell and drag to move.
-->
<script lang="ts" module>
	import type { Snippet } from 'svelte';
	import type { Json, Row } from './bolt.js';

	/** A background overlay per column (holidays, closures), optionally per row (M3). */
	export type MatrixMark = { of: string; at: string; row?: string; label: string };
	/** A matrix cell: its row id and column value. */
	export type MatrixCell = { row: string; col: Json };
	/** The props of `Matrix`. */
	export type MatrixProps = {
		/** The row collection, paged 50 at a time by its `rowLabel` (final-ui 29b). */
		rows: string;
		rowLabel: string;
		rowWhere?: Json;
		/** The item collection; `row` is its relation to `rows`, `col` its date or relation field. */
		of: string;
		row: string;
		col: string;
		cols: readonly (Json | { value: Json; label: string })[];
		/** The cell fields (required: never the whole row). */
		select: readonly string[];
		/** Column width in px (required: memory matrix-columns-default-150px). */
		colWidth: number;
		where?: Json;
		marks?: MatrixMark;
		cell?: Snippet<[{ row: Row; col: Json; items: readonly Row[]; marks: readonly Row[] }]>;
		/** A click on an empty cell opens the create view with `{ [row], [col] }`. */
		edit?: true;
		/** Dragging an item to another cell updates its `row` and `col`. */
		move?: true;
		/** Multi-cell selection actions. */
		selection?: readonly { label: string; run: (cells: readonly MatrixCell[]) => void }[];
	};
</script>

<script lang="ts">
	import { SvelteMap } from 'svelte/reactivity';
	import { Button } from '../primitives/button/index.js';
	import { virtualList } from '../primitives/virtual/virtual.svelte.js';
	import { openRecord, useBolt } from './bolt.js';
	import { watch } from './live.svelte.js';
	import { and, cellKey, compact, isRow, label, MATRIX_PAGE, matrixCells, msg, nextOf, outcomeText, rowsOf, selectOf, show, valueAt } from './model.js';
	import ReadGate from './ReadGate.svelte';
	import RecordShell from './RecordShell.svelte';
	import Value from './Value.svelte';

	let { rows, rowLabel, rowWhere, of, row, col, cols, select, colWidth, where, marks, cell, edit, move, selection = [] }: MatrixProps = $props();
	const bolt = useBolt();
	const columns = $derived(cols.map((c) => isRow(c) && 'value' in c && typeof c['label'] === 'string' ? { value: c['value'] as Json, label: c['label'] } : { value: c as Json, label: show(c as Json, bolt.locale) }));
	const colValues = $derived(columns.map((c) => c.value));

	let after = $state<string | null>(null);
	let back = $state<(string | null)[]>([]);
	const rowPage = watch(() => bolt.live(bolt.read(rows, compact({ where: rowWhere, orderBy: { [rowLabel]: 'asc' }, select: selectOf([rowLabel]), limit: MATRIX_PAGE, after: after ?? undefined }))));
	const pageRows = $derived(rowPage.state.kind === 'ready' ? rowsOf(rowPage.state.value) : []);
	const ids = $derived(pageRows.map((r) => String(r['id'])));
	// the page's rows window inside the grid's scroll port; the sticky header row and first column stay put
	const grid = virtualList({ count: () => pageRows.length, key: (i) => ids[i] ?? String(i), estimate: 41, threshold: 20 });
	// one live read per page over `of` (final-ui 29b); a TooLarge refusal is an error band, never an empty grid
	const items = watch(() => ids.length === 0 ? null : bolt.live(bolt.read(of, {
		where: and(where, { [row]: { in: ids } }, { [col]: { in: colValues } }) ?? null, select: selectOf([...select, row, col]), all: true })));
	const markRead = watch(() => marks === undefined ? null : bolt.live(bolt.read(marks.of, {
		where: { [marks.at]: { in: colValues } }, select: selectOf([marks.at, marks.label, ...(marks.row ? [marks.row] : [])]), all: true })));
	const cells = $derived(items.state.kind === 'ready' ? matrixCells(rowsOf(items.state.value), row, col) : new Map<string, Row[]>());
	const markCells = $derived.by(() => {
		if (marks === undefined || markRead.state.kind !== 'ready') return new Map<string, Row[]>();
		return matrixCells(rowsOf(markRead.state.value).map((m) => marks.row ? m : { ...m, $row: '*' }), marks.row ?? '$row', marks.at);
	});
	const marksAt = (rid: string, c: Json) => [...(markCells.get(cellKey(rid, c)) ?? []), ...(markCells.get(cellKey('*', c)) ?? [])];

	const picked = new SvelteMap<string, MatrixCell>();
	let creating = $state<Row | null>(null);
	let notice = $state<string | null>(null);
	function click(e: MouseEvent, rid: string, c: Json, filled: boolean) {
		if (selection.length > 0 && (e.shiftKey || e.metaKey || e.ctrlKey)) {
			const k = cellKey(rid, c);
			if (picked.has(k)) picked.delete(k); else picked.set(k, { row: rid, col: c });
			return;
		}
		if (!filled && edit) creating = { [row]: rid, [col]: c };
	}
	async function drop(e: DragEvent, rid: string, c: Json) {
		e.preventDefault();
		const id = e.dataTransfer?.getData('text/x-bolt-id');
		if (!move || !id) return;
		const o = await bolt.act(`${of}.update`, { target: id, set: { [row]: rid, [col]: c } });
		notice = o.kind === 'committed' ? null : outcomeText(bolt, o);
	}
</script>

<section class="flex min-w-0 flex-col gap-2" data-view="matrix">
	{#if notice}<p role="alert" class="text-destructive text-sm">{notice}</p>{/if}
	{#if selection.length > 0}
		<div class="flex items-center gap-2">
			{#each selection as s (s.label)}<Button size="sm" variant="outline" disabled={picked.size === 0} onclick={() => { s.run([...picked.values()]); picked.clear(); }}>{s.label}</Button>{/each}
		</div>
	{/if}
	<ReadGate state={rowPage.state} what={label(bolt, rows)}>
		{#snippet children()}
			{#if items.state.kind === 'error' || items.state.kind === 'noAccess'}
				<div role="alert" class="border-destructive text-destructive rounded-md border p-3 text-sm" data-read={items.state.kind}>
					{items.state.kind === 'noAccess' ? msg(bolt, 'view.noAccess', 'No access to {what}', { what: label(bolt, of) })
						: msg(bolt, 'matrix.pageError', 'Rows {from}–{to} could not be read ({code}): {message}', { from: back.length * MATRIX_PAGE + 1, to: back.length * MATRIX_PAGE + pageRows.length, code: items.state.code, message: items.state.message })}
				</div>
			{/if}
			<div class="max-h-[70dvh] overflow-x-scroll overflow-y-auto rounded-md border">
				<table class="border-separate border-spacing-0 text-sm" style="table-layout:fixed">
					<thead>
						<tr>
							<th class="bg-background sticky top-0 left-0 z-20 w-48 border-b p-1 text-left">{label(bolt, rows)}</th>
							{#each columns as c (JSON.stringify(c.value))}
								<th class="bg-background sticky top-0 z-10 border-b p-1 text-left text-xs font-medium" style={`width:${colWidth}px;min-width:${colWidth}px`}>{c.label}</th>
							{/each}
						</tr>
					</thead>
					<tbody>
						{#if grid.on}<tr aria-hidden="true" {@attach grid.anchor}><td colspan={columns.length + 1} style="height:{grid.before}px;padding:0;border:0"></td></tr>{/if}
						{#each grid.slice(pageRows) as r (r['id'])}
							{@const rid = String(r['id'])}
							<tr {@attach grid.measure(rid)}>
								<th class="bg-background sticky left-0 z-10 border-b p-1 text-left font-normal"><Value value={valueAt(r, rowLabel)} /></th>
								{#each columns as c (JSON.stringify(c.value))}
									{@const here = cells.get(cellKey(rid, c.value)) ?? []}
									{@const m = marksAt(rid, c.value)}
									<td class={['h-10 border-b border-l p-0.5 align-top', m.length > 0 && 'bg-muted', picked.has(cellKey(rid, c.value)) && 'ring-primary ring-2 ring-inset', here.length === 0 && edit && 'cursor-pointer']}
										title={m.map((x) => show(x[marks?.label ?? ''] ?? null)).join(', ') || undefined}
										onclick={(e) => click(e, rid, c.value, here.length > 0)} ondragover={(e) => move && e.preventDefault()} ondrop={(e) => drop(e, rid, c.value)}>
										{#if cell}{@render cell({ row: r, col: c.value, items: here, marks: m })}
										{:else}
											{#each here as it (it['id'])}
												<button type="button" draggable={move === true} class="bg-card block w-full truncate rounded-sm border px-1 text-left text-xs"
													ondragstart={(e) => e.dataTransfer?.setData('text/x-bolt-id', String(it['id']))}
													onclick={(e) => { e.stopPropagation(); if (typeof it['id'] === 'string') openRecord(of, it['id']); }}>
													{select.map((f) => show(valueAt(it, f) ?? null, bolt.locale)).filter(Boolean).join(' · ')}
												</button>
											{/each}
										{/if}
									</td>
								{/each}
							</tr>
						{/each}
						{#if grid.after > 0}<tr aria-hidden="true"><td colspan={columns.length + 1} style="height:{grid.after}px;padding:0;border:0"></td></tr>{/if}
					</tbody>
				</table>
			</div>
			<div class="text-muted-foreground flex items-center justify-end gap-2 text-xs">
				<Button size="sm" variant="outline" disabled={back.length === 0} onclick={() => { after = back.at(-1) ?? null; back = back.slice(0, -1); }}>{msg(bolt, 'table.prev', 'Previous')}</Button>
				<Button size="sm" variant="outline" disabled={rowPage.state.kind !== 'ready' || nextOf(rowPage.state.value) === null}
					onclick={() => { if (rowPage.state.kind === 'ready') { back = [...back, after]; after = nextOf(rowPage.state.value); } }}>{msg(bolt, 'table.next', 'Next')}</Button>
			</div>
		{/snippet}
	</ReadGate>
	{#if creating !== null}
		<dialog open class="bg-background fixed inset-0 z-50 m-auto w-[min(40rem,95vw)] rounded-md border p-4 shadow-lg">
			<RecordShell {of} mode="create" values={creating} onDone={() => (creating = null)} />
			<Button size="sm" variant="ghost" onclick={() => (creating = null)}>{msg(bolt, 'record.close', 'Close')}</Button>
		</dialog>
	{/if}
</section>
