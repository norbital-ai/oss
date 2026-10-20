<!--
@component
A grid of `rows` records by `cols` values (dates or a relation) whose cells hold the matching items of `of`, with optional background marks, create on an empty cell and drag to move.
-->
<script lang="ts" module>
	import type { Snippet } from 'svelte';
	import type { Json } from '../client/contract.js';
	import type { Row } from '../collection/types.js';
	import type { Toolbar } from '../collection/ViewToolbar.svelte';

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
		/** Optional native view toolbar; omitted keeps the matrix without toolbar chrome. */
		toolbar?: Toolbar;
		marks?: MatrixMark;
		/** An optional control in each column heading (for example an editable repayment date). */
		columnHeader?: Snippet<[{ col: Json; label: string }]>;
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
	import { formatValue as show } from '../kinds/kind.js';
	import { Effect } from 'effect';
	import { fork } from '../effect/index.js';
	import { SvelteMap } from 'svelte/reactivity';
	import { Button } from '../primitives/button/index.js';
	import { virtualList } from '../primitives/virtual/virtual.svelte.js';
	import { openRecord } from '../record/navigation.js';
	import { useBolt } from '../client/context.js';
	import { watch } from '../read/live.svelte.js';
	import { actOutcome, outcomeText } from '../actions/outcome.js';
	import { and, compact } from '../filter/scope.js';
	import { cellKey, MATRIX_PAGE, matrixCells } from './cells.js';
	import { isRow, nextOf, rowsOf } from '../read/results.js';
	import { label, msg } from '../text/messages.js';
	import { selectOf } from '../relations/select.js';
	import { valueAt } from '../cell/value.js';
	import ReadGate from '../read/ReadGate.svelte';
	import RecordShell from '../record/RecordShell.svelte';
	import Value from '../cell/Value.svelte';
	import ViewToolbar from '../collection/ViewToolbar.svelte';
	import { useKinds } from '../kinds/context.js';

	let {
		rows,
		rowLabel,
		rowWhere,
		of,
		row,
		col,
		cols,
		select,
		colWidth,
		where,
		toolbar,
		marks,
		columnHeader,
		cell,
		edit,
		move,
		selection = []
	}: MatrixProps = $props();
	const bolt = useBolt();
	const kinds = useKinds();
	const columnConfig = (
		value: MatrixProps['cols'][number]
	): value is { value: Json; label: string } =>
		isRow(value) && 'value' in value && typeof value['label'] === 'string';
	const columns = $derived(
		cols.map((c) =>
			columnConfig(c)
				? { value: c.value, label: c.label }
				: { value: c, label: show(c, bolt.locale) }
		)
	);
	const colValues = $derived(columns.map((c) => c.value));

	let after = $state<string | null>(null);
	let back = $state<(string | null)[]>([]);
	const rowPage = watch(() =>
		bolt.live(
			bolt.read(
				rows,
				compact({
					where: rowWhere,
					orderBy: { [rowLabel]: 'asc' },
					select: selectOf([rowLabel]),
					limit: MATRIX_PAGE,
					after: after ?? undefined
				})
			)
		)
	);
	const pageRows = $derived(rowPage.state.kind === 'ready' ? rowsOf(rowPage.state.value) : []);
	const ids = $derived(pageRows.map((r) => r.id));
	// the page's rows window inside the grid's scroll port; the sticky header row and first column stay put
	const grid = virtualList({
		count: () => pageRows.length,
		key: (i) => ids[i] ?? String(i),
		estimate: 41,
		threshold: 20
	});
	// one live read per page over `of` (final-ui 29b); a TooLarge refusal is an error band, never an empty grid
	const items = watch(() =>
		ids.length === 0
			? null
			: bolt.live(
					bolt.read(of, {
						where: and(where, { [row]: { in: ids } }, { [col]: { in: colValues } }) ?? null,
						select: selectOf([...select, row, col]),
						all: true
					})
				)
	);
	const markRead = watch(() =>
		marks === undefined
			? null
			: bolt.live(
					bolt.read(marks.of, {
						where: { [marks.at]: { in: colValues } },
						select: selectOf([marks.at, marks.label, ...(marks.row ? [marks.row] : [])]),
						all: true
					})
				)
	);
	const cells = $derived(
		items.state.kind === 'ready'
			? matrixCells(rowsOf(items.state.value), row, col)
			: new Map<string, Row[]>()
	);
	const markCells = $derived.by(() => {
		if (marks === undefined || markRead.state.kind !== 'ready') return new Map<string, Row[]>();
		return matrixCells(
			rowsOf(markRead.state.value).map((m) => (marks.row ? m : { ...m, $row: '*' })),
			marks.row ?? '$row',
			marks.at
		);
	});
	const marksAt = (rid: string, c: Json) => [
		...(markCells.get(cellKey(rid, c)) ?? []),
		...(markCells.get(cellKey('*', c)) ?? [])
	];

	const picked = new SvelteMap<string, MatrixCell>();
	let creating = $state<{ readonly [field: string]: Json } | null>(null);
	let notice = $state<string | null>(null);
	function click(e: MouseEvent, rid: string, c: Json, filled: boolean) {
		if (selection.length > 0 && (e.shiftKey || e.metaKey || e.ctrlKey)) {
			const k = cellKey(rid, c);
			if (picked.has(k)) picked.delete(k);
			else picked.set(k, { row: rid, col: c });
			return;
		}
		if (!filled && edit) creating = { [row]: rid, [col]: c };
	}
	function drop(e: DragEvent, rid: string, c: Json) {
		e.preventDefault();
		const id = e.dataTransfer?.getData('text/x-bolt-id');
		if (!move || !id) return;
		fork(
			actOutcome(bolt.act(`${of}.update`, { target: id, set: { [row]: rid, [col]: c } })).pipe(
				Effect.tap((outcome) =>
					Effect.sync(() => {
						notice = outcome.kind === 'committed' ? null : outcomeText(bolt, outcome);
					})
				)
			)
		);
	}
