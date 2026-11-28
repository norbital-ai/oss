<script lang="ts">
	import { virtual_grid } from '../../../ui/src/primitives/virtual/virtual.svelte.js';

	let {
		rowCount = 120,
		colCount = 31
	}: {
		rowCount?: number;
		colCount?: number;
	} = $props();

	const PERSON_PX = 160;
	const DAY_PX = 72;
	const ROW_PX = 61;

	const people = $derived(
		Array.from({ length: rowCount }, (_, i) => ({
			id: `p-${i}`,
			number: `EMP-${String(i + 1).padStart(4, '0')}`,
			name: `Employee ${i + 1}`
		}))
	);
	const dates = $derived(
		Array.from({ length: colCount }, (_, i) => `2026-03-${String(i + 1).padStart(2, '0')}`)
	);

	const grid = virtual_grid({
		rows: {
			count: () => people.length,
			key: (i) => people[i]?.id ?? String(i),
			size: ROW_PX,
			threshold: 15,
			overscan: 8
		},
		cols: {
			count: () => dates.length,
			key: (i) => dates[i] ?? String(i),
			size: DAY_PX,
			threshold: 14,
			overscan: 4,
			max_overscan: 8
		}
	});

	const visibleDates = $derived(grid.cols.slice(dates));
	const visibleColSpan = $derived(
		1 + (grid.cols.on ? 1 : 0) + visibleDates.length + (grid.cols.on && grid.cols.after > 0 ? 1 : 0)
	);
</script>

<div
	data-matrix-port
	style="width: 760px; height: 420px; overflow: auto; position: relative; border: 1px solid #d4d4d8;"
>
	<table
		class="table-fixed border-separate border-spacing-0 text-left text-xs"
		style:width={`${PERSON_PX + dates.length * DAY_PX}px`}
	>
		<colgroup>
			<col style:width={`${PERSON_PX}px`} />
			{#if grid.cols.on}<col style:width={`${grid.cols.before}px`} />{/if}
			{#each visibleDates as date (date)}<col style:width={`${DAY_PX}px`} />{/each}
			{#if grid.cols.on && grid.cols.after > 0}<col style:width={`${grid.cols.after}px`} />{/if}
		</colgroup>
		<thead>
			<tr>
				<th
					scope="col"
					data-matrix-corner
					class="sticky top-0 left-0 z-30 border-r border-b bg-card px-3 py-1.5 text-left"
					style="height: 40px;"
				>
					Person
				</th>
				{#if grid.cols.on}
					<th
						aria-hidden="true"
						data-col-spacer-before
						class="border-0! p-0!"
						style:width={`${grid.cols.before}px`}
						{@attach grid.cols.anchor}
					></th>
				{/if}
				{#each visibleDates as date (date)}
					<th
						scope="col"
						data-matrix-col={date}
						class="sticky top-0 z-20 h-10 border-b bg-card text-center font-medium"
					>
						{Number(date.slice(8, 10))}
					</th>
				{/each}
				{#if grid.cols.on && grid.cols.after > 0}
					<th
						aria-hidden="true"
						data-col-spacer-after
						class="border-0! p-0!"
						style:width={`${grid.cols.after}px`}
					></th>
				{/if}
			</tr>
		</thead>
		<tbody>
			{#if grid.rows.on}
				<tr aria-hidden="true" data-row-spacer-before {@attach grid.rows.anchor}>
					<td
						colspan={visibleColSpan}
						class="border-0! p-0! text-[0px] leading-none"
						style:height={`${grid.rows.before}px`}
					></td>
				</tr>
			{/if}
			{#each grid.rows.slice(people) as person (person.id)}
				<tr data-matrix-row={person.id}>
					<th
						scope="row"
						data-matrix-person={person.id}
						class="sticky left-0 z-10 border-r border-b bg-card px-3 py-1.5 text-left font-normal"
					>
						{person.number}
					</th>
					{#if grid.cols.on}
						<td aria-hidden="true" class="border-0! p-0!"></td>
					{/if}
					{#each visibleDates as date (date)}
						<td
							data-matrix-cell={`${person.id}:${date}`}
							data-cell-date={date}
							style="padding: 2px; border-bottom: 1px solid #e4e4e7;"
						>
							<button type="button" style="display: block; height: 56px; width: 100%; text-align: center;">
								{date.slice(8, 10)}
							</button>
						</td>
					{/each}
					{#if grid.cols.on && grid.cols.after > 0}
						<td aria-hidden="true" class="border-0! p-0!"></td>
					{/if}
				</tr>
			{/each}
			{#if grid.rows.on && grid.rows.after > 0}
				<tr aria-hidden="true" data-row-spacer-after>
					<td
						colspan={visibleColSpan}
						class="border-0! p-0! text-[0px] leading-none"
						style:height={`${grid.rows.after}px`}
					></td>
				</tr>
			{/if}
		</tbody>
	</table>
</div>
