<script lang="ts">
	import {
		PAYROLL_TIME_ZONE,
		calendarDateInTimeZone,
		startOfDayInstant,
		todayKey
	} from '../../lib/ui/calendar.js';
	import { formatCalendarDate } from '../../lib/ui/display-formatters.js';
	import { numberFrom, splitList } from '../../lib/ui/renderer-input.js';
	import { useI18n } from '@norbital-ai/ui/i18n';
	import type { TenantI18nKeys } from '$pod/i18n-keys';
	import { client } from '$pod/client';
	import { Combobox } from '@norbital-ai/ui/combobox';
	import { DataRenderer, type CollectionField } from '@norbital-ai/ui/data-renderer';
	import { Input } from '@norbital-ai/ui/input';
	import { Grid, Stack } from '@norbital-ai/ui/layout';
	import { entryOriginSchema } from './+definition.js';
	import type { RendererProps, Value } from './$types.js';

	const { t } = useI18n<TenantI18nKeys>();

	type OriginKind = Value['kind'];
	type EntryOriginRendererProps = RendererProps & {
		/** The component entry being edited — what scopes the agreements and entries offered below. */
		readonly row?: Record<string, unknown>;
	};

	const EVIDENCE_FIELD = {
		name: 'evidence_file',
		kind: 'file',
		nullable: true
	} satisfies CollectionField;

	const KIND_OPTIONS = $derived<{ value: OriginKind; label: string; description: string }[]>([
		{
			value: 'RECURRING',
			label: t('renderer.entry_origin.kind_recurring'),
			description: t('renderer.entry_origin.kind_recurring_desc')
		},
		{
			value: 'ONE_OFF',
			label: t('renderer.entry_origin.kind_one_off'),
			description: t('renderer.entry_origin.kind_one_off_desc')
		},
		{
			value: 'CLAIM',
			label: t('renderer.entry_origin.kind_claim'),
			description: t('renderer.entry_origin.kind_claim_desc')
		},
		{
			value: 'LOAN_INSTALMENT',
			label: t('renderer.entry_origin.kind_instalment'),
			description: t('renderer.entry_origin.kind_instalment_desc')
		},
		{
			value: 'REVERSAL',
			label: t('renderer.entry_origin.kind_reversal'),
			description: t('renderer.entry_origin.kind_reversal_desc')
		},
		{
			value: 'ARREARS',
			label: t('renderer.entry_origin.kind_arrears'),
			description: t('renderer.entry_origin.kind_arrears_desc')
		}
	]);

	let props: EntryOriginRendererProps = $props();
	const disabled = $derived(props.mode === 'edit' ? props.disabled : true);

	/*
	 * `agreement_id` and `reverses_entry_id` are foreign keys no constraint can declare — a variant
	 * is one JSONB value — so both option sets are built here, scoped to the employment this entry
	 * belongs to. Asking an operator to paste a uuid was the alternative.
	 */
	const employmentId = $derived(
		typeof props.row?.employment_id === 'string' ? props.row.employment_id : null
	);
	const agreementsQuery = $derived(
		employmentId == null
			? null
			: client.db.repayment_agreements.findMany({
					where: { employment_id: { eq: employmentId } },
					orderBy: { reference: 'asc' },
					limit: 200
				})
	);
	const agreementOptions = $derived(
		(agreementsQuery?.current ?? []).map((agreement) => ({
			value: agreement.norbital_id,
			label:
				agreement.reference != null && agreement.reference !== ''
					? String(agreement.reference)
					: '—',
			search_term: String(agreement.reference ?? '')
		}))
	);
	const entriesQuery = $derived(
		employmentId == null
			? null
			: client.db.component_entries.findMany({
					where: { employment_id: { eq: employmentId } },
					orderBy: { event_date: 'desc' },
					limit: 500
				})
	);
	const entryOptions = $derived(
		(entriesQuery?.current ?? [])
			.filter((entry) => entry.norbital_id !== props.row?.norbital_id)
			.map((entry) => ({
				value: entry.norbital_id,
				label:
					[formatCalendarDate(entry.event_date), entry.description]
						.filter((part) => part != null && part !== '' && part !== '—')
						.join(' · ') || '—',
				search_term: String(entry.description ?? '')
			}))
	);
	const parsed = $derived(entryOriginSchema.safeParse(props.value));
	const current = $derived(parsed.success ? parsed.data : null);
	const summary = $derived.by(() => {
		if (current === null) return '—';
		switch (current.kind) {
			case 'RECURRING':
				return t('renderer.entry_origin.summary_recurring', {
					from: formatCalendarDate(dateOf(current.effective_range.start)),
					to: formatCalendarDate(dateOf(current.effective_range.end))
				});
			case 'ONE_OFF':
				return current.note.length === 0
					? t('renderer.entry_origin.summary_one_off')
					: t('renderer.entry_origin.summary_one_off_note', { note: current.note });
			case 'CLAIM':
				return t('renderer.entry_origin.summary_claim', {
					date: formatCalendarDate(current.incurred_on)
				});
			case 'LOAN_INSTALMENT':
				return t('renderer.entry_origin.summary_instalment', {
					sequence: current.sequence,
					of: current.of
				});
			case 'REVERSAL':
				return t('renderer.entry_origin.summary_reversal', { reason: current.reason });
			case 'ARREARS':
				return t('renderer.entry_origin.summary_arrears', {
					periods: current.covers_periods.join(', ')
				});
		}
	});

	function emit(next: Value | null): void {
		if (props.mode === 'edit') props.onValueChange(next);
	}

	/**
	 * An `effective_range` bound is an instant; the picker beside it offers a calendar day. Both
	 * directions resolve through the payroll timezone, so the day an operator picks is the day the
	 * range starts locally. Slicing the instant, or appending `Z` to the picked day, would place the
	 * boundary eight hours into the adjacent local day — which is what
	 * `dates-and-time.md` forbids.
	 */
	function dateOf(instant: string | undefined): string {
		return instant == null ? '' : calendarDateInTimeZone(new Date(instant), PAYROLL_TIME_ZONE);
	}

	function instantOf(date: string, fallback: string | undefined): string {
		return date.trim().length === 0
			? (fallback ?? startOfDayInstant(todayKey(), PAYROLL_TIME_ZONE))
			: startOfDayInstant(date, PAYROLL_TIME_ZONE);
	}

	function defaultFor(kind: OriginKind): Value {
		const today = todayKey();
		switch (kind) {
			case 'RECURRING':
				return {
					kind: 'RECURRING',
					cadence: 'PAY_PERIOD',
					effective_range: {
						start: startOfDayInstant(today, PAYROLL_TIME_ZONE),
						end: startOfDayInstant(
							`${Number(today.slice(0, 4)) + 1}${today.slice(4)}`,
							PAYROLL_TIME_ZONE
						)
					}
				};
			case 'ONE_OFF':
				return { kind: 'ONE_OFF', note: '' };
			case 'CLAIM':
				return { kind: 'CLAIM', evidence_file: null, incurred_on: today };
			case 'LOAN_INSTALMENT':
				return { kind: 'LOAN_INSTALMENT', agreement_id: '', sequence: 1, of: 1 };
			case 'REVERSAL':
				return { kind: 'REVERSAL', reverses_entry_id: '', reason: '' };
			case 'ARREARS':
				return { kind: 'ARREARS', covers_periods: [], reason: '' };
		}
	}

	/*
	 * Every variant renderer needs this same three-line guard, but it closes over this file's
	 * `current`, `emit` and `defaultFor`. Sharing it would mean a generic taking three callbacks —
	 * `controller-surfaces.md` §2 calls that a wrapper thinner than the thing it wraps. The pure
	 * coercions these renderers used to duplicate did move, to lib/ui/renderer-input.ts.
	 */
	// stupidity:allow D1 -- closes over this file's current/emit/defaultFor; see the note above.
	function selectKind(kind: OriginKind | null): void {
		if (kind === null) {
			emit(null);
			return;
		}
		if (current !== null && current.kind === kind) return;
		emit(defaultFor(kind));
	}
