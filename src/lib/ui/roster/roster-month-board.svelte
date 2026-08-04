<!--
	The month at a glance: one row per person, one narrow column per day.

	This mirrors the shape operators already keep their rosters in — a wide grid of people against
	dates — so the board reads like the spreadsheet it replaces rather than like a database table. It
	is deliberately not a `ResourceScheduler`: that component's month view is the right axis, but its
	day cells carry a button, a chip row and a 156px minimum width each, which at roster density
	turns thirty-one days into several screens of chrome. Here a day is a glyph.

	Planned and actual are shown in the same cell on purpose. Kept apart they are two screens nobody
	cross-references, which is how a rostered shift with nobody clocked onto it survives until payroll.
-->
<script lang="ts">
	import { IconWrapper } from '@norbital-ai/ui/icon-wrapper';
	import { Cluster, Inline, Scroll, Stack } from '@norbital-ai/ui/layout';
	import { cn } from '@norbital-ai/ui/utils';
	import {
		STATUS_PRESENTATION,
		describeDay,
		monthDays,
		statusGlyph,
		type DayFacts,
		type DayStatus
	} from './roster-month.js';

	type Person = { readonly id: string; readonly number: string; readonly name: string };

	let {
		month,
		people,
		facts,
		today,
		cutoff = null,
		onSelectDay
	}: {
		month: string;
		people: readonly Person[];
		facts: ReadonlyMap<string, DayFacts>;
		today: string;
		cutoff?: { readonly start: string; readonly end: string } | null;
		onSelectDay?: (employmentId: string, date: string) => void;
	} = $props();

	const days = $derived(monthDays(month));

	const WEEKDAY_LETTERS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'] as const;

	function weekdayLetter(date: string): string {
		return WEEKDAY_LETTERS[new Date(`${date}T00:00:00.000Z`).getUTCDay()]!;
	}

	function isWeekend(date: string): boolean {
		const day = new Date(`${date}T00:00:00.000Z`).getUTCDay();
		return day === 0 || day === 6;
	}

	/** The first day inside the cut-off, so the boundary can be drawn as an edge rather than a fill. */
	const cutoffStartsAt = $derived(
		cutoff == null ? null : days.find((date) => date >= cutoff.start && date <= cutoff.end)
	);
</script>

{#if people.length === 0}
	<p class="text-sm text-muted-foreground">
		No active employments for this legal entity, so there is nobody to roster.
	</p>
{:else}
	<Stack gap="sm">
		<!-- An x-only reel: thirty-one days do not fit, and Scroll's per-axis containment keeps the
		     tab panel's vertical scroll from being trapped here. -->
		<Scroll axis="x" name="Month roster board" class="rounded-lg border">
			<!-- stupidity:allow UI3 -- a person-by-day board is a derived cross-tab of four collections, not one collection's rows. -->
			<table class="border-separate border-spacing-0 text-left text-xs">
				<thead>
					<tr>
						<th
							scope="col"
							class="sticky left-0 z-20 min-w-[10rem] border-b border-r bg-card px-3 py-2 text-xs font-semibold"
						>
							Person
						</th>
						{#each days as date (date)}
							<th
								scope="col"
								class={cn(
									'w-9 min-w-9 border-b px-0 py-1 text-center font-medium',
									isWeekend(date) && 'bg-muted/40',
									date === today && 'bg-brand-100 text-brand-700 dark:bg-brand-900',
									date === cutoffStartsAt && 'border-l-2 border-l-brand'
								)}
							>
								<span class="block text-micro text-muted-foreground">{weekdayLetter(date)}</span>
								<span class="block tabular-nums">{Number(date.slice(8, 10))}</span>
							</th>
						{/each}
					</tr>
				</thead>
				<tbody>
					{#each people as person (person.id)}
						<tr>
							<th
								scope="row"
								class="sticky left-0 z-10 border-b border-r bg-card px-3 py-1.5 text-left font-normal"
							>
								<span class="block truncate font-mono tabular-nums">{person.number}</span>
								<span class="block truncate text-micro text-muted-foreground">{person.name}</span>
							</th>
							{#each days as date (date)}
								{@const day = facts.get(`${person.id}:${date}`)}
								<td
									class={cn(
										'border-b p-0.5 text-center',
										date === cutoffStartsAt && 'border-l-2 border-l-brand'
									)}
								>
									<!--
										A native title rather than a Tooltip component: at a month of days times a
										payroll's worth of people this is well over a thousand cells, and mounting a
										tooltip provider on each one costs more than the hover text is worth.
									-->
									<button
										type="button"
										title={describeDay(day, `${person.number} · ${date}`)}
										class={cn(
											'flex h-7 w-full items-center justify-center rounded-sm text-micro tabular-nums focus-visible:ring-2 focus-visible:ring-ring',
											day == null ? 'bg-muted/20' : STATUS_PRESENTATION[day.status].className,
											onSelectDay != null && 'hover:ring-1 hover:ring-ring'
										)}
										disabled={onSelectDay == null}
										onclick={() => onSelectDay?.(person.id, date)}
									>
										<span class="truncate px-0.5">{day == null ? '' : statusGlyph(day)}</span>
									</button>
								</td>
							{/each}
						</tr>
					{/each}
				</tbody>
			</table>
		</Scroll>

		<Cluster gap="md" class="text-micro text-muted-foreground">
			{#each Object.entries(STATUS_PRESENTATION) as [status, presentation] (status)}
				<Inline gap="xs">
					<span class={cn('inline-block size-3 rounded-sm', presentation.className)}></span>
					<span>{presentation.label}</span>
				</Inline>
			{/each}
			{#if cutoff != null}
				<Inline gap="xs">
					<IconWrapper name="lucide:scissors" class="size-3" />
					<span>Cut-off {cutoff.start} to {cutoff.end}</span>
				</Inline>
			{/if}
		</Cluster>
	</Stack>
{/if}
