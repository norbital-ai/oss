<script lang="ts">
	import { Combobox } from '@norbital-ai/ui/combobox';
	import { Input } from '@norbital-ai/ui/input';
	import { Grid } from '@norbital-ai/ui/layout';
	import { componentDefinitionSchema } from './+definition.js';
	import type { RendererProps, Value } from './$types.js';

	type Source = Value['source'];
	type EntryArm = Extract<Value, { source: 'ENTRY' }>;
	type Cap = NonNullable<EntryArm['cap']>;
	type EntryUnit = EntryArm['unit'];
	type Evidence = EntryArm['evidence'];
	type Settlement = EntryArm['settlement'];
	type FormulaUnit = Extract<Value, { source: 'FORMULA' }>['unit'];
	type OvertimeRule = Extract<Value, { source: 'OVERTIME' }>['rule'];
	type DayType = OvertimeRule['day_type'];
	type Measure = OvertimeRule['measure'];
	type CapPeriod = Cap['period'];
	type CapOnExceed = Cap['on_exceed'];

	function options<T extends string>(values: readonly T[]): { value: T; label: string }[] {
		return values.map((value) => ({ value, label: value.replaceAll('_', ' ').toLowerCase() }));
	}

	const SOURCE_OPTIONS: { value: Source; label: string; description: string }[] = [
		{ value: 'ENTRY', label: 'Entry', description: 'Supplied by a person or an import' },
		{ value: 'FORMULA', label: 'Formula', description: 'CEL expression over the payslip context' },
		{ value: 'OVERTIME', label: 'Overtime', description: 'Derived from time entries' },
		{
			value: 'OVERTIME_EXCESS',
			label: 'Overtime excess',
			description: 'Overtime corresponding to work beyond the total-work-hours boundary'
		},
		{ value: 'SCHEDULE', label: 'Schedule', description: 'The contracted amount on the terms' }
	];
	const ENTRY_UNIT_OPTIONS = options<EntryUnit>(['MONEY', 'DAYS', 'HOURS']);
	const FORMULA_UNIT_OPTIONS = options<FormulaUnit>(['MONEY', 'DAYS', 'HOURS', 'RATE']);
	const EVIDENCE_OPTIONS = options<Evidence>(['NONE', 'OPTIONAL', 'REQUIRED']);
	const SETTLEMENT_OPTIONS = options<Settlement>(['PAYROLL', 'COMPANY_DIRECT']);
	const DAY_TYPE_OPTIONS = options<DayType>(['ORDINARY', 'REST_DAY', 'PUBLIC_HOLIDAY']);
	const MEASURE_OPTIONS = options<Measure>(['BEYOND_NORMAL', 'FROM_START_OF_DAY']);
	const CAP_PERIOD_OPTIONS = options<CapPeriod>([
		'CALENDAR_YEAR',
		'LEAVE_YEAR',
		'MONTH',
		'LIFETIME',
		'PER_EVENT'
	]);
	const CAP_ON_EXCEED_OPTIONS = options<CapOnExceed>(['BLOCK', 'ALLOW']);

	const DEFAULT_CAP: Cap = {
		period: 'CALENDAR_YEAR',
		matrix: '',
		reimbursement_percentage: 100,
		on_exceed: 'BLOCK'
	};

	let props: RendererProps = $props();
	const disabled = $derived(props.mode === 'edit' ? props.disabled : true);
	const parsed = $derived(componentDefinitionSchema.safeParse(props.value));
	const current = $derived(parsed.success ? parsed.data : null);
	const summary = $derived.by(() => {
		if (current === null) return '—';
		switch (current.source) {
			case 'ENTRY':
				return `Entry · ${current.unit} · ${current.settlement}${current.cap === null ? '' : ' · capped'}`;
			case 'FORMULA':
				return `Formula · ${current.unit} · ${current.expr}`;
			case 'OVERTIME':
				return `Overtime · ${current.rule.day_type} · ${current.rule.measure} from ${current.rule.band_from}`;
			case 'OVERTIME_EXCESS':
				return `Overtime excess · ${current.rule.day_type} · ${current.rule.measure} from ${current.rule.band_from} · ordinary hourly`;
			case 'SCHEDULE':
				return `Schedule · ${current.reducible ? 'reducible' : 'not reducible'}`;
		}
	});

	function emit(next: Value | null): void {
		if (props.mode === 'edit') props.onValueChange(next);
	}

	function defaultFor(source: Source): Value {
		switch (source) {
			case 'ENTRY':
				return {
					source: 'ENTRY',
					unit: 'MONEY',
					evidence: 'NONE',
					cap: null,
					settlement: 'PAYROLL'
				};
			case 'FORMULA':
				return { source: 'FORMULA', unit: 'MONEY', expr: '' };
			case 'OVERTIME':
				return {
					source: 'OVERTIME',
					rule: { day_type: 'ORDINARY', measure: 'BEYOND_NORMAL', band_from: 0 },
					minimum: null
				};
			case 'OVERTIME_EXCESS':
				return {
					source: 'OVERTIME_EXCESS',
					after_total_work_hours: 12,
					rule: { day_type: 'ORDINARY', measure: 'BEYOND_NORMAL', band_from: 0 },
					valued_at: 'ORDINARY_HOURLY'
				};
			case 'SCHEDULE':
				return { source: 'SCHEDULE', unit: 'MONEY', reducible: true };
		}
	}

	function selectSource(source: Source | null): void {
		if (source === null) {
			emit(null);
			return;
		}
		if (current !== null && current.source === source) return;
		emit(defaultFor(source));
	}

	function numberFrom(raw: string, fallback: number): number {
		const next = Number(raw);
		return Number.isFinite(next) ? next : fallback;
	}

	function nullableNumberFrom(raw: string): number | null {
		if (raw.trim().length === 0) return null;
		const next = Number(raw);
		return Number.isFinite(next) ? next : null;
	}
