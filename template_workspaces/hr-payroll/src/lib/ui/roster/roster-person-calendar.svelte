<!--
	One person's month as an actual calendar — seven columns, weeks as rows.

	The board answers "who is short this month". This answers "what does my month look like", which
	is the question an employee and their manager ask, and a wide grid of thirty-one narrow columns
	answers it badly. Both views read the same merged facts and share one status vocabulary, so the
	same day cannot look like two different things depending on which tab you opened.

	Written as a table rather than composed from `Columns`, because a calendar week needs seven
	columns and `Columns` offers 2, 3, 4 and 6 — and because a month grid of dates under weekday
	headings is genuinely tabular, so the semantics are the honest ones.
-->
<script lang="ts">
	import { Cluster, Inline, Stack } from '@norbital-ai/ui/layout';
	import { cn } from '@norbital-ai/ui/utils';
	import {
		STATUS_PRESENTATION,
		describeDay,
		monthDays,
		statusGlyph,
		type DayFacts,
		type DayStatus
	} from './roster-month.js';

	let {
		month,
		employmentId,
		facts,
		today,
		cutoff = null,
		onSelectDay
	}: {
		month: string;
		employmentId: string;
		facts: ReadonlyMap<string, DayFacts>;
		today: string;
		cutoff?: { readonly start: string; readonly end: string } | null;
		onSelectDay?: (employmentId: string, date: string) => void;
	} = $props();

	const WEEKDAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

	/** Monday-based weekday index, so the grid reads Monday to Sunday. */
	function weekdayIndex(date: string): number {
		return (new Date(`${date}T00:00:00.000Z`).getUTCDay() + 6) % 7;
	}

	/**
	 * The month laid out in weeks, padded with `null` so the first and last rows keep their shape.
	 * A leading gap is not a day off — it belongs to the previous month and is deliberately blank.
	 */
	const weeks = $derived.by((): (string | null)[][] => {
		const days = monthDays(month);
		const cells: (string | null)[] = [
			...Array.from({ length: weekdayIndex(days[0]!) }, () => null),
			...days
		];
		while (cells.length % 7 !== 0) cells.push(null);
		return Array.from({ length: cells.length / 7 }, (_value, row) =>
			cells.slice(row * 7, row * 7 + 7)
		);
	});

	const shownStatuses = $derived.by((): DayStatus[] => {
		const seen = new Set<DayStatus>();
		for (const date of monthDays(month)) {
			const day = facts.get(`${employmentId}:${date}`);
			if (day != null) seen.add(day.status);
		}
		return [...seen];
	});
</script>

<Stack gap="sm">
	<!-- stupidity:allow UI3 -- a calendar month of merged roster, attendance, leave and holiday facts is a derived cross-tab, not one collection's rows. -->
	<table class="w-full border-separate border-spacing-0 text-left text-sm">
		<thead>
			<tr>
				{#each WEEKDAY_NAMES as name, index (name)}
					<th
						scope="col"
						class={cn(
							'border-b px-2 py-1.5 text-xs font-semibold text-muted-foreground',
							index >= 5 && 'bg-muted/40'
						)}
					>
						{name}
					</th>
				{/each}
			</tr>
		</thead>
		<tbody>
			{#each weeks as week, weekIndex (weekIndex)}
				<tr>
					{#each week as date, dayIndex (dayIndex)}
						{@const day = date == null ? undefined : facts.get(`${employmentId}:${date}`)}
						<td
							class={cn(
								'h-20 border-b border-r p-1 align-top first:border-l',
								dayIndex >= 5 && 'bg-muted/20',
								date != null && cutoff != null && date >= cutoff.start && date <= cutoff.end
									? 'bg-brand-50/40 dark:bg-brand-950/30'
									: null
							)}
						>
							{#if date != null}
								<Stack gap="xs">
									<span
										class={cn(
											'text-xs tabular-nums',
											date === today
												? 'inline-flex size-5 items-center justify-center rounded-full bg-brand text-brand-foreground'
												: 'text-muted-foreground'
										)}
									>
										{Number(date.slice(8, 10))}
									</span>
									{#if day != null}
										<button
											type="button"
											title={describeDay(day, date)}
											class={cn(
												'w-full truncate rounded-sm px-1.5 py-1 text-left text-xs focus-visible:ring-2 focus-visible:ring-ring',
												STATUS_PRESENTATION[day.status].className,
												onSelectDay != null && 'hover:ring-1 hover:ring-ring'
											)}
											disabled={onSelectDay == null}
											onclick={() => onSelectDay?.(employmentId, date)}
										>
											{statusGlyph(day)}
											<span class="text-micro opacity-80">
												{STATUS_PRESENTATION[day.status].label}
											</span>
										</button>
									{/if}
								</Stack>
							{/if}
						</td>
					{/each}
				</tr>
			{/each}
		</tbody>
	</table>

	<Cluster gap="md" class="text-micro text-muted-foreground">
		{#each shownStatuses as status (status)}
			<Inline gap="xs">
				<span class={cn('inline-block size-3 rounded-sm', STATUS_PRESENTATION[status].className)}
				></span>
				<span>{STATUS_PRESENTATION[status].label}</span>
			</Inline>
		{/each}
		{#if cutoff != null}
			<span>Tinted days fall inside the cut-off {cutoff.start} to {cutoff.end}</span>
		{/if}
	</Cluster>
</Stack>