</script>

{#if props.mode === 'display'}
	<span class="block truncate" title={summary}>{summary}</span>
{:else}
	<Grid class="rounded-md border border-border bg-muted/20 p-3" gap="sm" minimum="compact">
		<label class="grid gap-1.5 text-sm font-medium">
			{t('component.origin')}
			<Combobox
				options={KIND_OPTIONS}
				value={current?.kind ?? null}
				{disabled}
				searchable={false}
				emptyPlaceholder={t('renderer.entry_origin.select_origin')}
				onValueChange={selectKind}
			/>
		</label>

		{#if current?.kind === 'RECURRING'}
			{@const range = current.effective_range}
			<label class="grid gap-1.5 text-sm font-medium">
				{t('component.effective_from')}
				<Input
					type="date"
					value={dateOf(range.start)}
					{disabled}
					oninput={(event) =>
						emit({
							kind: 'RECURRING',
							cadence: 'PAY_PERIOD',
							effective_range: {
								...range,
								start: instantOf(event.currentTarget.value, range.start)
							}
						})}
				/>
			</label>
			<label class="grid gap-1.5 text-sm font-medium">
				{t('component.effective_to')}
				<Input
					type="date"
					value={dateOf(range.end)}
					{disabled}
					oninput={(event) =>
						emit({
							kind: 'RECURRING',
							cadence: 'PAY_PERIOD',
							effective_range: { ...range, end: instantOf(event.currentTarget.value, range.end) }
						})}
				/>
			</label>
		{:else if current?.kind === 'ONE_OFF'}
			<label class="grid gap-1.5 text-sm font-medium">
				{t('component.note')}
				<Input
					value={current.note}
					{disabled}
					placeholder={t('component.why_this_entry_exists')}
					oninput={(event) => emit({ kind: 'ONE_OFF', note: event.currentTarget.value })}
				/>
			</label>
		{:else if current?.kind === 'CLAIM'}
			<label class="grid gap-1.5 text-sm font-medium">
				{t('renderer.entry_origin.incurred_on')}
				<Input
					type="date"
					value={current.incurred_on}
					{disabled}
					oninput={(event) => emit({ ...current, incurred_on: event.currentTarget.value })}
				/>
			</label>
			<Stack gap="xs" class="text-sm font-medium">
				<span>{t('component.evidence')}</span>
				<DataRenderer
					field={EVIDENCE_FIELD}
					value={current.evidence_file}
					mode="edit"
					{disabled}
					onValueChange={(next) =>
						emit({
							...current,
							evidence_file: typeof next === 'string' && next !== '' ? next : null
						})}
				/>
			</Stack>
		{:else if current?.kind === 'LOAN_INSTALMENT'}
			<label class="grid gap-1.5 text-sm font-medium">
				{t('renderer.entry_origin.repayment_agreement')}
				<Combobox
					ariaLabel={t('renderer.entry_origin.repayment_agreement')}
					options={agreementOptions}
					value={current.agreement_id === '' ? null : current.agreement_id}
					disabled={disabled || employmentId == null}
					searchPlaceholder={t('renderer.entry_origin.search_agreements')}
					emptyPlaceholder={t('renderer.entry_origin.choose_agreement')}
					clientConfig={{
						isLoading: agreementsQuery?.loading ?? false,
						error: agreementsQuery?.error?.message ?? null
					}}
					onValueChange={(value) =>
						emit({ ...current, agreement_id: typeof value === 'string' ? value : '' })}
				/>
			</label>
			<label class="grid gap-1.5 text-sm font-medium">
				{t('renderer.entry_origin.sequence')}
				<Input
					type="number"
					min="1"
					step="1"
					value={current.sequence}
					{disabled}
					oninput={(event) =>
						emit({ ...current, sequence: numberFrom(event.currentTarget.value, 1) })}
				/>
			</label>
			<label class="grid gap-1.5 text-sm font-medium">
				{t('renderer.entry_origin.of')}
				<Input
					type="number"
					min="1"
					step="1"
					value={current.of}
					{disabled}
					oninput={(event) => emit({ ...current, of: numberFrom(event.currentTarget.value, 1) })}
				/>
			</label>
		{:else if current?.kind === 'REVERSAL'}
			<label class="grid gap-1.5 text-sm font-medium">
				{t('renderer.entry_origin.reverses')}
				<Combobox
					ariaLabel={t('renderer.entry_origin.reversed_entry')}
					options={entryOptions}
					value={current.reverses_entry_id === '' ? null : current.reverses_entry_id}
					disabled={disabled || employmentId == null}
					searchPlaceholder={t('renderer.entry_origin.search_entries')}
					emptyPlaceholder={t('renderer.entry_origin.choose_entry')}
					clientConfig={{
						isLoading: entriesQuery?.loading ?? false,
						error: entriesQuery?.error?.message ?? null
					}}
					onValueChange={(value) =>
						emit({ ...current, reverses_entry_id: typeof value === 'string' ? value : '' })}
				/>
			</label>
			<label class="grid gap-1.5 text-sm font-medium">
				{t('renderer.entry_origin.reason')}
				<Input
					value={current.reason}
					{disabled}
					oninput={(event) => emit({ ...current, reason: event.currentTarget.value })}
				/>
			</label>
		{:else if current?.kind === 'ARREARS'}
			<label class="grid gap-1.5 text-sm font-medium">
				{t('renderer.entry_origin.covers_periods')}
				<Input
					value={current.covers_periods.join(', ')}
					{disabled}
					placeholder={t('component.pay_periods')}
					oninput={(event) =>
						emit({ ...current, covers_periods: splitList(event.currentTarget.value) })}
				/>
			</label>
			<label class="grid gap-1.5 text-sm font-medium">
				{t('renderer.entry_origin.reason')}
				<Input
					value={current.reason}
					{disabled}
					oninput={(event) => emit({ ...current, reason: event.currentTarget.value })}
				/>
			</label>
		{/if}
	</Grid>
{/if}
