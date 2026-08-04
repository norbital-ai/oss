<script lang="ts">
	import { Combobox } from '@norbital-ai/ui/combobox';
	import { Grid, Inline, Stack } from '@norbital-ai/ui/layout';
	import { ToggleGroup, ToggleGroupItem } from '@norbital-ai/ui/toggle-group';
	import { WEEKDAYS, workPatternVariantSchema, type Weekday } from './+definition.js';
	import type { RendererProps, Value } from './$types.js';

	type VariantType = Value['type'];
	/** What a single weekday is on a STANDARD week. Working days are the ones named as neither. */
	type DayRole = 'WORK' | 'REST' | 'OFF';

	const TYPE_OPTIONS: { value: VariantType; label: string; description: string }[] = [
		{
			value: 'STANDARD',
			label: 'Standard week',
			description: 'The same week repeats; days are derived'
		},
		{
			value: 'ROSTERED',
			label: 'Rostered',
			description: 'Every day comes from a published roster'
		}
	];

	const WEEKDAY_LABELS: Record<Weekday, string> = {
		MON: 'Monday',
		TUE: 'Tuesday',
		WED: 'Wednesday',
		THU: 'Thursday',
		FRI: 'Friday',
		SAT: 'Saturday',
		SUN: 'Sunday'
	};

	const WEEK_START_OPTIONS = WEEKDAYS.map((day) => ({
		value: day,
		label: WEEKDAY_LABELS[day]
	}));

	let props: RendererProps = $props();
	const disabled = $derived(props.mode === 'edit' ? props.disabled : true);
	const parsed = $derived(workPatternVariantSchema.safeParse(props.value));
	const current = $derived(parsed.success ? parsed.data : null);

	/** Weekdays in the pattern's own order, so a Tuesday week reads Tue…Mon. */
	const orderedWeek = $derived.by((): Weekday[] => {
		const start = current === null ? 0 : WEEKDAYS.indexOf(current.week_starts_on);
		return WEEKDAYS.map((_, offset) => WEEKDAYS[(start + offset) % 7]!);
	});

	function roleOf(day: Weekday): DayRole {
		if (current === null || current.type !== 'STANDARD') return 'WORK';
		if (current.rest_days.includes(day)) return 'REST';
		if (current.off_days.includes(day)) return 'OFF';
		return 'WORK';
	}

	const summary = $derived.by(() => {
		if (current === null) return '—';
		if (current.type === 'ROSTERED') {
			return `Rostered · week starts ${WEEKDAY_LABELS[current.week_starts_on]}`;
		}
		const working = orderedWeek.filter((day) => roleOf(day) === 'WORK');
		const rest = current.rest_days.join(', ') || 'none';
		const off = current.off_days.join(', ') || 'none';
		return `${working.length} working days · rest ${rest} · off ${off}`;
	});

	function emit(next: Value | null): void {
		if (props.mode === 'edit') props.onValueChange(next);
	}

	function defaultFor(type: VariantType): Value {
		switch (type) {
			case 'STANDARD':
				return {
					type: 'STANDARD',
					week_starts_on: 'MON',
					rest_days: ['SUN'],
					off_days: ['SAT']
				};
			case 'ROSTERED':
				return { type: 'ROSTERED', week_starts_on: 'MON' };
		}
	}

	function selectType(type: VariantType | null): void {
		if (type === null) {
			emit(null);
			return;
		}
		if (current !== null && current.type === type) return;
		emit(defaultFor(type));
	}

	function selectWeekStart(day: Weekday | null): void {
		if (current === null || day === null) return;
		emit({ ...current, week_starts_on: day });
	}

	function assignRole(day: Weekday, role: DayRole): void {
		if (current === null || current.type !== 'STANDARD') return;
		emit({
			...current,
			rest_days:
				role === 'REST'
					? [...current.rest_days.filter((entry) => entry !== day), day]
					: current.rest_days.filter((entry) => entry !== day),
			off_days:
				role === 'OFF'
					? [...current.off_days.filter((entry) => entry !== day), day]
					: current.off_days.filter((entry) => entry !== day)
		});
	}
</script>

{#if props.mode === 'display'}
	<span class="block truncate" title={summary}>{summary}</span>
{:else}
	<Stack class="rounded-md border border-border bg-muted/20 p-3" gap="md">
		<Grid gap="sm" minimum="compact">
			<label class="grid gap-1.5 text-sm font-medium">
				Scheduling strategy
				<Combobox
					options={TYPE_OPTIONS}
					value={current?.type ?? null}
					{disabled}
					searchable={false}
					emptyPlaceholder="Select a strategy"
					onValueChange={selectType}
				/>
			</label>
			{#if current !== null}
				<label class="grid gap-1.5 text-sm font-medium">
					Week starts on
					<Combobox
						options={WEEK_START_OPTIONS}
						value={current.week_starts_on}
						{disabled}
						searchable={false}
						emptyPlaceholder="Select a weekday"
						onValueChange={selectWeekStart}
					/>
				</label>
			{/if}
		</Grid>

		{#if current?.type === 'STANDARD'}
			<Stack gap="xs">
				<span class="text-sm font-medium">Shape of the week</span>
				<span class="text-xs text-muted-foreground">
					At least one rest day is required. Work on a rest day earns the rest-day multiple; work on
					an off day earns the ordinary one.
				</span>
			</Stack>
			<Stack gap="xs">
				{#each orderedWeek as day (day)}
					<Inline gap="sm" align="center" justify="between">
						<span class="text-sm">{WEEKDAY_LABELS[day]}</span>
						<ToggleGroup
							type="single"
							value={roleOf(day)}
							{disabled}
							onValueChange={(value) => {
								if (value) assignRole(day, value as DayRole);
							}}
						>
							<ToggleGroupItem value="WORK">Working</ToggleGroupItem>
							<ToggleGroupItem value="REST">Rest</ToggleGroupItem>
							<ToggleGroupItem value="OFF">Off</ToggleGroupItem>
						</ToggleGroup>
					</Inline>
				{/each}
			</Stack>
			{#if current.rest_days.length === 0}
				<span class="text-xs text-destructive">
					A week with no rest day cannot be saved. Name at least one.
				</span>
			{/if}
		{:else if current?.type === 'ROSTERED'}
			<span class="text-xs text-muted-foreground">
				Days come from the published monthly roster. The weekly rest minimum is checked against the
				week that begins on {WEEKDAY_LABELS[current.week_starts_on]}.
			</span>
		{/if}
	</Stack>
{/if}
