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
	import { Inline, Stack } from '@norbital-ai/ui/layout';
	import { cn } from '@norbital-ai/ui/utils';
	import { STATUS_PRESENTATION, monthDays, type DayFacts, type DayStatus } from './roster-month.js';

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

	/** The glyph a cell carries: the shift code when there is one, else what kind of day it is. */
	function glyphOf(day: DayFacts | undefined): string {
		if (day == null) return '';
		switch (day.status) {
			case 'HOLIDAY':
				return 'PH';
			case 'ON_LEAVE':
				return day.halfDayLeave ? '½' : 'L';
			case 'REST':
				return 'R';
			case 'OFF':
				return 'O';
			case 'UNROSTERED':
				return '·';
			case 'ABSENT':
				return '!';
			case 'OPEN':
				return '⧗';
			case 'ATTENDED':
			case 'PLANNED':
				return day.shiftCode ?? 'W';
			default: {
				const unhandled: never = day.status;
				throw new Error(`Unhandled day status: ${String(unhandled)}`);
			}
		}
	}

	// Literal variants rather than assembled class strings, so Tailwind can see every one of them.
	const TONE_CLASS: Record<DayStatus, string> = {
		UNROSTERED: 'bg-muted/30 text-muted-foreground',
		PLANNED: 'bg-brand-50 text-brand-700 dark:bg-brand-950 dark:text-brand-200',
		ATTENDED: 'bg-success/15 text-success-foreground',
		OPEN: 'bg-warning/25 text-warning-foreground',
		ABSENT: 'bg-destructive/20 text-destructive font-semibold',
		ON_LEAVE: 'bg-accent text-accent-foreground',
		HOLIDAY: 'bg-brand/20 text-brand-foreground',
		REST: 'bg-muted text-muted-foreground',
		OFF: 'bg-muted/60 text-muted-foreground'
	};

	function describe(day: DayFacts | undefined, person: Person, date: string): string {
		if (day == null) return `${person.number} · ${date}`;
		const parts = [
			`${person.number} · ${date}`,
			STATUS_PRESENTATION[day.status].label,
			day.shiftCode == null ? null : `Shift ${day.shiftCode}`,
			day.assignmentCode == null ? null : `Roster code ${day.assignmentCode}`,
			day.holidayName,
			day.leaveCode == null ? null : `${day.leaveCode}${day.halfDayLeave ? ' (half day)' : ''}`,
			day.withinCutoff ? 'Inside the current cut-off' : null
		];
		return parts.filter((part) => part != null && part !== '').join(' — ');
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
		<!--
			stupidity:allow UI3 -- a person-by-day board is a derived cross-tab of four collections, not
			one collection's rows, so CollectionTable cannot express it.
			stupidity:allow UI16 -- the horizontal scrollport is the table's own; a Scroll wrapper here
			would nest inside the tab panel's scrollport.
		-->
		<div class="overflow-x-auto rounded-lg border">
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
										title={describe(day, person, date)}
										class={cn(
											'flex h-7 w-full items-center justify-center rounded-sm text-micro tabular-nums focus-visible:ring-2 focus-visible:ring-ring',
											day == null ? 'bg-muted/20' : TONE_CLASS[day.status],
											onSelectDay != null && 'hover:ring-1 hover:ring-ring'
										)}
										disabled={onSelectDay == null}
										onclick={() => onSelectDay?.(person.id, date)}
									>
										<span class="truncate px-0.5">{glyphOf(day)}</span>
									</button>
								</td>
							{/each}
						</tr>
					{/each}
				</tbody>
			</table>
		</div>

		<Inline gap="md" class="flex-wrap text-micro text-muted-foreground">
			{#each Object.entries(STATUS_PRESENTATION) as [status, presentation] (status)}
				<Inline gap="xs">
					<span class={cn('inline-block size-3 rounded-sm', TONE_CLASS[status as DayStatus])}
					></span>
					<span>{presentation.label}</span>
				</Inline>
			{/each}
			{#if cutoff != null}
				<Inline gap="xs">
					<IconWrapper name="lucide:scissors" class="size-3" />
					<span>Cut-off {cutoff.start} to {cutoff.end}</span>
				</Inline>
			{/if}
		</Inline>
	</Stack>
{/if}
