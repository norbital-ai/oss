<script lang="ts">
	import { useI18n } from '@norbital-ai/ui/i18n';
	import type { TenantI18nKeys } from '$pod/i18n-keys';
	import { nullableNumberFrom, numberFrom } from '../../lib/ui/renderer-input.js';
	import { PAYROLL_TIME_ZONE, startOfDayInstant, todayKey } from '../../lib/ui/calendar.js';
	import EffectiveLayerList from '../../lib/ui/policy-layers/effective-layer-list.svelte';
	import LayerLevelPicker, {
		type PolicyLayerLevel
	} from '../../lib/ui/policy-layers/layer-level-picker.svelte';
	import EligibilityRulesRenderer from '../eligibility_rules/+renderer.svelte';
	import { Combobox } from '@norbital-ai/ui/combobox';
	import type { CollectionField } from '@norbital-ai/ui/data-renderer';
	import { Input } from '@norbital-ai/ui/input';
	import { Column, Grid, Stack } from '@norbital-ai/ui/layout';
	import { componentDefinitionSchema } from './+definition.js';
	import type { RendererProps, Value } from './$types.js';

	const { t } = useI18n<TenantI18nKeys>();

	type Source = Value['source'];
	type EntryArm = Extract<Value, { source: 'ENTRY' }>;
	type Cap = NonNullable<EntryArm['cap']>;
	type CapLayer = Cap['matrix']['layers'][number];
	type CapAward = CapLayer['award'];
	type AwardKind = CapAward['kind'];
	type Eligibility = CapLayer['eligibility'];
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
	const AWARD_OPTIONS: { value: AwardKind; label: string; description: string }[] = [
		{ value: 'FIXED', label: 'Fixed amount', description: 'The ceiling is a number' },
		{
			value: 'FORMULA',
			label: 'Formula',
			description: 'The ceiling is a CEL expression over the payslip context'
		}
	];
	const ELIGIBILITY_FIELD = {
		name: 'eligibility',
		kind: 'eligibility_rules',
		nullable: false
	} satisfies CollectionField;

	/** A ceiling the policy has not withdrawn; a successor layer end-dates it. */
	const OPEN_ENDED = '9999-12-31T00:00:00.000Z';

	function newCapLayer(level: PolicyLayerLevel): CapLayer {
		const ceiling = {
			eligibility: [],
			authority: '',
			award: { kind: 'FIXED' as const, amount: 0 },
			reimbursement_percentage: 100,
			effective_range: {
				start: startOfDayInstant(todayKey(), PAYROLL_TIME_ZONE),
				end: OPEN_ENDED
			}
		};
		switch (level) {
			case 'STATUTORY':
				return { level: 'STATUTORY', ...ceiling };
			case 'ORGANISATION':
				return { level: 'ORGANISATION', ...ceiling };
			case 'EMPLOYEE':
				return { level: 'EMPLOYEE', employment_id: '', ...ceiling };
		}
	}

	/**
	 * Move a cap layer to another arm, carrying everything the arms share.
	 *
	 * Written out rather than spread so the EMPLOYEE arm's extra field is added and dropped
	 * explicitly: a spread would leave it behind on a STATUTORY layer, which `strictObject` rejects
	 * only at save time, long after the operator has moved on.
	 */
	function atCapLevel(layer: CapLayer, level: PolicyLayerLevel): CapLayer {
		const { eligibility, authority, award, reimbursement_percentage, effective_range } = layer;
		const ceiling = { eligibility, authority, award, reimbursement_percentage, effective_range };
		switch (level) {
			case 'STATUTORY':
				return { level: 'STATUTORY', ...ceiling };
			case 'ORGANISATION':
				return { level: 'ORGANISATION', ...ceiling };
			case 'EMPLOYEE':
				return {
					level: 'EMPLOYEE',
					employment_id: layer.level === 'EMPLOYEE' ? layer.employment_id : '',
					...ceiling
				};
		}
	}

	function defaultAward(kind: AwardKind): CapAward {
		return kind === 'FIXED' ? { kind: 'FIXED', amount: 0 } : { kind: 'FORMULA', expr: '' };
	}

	/**
	 * The cap a freshly ticked "Capped" box starts from.
	 *
	 * Built rather than declared as a constant because its bounds are instants resolved in the
	 * payroll timezone. The literal this replaced read `{ start: '2026-01-01', end: null }`, which is
	 * neither an instant nor a permitted `end` — `dateRangeZodSchema` requires both bounds — so
	 * ticking the box seeded a cap the form could not save.
	 */
	function defaultCap(): Cap {
		return {
			period: 'CALENDAR_YEAR',
			matrix: { merge: 'MAX_WITH_STATUTORY_FLOOR', layers: [newCapLayer('ORGANISATION')] },
			on_exceed: 'BLOCK'
		};
	}

	type ComponentDefinitionRendererProps = RendererProps & {
		/** The pay component being edited, which is what scopes the people a cap layer may name. */
		readonly row?: Record<string, unknown>;
	};

	let props: ComponentDefinitionRendererProps = $props();
	const disabled = $derived(props.mode === 'edit' ? props.disabled : true);
	const companyId = $derived(
		typeof props.row?.company_id === 'string' ? props.row.company_id : null
	);
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
						emit({ ...current, cap: event.currentTarget.checked ? defaultCap() : null })}
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
				<Column span="all">
					<EffectiveLayerList
						layers={cap.matrix.layers}
						{disabled}
						emptyMessage="No cap layers — the schema requires at least one before this saves."
						addPlaceholder="Add a cap layer…"
						additions={[
							{
								value: 'STATUTORY',
								label: 'Statutory layer',
								create: () => newCapLayer('STATUTORY')
							},
							{
								value: 'ORGANISATION',
								label: 'Organisation layer',
								create: () => newCapLayer('ORGANISATION')
							},
							{ value: 'EMPLOYEE', label: 'Employee layer', create: () => newCapLayer('EMPLOYEE') }
						]}
						onChange={(layers) =>
							emit({
								...current,
								cap: { ...cap, matrix: { merge: 'MAX_WITH_STATUTORY_FLOOR', layers } }
							})}
					>
						{#snippet identity(row)}
							<LayerLevelPicker
								level={row.layer.level}
								employmentId={row.layer.level === 'EMPLOYEE' ? row.layer.employment_id : null}
								{companyId}
								disabled={row.disabled}
								onLevelChange={(level) => row.replace(atCapLevel(row.layer, level))}
								onEmploymentChange={(employment) => {
									if (row.layer.level === 'EMPLOYEE')
										row.replace({ ...row.layer, employment_id: employment });
								}}
							/>
						{/snippet}

						{#snippet body(row)}
							<Grid gap="sm" minimum="compact">
								<label class="grid gap-1.5 text-sm font-medium">
									Ceiling
									<Combobox
										options={AWARD_OPTIONS}
										value={row.layer.award.kind}
										disabled={row.disabled}
										searchable={false}
										onValueChange={(kind) => {
											if (kind !== null && kind !== row.layer.award.kind)
												row.replace({ ...row.layer, award: defaultAward(kind) });
										}}
									/>
								</label>
								{#if row.layer.award.kind === 'FIXED'}
									<label class="grid gap-1.5 text-sm font-medium">
										Amount
										<Input
											type="number"
											min="0"
											step="0.01"
											value={row.layer.award.amount}
											disabled={row.disabled}
											oninput={(event) =>
												row.replace({
													...row.layer,
													award: { kind: 'FIXED', amount: numberFrom(event.currentTarget.value, 0) }
												})}
										/>
									</label>
								{:else}
									<label class="grid gap-1.5 text-sm font-medium">
										Expression
										<Input
											value={row.layer.award.expr}
											disabled={row.disabled}
											placeholder={t('component.cel_expression')}
											oninput={(event) =>
												row.replace({
													...row.layer,
													award: { kind: 'FORMULA', expr: event.currentTarget.value }
												})}
										/>
									</label>
								{/if}
								<label class="grid gap-1.5 text-sm font-medium">
									Reimbursed (%)
									<Input
										type="number"
										min="0"
										max="100"
										step="1"
										value={row.layer.reimbursement_percentage}
										disabled={row.disabled}
										oninput={(event) =>
											row.replace({
												...row.layer,
												reimbursement_percentage: numberFrom(event.currentTarget.value, 100)
											})}
									/>
								</label>
								<Column span="all">
									<Stack gap="xs" class="text-sm font-medium">
										<span>{t('component.who_this_layer_covers')}</span>
										<EligibilityRulesRenderer
											field={ELIGIBILITY_FIELD}
											value={row.layer.eligibility}
											mode="edit"
											disabled={row.disabled}
											onValueChange={(next: Eligibility | null) => {
												if (next !== null) row.replace({ ...row.layer, eligibility: next });
											}}
										/>
									</Stack>
								</Column>
							</Grid>
						{/snippet}
					</EffectiveLayerList>
				</Column>
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
					placeholder={t('component.cel_expression')}
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