</script>

{#if props.mode === 'display'}
	<span class="block truncate" title={summary}>{summary}</span>
{:else}
	<Grid class="rounded-md border border-border bg-muted/20 p-3" gap="sm" minimum="compact">
		<label class="grid gap-1.5 text-sm font-medium">
			Source
			<Combobox
				options={SOURCE_OPTIONS}
				value={current?.source ?? null}
				{disabled}
				searchable={false}
				emptyPlaceholder="Select a source"
				onValueChange={selectSource}
			/>
		</label>

		{#if current?.source === 'ENTRY'}
			<label class="grid gap-1.5 text-sm font-medium">
				Unit
				<Combobox
					options={ENTRY_UNIT_OPTIONS}
					value={current.unit}
					{disabled}
					searchable={false}
					onValueChange={(unit) => {
						if (unit !== null) emit({ ...current, unit });
					}}
				/>
			</label>
			<label class="grid gap-1.5 text-sm font-medium">
				Evidence
				<Combobox
					options={EVIDENCE_OPTIONS}
					value={current.evidence}
					{disabled}
					searchable={false}
					onValueChange={(evidence) => {
						if (evidence !== null) emit({ ...current, evidence });
					}}
				/>
			</label>
			<label class="grid gap-1.5 text-sm font-medium">
				Settlement
				<Combobox
					options={SETTLEMENT_OPTIONS}
					value={current.settlement}
					{disabled}
					searchable={false}
					onValueChange={(settlement) => {
						if (settlement !== null) emit({ ...current, settlement });
					}}
				/>
			</label>
			<label class="flex items-center gap-2 self-end text-sm font-medium">
				<input
					type="checkbox"
					class="size-4"
					checked={current.cap !== null}
					{disabled}
					onchange={(event) =>
						emit({ ...current, cap: event.currentTarget.checked ? DEFAULT_CAP : null })}
				/>
				Capped
			</label>

			{#if current.cap !== null}
				{@const cap = current.cap}
				<label class="grid gap-1.5 text-sm font-medium">
					Cap period
					<Combobox
						options={CAP_PERIOD_OPTIONS}
						value={cap.period}
						{disabled}
						searchable={false}
						onValueChange={(period) => {
							if (period !== null) emit({ ...current, cap: { ...cap, period } });
						}}
					/>
				</label>
				<label class="grid gap-1.5 text-sm font-medium">
					Cap matrix
					<Input
						value={cap.matrix}
						{disabled}
						placeholder="Name of the cap band table"
						oninput={(event) =>
							emit({ ...current, cap: { ...cap, matrix: event.currentTarget.value } })}
					/>
				</label>
				<label class="grid gap-1.5 text-sm font-medium">
					Reimbursement (%)
					<Input
						type="number"
						min="0"
						max="100"
						step="1"
						value={cap.reimbursement_percentage}
						{disabled}
						oninput={(event) =>
							emit({
								...current,
								cap: {
									...cap,
									reimbursement_percentage: numberFrom(event.currentTarget.value, 100)
								}
							})}
					/>
				</label>
				<label class="grid gap-1.5 text-sm font-medium">
					On exceed
					<Combobox
						options={CAP_ON_EXCEED_OPTIONS}
						value={cap.on_exceed}
						{disabled}
						searchable={false}
						onValueChange={(onExceed) => {
							if (onExceed !== null) emit({ ...current, cap: { ...cap, on_exceed: onExceed } });
						}}
					/>
				</label>
			{/if}
		{:else if current?.source === 'FORMULA'}
			<label class="grid gap-1.5 text-sm font-medium">
				Unit
				<Combobox
					options={FORMULA_UNIT_OPTIONS}
					value={current.unit}
					{disabled}
					searchable={false}
					onValueChange={(unit) => {
						if (unit !== null) emit({ ...current, unit });
					}}
				/>
			</label>
			<label class="grid gap-1.5 text-sm font-medium">
				Expression
				<Input
					value={current.expr}
					{disabled}
					placeholder="CEL expression"
					oninput={(event) => emit({ ...current, expr: event.currentTarget.value })}
				/>
			</label>
		{:else if current?.source === 'OVERTIME'}
			{@const rule = current.rule}
			<label class="grid gap-1.5 text-sm font-medium">
				Day type
				<Combobox
					options={DAY_TYPE_OPTIONS}
					value={rule.day_type}
					{disabled}
					searchable={false}
					onValueChange={(dayType) => {
						if (dayType !== null) emit({ ...current, rule: { ...rule, day_type: dayType } });
					}}
				/>
			</label>
			<label class="grid gap-1.5 text-sm font-medium">
				Measure
				<Combobox
					options={MEASURE_OPTIONS}
					value={rule.measure}
					{disabled}
					searchable={false}
					onValueChange={(measure) => {
						if (measure !== null) emit({ ...current, rule: { ...rule, measure } });
					}}
				/>
			</label>
			<label class="grid gap-1.5 text-sm font-medium">
				Band from
				<Input
					type="number"
					min="0"
					step="0.25"
					value={rule.band_from}
					{disabled}
					oninput={(event) =>
						emit({
							...current,
							rule: { ...rule, band_from: numberFrom(event.currentTarget.value, 0) }
						})}
				/>
			</label>
			<label class="grid gap-1.5 text-sm font-medium">
				Minimum (blank = none)
				<Input
					type="number"
					min="0"
					step="0.01"
					value={current.minimum ?? ''}
					{disabled}
					oninput={(event) =>
						emit({ ...current, minimum: nullableNumberFrom(event.currentTarget.value) })}
				/>
			</label>
		{:else if current?.source === 'OVERTIME_EXCESS'}
			{@const excessRule = current.rule}
			<label class="grid gap-1.5 text-sm font-medium">
				Total-work-hours boundary
				<Input
					type="number"
					min="0.01"
					step="0.25"
					value={current.after_total_work_hours}
					{disabled}
					oninput={(event) =>
						emit({
							...current,
							after_total_work_hours: numberFrom(event.currentTarget.value, 12)
						})}
				/>
			</label>
			<label class="grid gap-1.5 text-sm font-medium">
				Day type
				<Combobox
					options={DAY_TYPE_OPTIONS}
					value={excessRule.day_type}
					{disabled}
					searchable={false}
					onValueChange={(dayType) => {
						if (dayType !== null) emit({ ...current, rule: { ...excessRule, day_type: dayType } });
					}}
				/>
			</label>
			<label class="grid gap-1.5 text-sm font-medium">
				Measure
				<Combobox
					options={MEASURE_OPTIONS}
					value={excessRule.measure}
					{disabled}
					searchable={false}
					onValueChange={(measure) => {
						if (measure !== null) emit({ ...current, rule: { ...excessRule, measure } });
					}}
				/>
			</label>
			<label class="grid gap-1.5 text-sm font-medium">
				Band from
				<Input
					type="number"
					min="0"
					step="0.25"
					value={excessRule.band_from}
					{disabled}
					oninput={(event) =>
						emit({
							...current,
							rule: { ...excessRule, band_from: numberFrom(event.currentTarget.value, 0) }
						})}
				/>
			</label>
			<p class="self-end text-sm text-muted-foreground">
				The statutory award is priced first. Only the value corresponding to work beyond this
				total-work-hours boundary is routed to the incentive component.
			</p>
		{:else if current?.source === 'SCHEDULE'}
			<label class="flex items-center gap-2 self-end text-sm font-medium">
				<input
					type="checkbox"
					class="size-4"
					checked={current.reducible}
					{disabled}
					onchange={(event) => emit({ ...current, reducible: event.currentTarget.checked })}
				/>
				Reducible by unpaid absence
			</label>
		{/if}
	</Grid>
{/if}
