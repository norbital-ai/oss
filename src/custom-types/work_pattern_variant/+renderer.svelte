<script lang="ts">
	import { useI18n } from '@norbital-ai/ui/i18n';
	import type { TenantI18nKeys } from '$pod/i18n-keys';
	import { Combobox } from '@norbital-ai/ui/combobox';
	import { Grid, Inline, Stack } from '@norbital-ai/ui/layout';
	import { ToggleGroup, ToggleGroupItem } from '@norbital-ai/ui/toggle-group';
	import { WEEKDAYS, workPatternVariantSchema, type Weekday } from './+definition.js';
	import type { RendererProps, Value } from './$types.js';

	const { t } = useI18n<TenantI18nKeys>();

	type VariantType = Value['type'];
	/** What a single weekday is on a STANDARD week. Working days are the ones named as neither. */
	type DayRole = 'WORK' | 'REST' | 'OFF';

	const TYPE_OPTIONS = $derived<{ value: VariantType; label: string; description: string }[]>([
		{
			value: 'STANDARD',
			label: t('renderer.work_pattern_variant.type_standard'),
			description: t('renderer.work_pattern_variant.type_standard_desc')
		},
		{
			value: 'ROSTERED',
			label: t('renderer.work_pattern_variant.type_rostered'),
			description: t('renderer.work_pattern_variant.type_rostered_desc')
		}
	]);

	const WEEKDAY_LABELS: Record<Weekday, string> = {
		MON: t('component.weekday_mon'),
		TUE: t('component.weekday_tue'),
		WED: t('component.weekday_wed'),
		THU: t('component.weekday_thu'),
		FRI: t('component.weekday_fri'),
		SAT: t('component.weekday_sat'),
		SUN: t('component.weekday_sun')
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
			return t('renderer.work_pattern_variant.summary_rostered', {
				weekday: WEEKDAY_LABELS[current.week_starts_on]
			});
		}
		const working = orderedWeek.filter((day) => roleOf(day) === 'WORK');
		const rest = current.rest_days.join(', ') || t('component.categories_none');
		const off = current.off_days.join(', ') || t('component.categories_none');
		return t('renderer.work_pattern_variant.summary_standard', {
			count: working.length,
			rest,
			off
		});
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
				{t('renderer.work_pattern_variant.scheduling_strategy')}
				<Combobox
					options={TYPE_OPTIONS}
					value={current?.type ?? null}
					{disabled}
					searchable={false}
					emptyPlaceholder={t('renderer.work_pattern_variant.select_strategy')}
					onValueChange={selectType}
				/>
			</label>
			{#if current !== null}
				<label class="grid gap-1.5 text-sm font-medium">
					{t('renderer.work_pattern_variant.week_starts_on')}
					<Combobox
						options={WEEK_START_OPTIONS}
						value={current.week_starts_on}
						{disabled}
						searchable={false}
						emptyPlaceholder={t('renderer.work_pattern_variant.select_weekday')}
						onValueChange={selectWeekStart}
					/>
				</label>
			{/if}
		</Grid>

		{#if current?.type === 'STANDARD'}
			<Stack gap="xs">
				<span class="text-sm font-medium">{t('renderer.work_pattern_variant.shape_of_week')}</span>
				<span class="text-xs text-muted-foreground">
					{t('renderer.work_pattern_variant.shape_of_week_hint')}
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
							<ToggleGroupItem value="WORK">{t('component.working')}</ToggleGroupItem>
							<ToggleGroupItem value="REST">{t('component.rest')}</ToggleGroupItem>
							<ToggleGroupItem value="OFF">{t('component.off')}</ToggleGroupItem>
						</ToggleGroup>
					</Inline>
				{/each}
			</Stack>
			{#if current.rest_days.length === 0}
				<span class="text-xs text-destructive">
					{t('renderer.work_pattern_variant.no_rest_day_error')}
				</span>
			{/if}
		{:else if current?.type === 'ROSTERED'}
			<span class="text-xs text-muted-foreground">
				{t('renderer.work_pattern_variant.rostered_hint', {
					weekday: WEEKDAY_LABELS[current.week_starts_on]
				})}
			</span>
		{/if}
	</Stack>
{/if}