</script>

<section
	class="flex h-full min-h-[min(18rem,100%)] min-w-0 flex-1 flex-col gap-2"
	data-view="matrix"
>
	{#if toolbar !== undefined && toolbar !== false}
		<ViewToolbar config={toolbar} collection={of} catalog={kinds.catalog ?? {}} />
	{/if}
	{#if notice}<p role="alert" class="text-destructive text-sm">{notice}</p>{/if}
	{#if selection.length > 0}
		<div class="flex items-center gap-2">
			{#each selection as s (s.label)}<Button
					size="sm"
					variant="outline"
					disabled={picked.size === 0}
					onclick={() => {
						s.run([...picked.values()]);
						picked.clear();
					}}>{s.label}</Button
				>{/each}
		</div>
	{/if}
	<ReadGate state={rowPage.state} what={label(bolt, rows)}>
		{#snippet children()}
			{#if items.state.kind === 'error' || items.state.kind === 'noAccess'}
				<div
					role="alert"
					class="border-destructive text-destructive rounded-md border p-3 text-sm"
					data-read={items.state.kind}
				>
					{items.state.kind === 'noAccess'
						? msg(bolt, 'view.noAccess', 'No access to {what}', { what: label(bolt, of) })
						: msg(
								bolt,
								'matrix.pageError',
								'Rows {from}–{to} could not be read ({code}): {message}',
								{
									from: back.length * MATRIX_PAGE + 1,
									to: back.length * MATRIX_PAGE + pageRows.length,
									code: items.state.code,
									message: items.state.message
								}
							)}
				</div>
			{/if}
			<div class="min-h-0 flex-1 overflow-auto rounded-md border">
				<table class="border-separate border-spacing-0 text-sm" style="table-layout:fixed">
					<thead>
						<tr>
							<th class="bg-background sticky top-0 left-0 z-20 w-48 border-b p-1 text-left"
								>{label(bolt, rows)}</th
							>
							{#each columns as c (JSON.stringify(c.value))}
								<th
									class="bg-background sticky top-0 z-10 border-b p-1 text-left text-xs font-medium"
									style={`width:${colWidth}px;min-width:${colWidth}px`}
									>{#if columnHeader}{@render columnHeader({
											col: c.value,
											label: c.label
										})}{:else}{c.label}{/if}</th
								>
							{/each}
						</tr>
					</thead>
					<tbody>
						{#if grid.on}<tr aria-hidden="true" {@attach grid.anchor}
								><td colspan={columns.length + 1} style="height:{grid.before}px;padding:0;border:0"
								></td></tr
							>{/if}
						{#each grid.slice(pageRows) as r (r['id'])}
							{@const rid = r.id}
							<tr {@attach grid.measure(rid)}>
								<th class="bg-background sticky left-0 z-10 border-b p-1 text-left font-normal"
									><Value value={valueAt(r, rowLabel)} /></th
								>
								{#each columns as c (JSON.stringify(c.value))}
									{@const here = cells.get(cellKey(rid, c.value)) ?? []}
									{@const m = marksAt(rid, c.value)}
									<td
										class={[
											'h-10 border-b border-l p-0.5 align-top',
											m.length > 0 && 'bg-muted',
											picked.has(cellKey(rid, c.value)) && 'ring-primary ring-2 ring-inset',
											here.length === 0 && edit && 'cursor-pointer'
										]}
										title={m.map((x) => show(x[marks?.label ?? ''] ?? null)).join(', ') ||
											undefined}
										onclick={(e) => click(e, rid, c.value, here.length > 0)}
										ondragover={(e) => move && e.preventDefault()}
										ondrop={(e) => drop(e, rid, c.value)}
									>
										{#if cell}{@render cell({ row: r, col: c.value, items: here, marks: m })}
										{:else}
											{#each here as it (it['id'])}
												<button
													type="button"
													draggable={move === true}
													class="bg-card block w-full truncate rounded-sm border px-1 text-left text-xs"
													ondragstart={(e) => e.dataTransfer?.setData('text/x-bolt-id', it.id)}
													onclick={(e) => {
														e.stopPropagation();
														if (typeof it['id'] === 'string') openRecord(of, it['id']);
													}}
												>
													{select
														.map((f) => show(valueAt(it, f) ?? null, bolt.locale))
														.filter(Boolean)
														.join(' · ')}
												</button>
											{/each}
										{/if}
									</td>
								{/each}
							</tr>
						{/each}
						{#if grid.after > 0}<tr aria-hidden="true"
								><td colspan={columns.length + 1} style="height:{grid.after}px;padding:0;border:0"
								></td></tr
							>{/if}
					</tbody>
				</table>
			</div>
			<footer
				class="text-muted-foreground flex shrink-0 items-center justify-end gap-2 border-t py-2 text-xs"
				data-matrix-footer
			>
				<Button
					size="sm"
					variant="outline"
					disabled={back.length === 0}
					onclick={() => {
						after = back.at(-1) ?? null;
						back = back.slice(0, -1);
					}}>{msg(bolt, 'table.prev', 'Previous')}</Button
				>
				<Button
					size="sm"
					variant="outline"
					disabled={rowPage.state.kind !== 'ready' || nextOf(rowPage.state.value) === null}
					onclick={() => {
						if (rowPage.state.kind === 'ready') {
							back = [...back, after];
							after = nextOf(rowPage.state.value);
						}
					}}>{msg(bolt, 'table.next', 'Next')}</Button
				>
			</footer>
		{/snippet}
	</ReadGate>
	{#if creating !== null}
		<dialog
			open
			class="bg-background fixed inset-0 z-50 m-auto w-[min(40rem,95vw)] rounded-md border p-4 shadow-lg"
		>
			<RecordShell {of} mode="create" values={creating} onDone={() => (creating = null)} />
			<Button size="sm" variant="ghost" onclick={() => (creating = null)}
				>{msg(bolt, 'record.close', 'Close')}</Button
			>
		</dialog>
	{/if}
</section>
