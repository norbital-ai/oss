<script lang="ts">
	import { useI18n } from '@norbital-ai/ui/i18n';
	import type { TenantI18nKeys } from '$pod/i18n-keys';
	import { client } from '$pod/client';
	import type { CollectionField } from '@norbital-ai/ui/data-renderer';
	import { MatrixRenderer, type MatrixColumn } from '@norbital-ai/ui/data-renderer/matrix';
	import { repaymentScheduleSchema } from './+definition.js';
	import type { RendererProps, Value } from './$types.js';
	import ConsumedByCell from '../../lib/ui/repayment-schedule/consumed-by-cell.svelte';
	import { todayKey } from '../../lib/ui/calendar.js';
	import {
		repaymentConsumptionBySequence,
		repaymentRunLifecycleByPeriod,
		resolveRepaymentConsumption,
		type RepaymentConsumptionCell,
		type RepaymentConsumptionSourceRow,
		type RepaymentPeriodRunRow,
		type RepaymentScheduleMatrixRow
	} from '../../lib/ui/repayment-schedule/repayment-consumption.js';

	const { t } = useI18n<TenantI18nKeys>();

	type RepaymentScheduleRendererProps = RendererProps & {
		readonly row?: Record<string, unknown>;
	};
	const columns = [
		{
			key: 'due_date',
			label: 'Due date',
			field: { name: 'due_date', kind: 'date', nullable: false } satisfies CollectionField,
			width: 180
		},
		{
			key: 'amount',
			label: 'Amount',
			field: { name: 'amount', kind: 'numeric', nullable: false } satisfies CollectionField,
			width: 160
		},
		{
			key: 'consumed_by',
			label: 'Consumed by',
			field: {
				name: 'consumed_by',
				kind: 'text',
				nullable: true,
				readOnly: true
			} satisfies CollectionField,
			readOnly: true,
			renderer: ConsumedByCell,
			width: 280
		},
		{
			key: 'consumed_at',
			label: 'Consumed at',
			field: {
				name: 'consumed_at',
				kind: 'timestamptz',
				nullable: true,
				readOnly: true
			} satisfies CollectionField,
			readOnly: true,
			width: 220
		}
	] satisfies readonly MatrixColumn<RepaymentScheduleMatrixRow>[];

	let props: RepaymentScheduleRendererProps = $props();
	const disabled = $derived(props.mode === 'edit' ? props.disabled : true);
	const parsed = $derived(repaymentScheduleSchema.safeParse(props.value));
	const schedule = $derived(parsed.success ? parsed.data : []);
	const total = $derived(schedule.reduce((sum, entry) => sum + entry.amount, 0));
	const summary = $derived(
		parsed.success
			? `${schedule.length} instalment${schedule.length === 1 ? '' : 's'} · ${total.toFixed(2)}`
			: 'Invalid schedule'
	);
	const agreementId = $derived(
		typeof props.row?.norbital_id === 'string' ? props.row.norbital_id : null
	);
	const employmentId = $derived(
		typeof props.row?.employment_id === 'string' ? props.row.employment_id : null
	);
	const consumptionQuery = $derived(
		agreementId
			? client.db.component_entries.findMany({
					where: { repayment_agreement_id: { eq: agreementId } },
					columns: { norbital_id: true, repayment_sequence: true },
					with: {
						entry_payslip_lines: {
							columns: {
								norbital_id: true,
								sequence: true,
								amount: true,
								norbital_created_at: true
							},
							with: {
								payslip_line_payslip: {
									columns: { norbital_id: true },
									with: {
										payslip_payroll_run: {
											columns: {
												norbital_id: true,
												period: true,
												pay_date: true
											}
										}
									}
								}
							}
						}
					},
					orderBy: { repayment_sequence: 'asc' },
					limit: 600
				})
			: null
	);

	/**
	 * The pay calendar this schedule is read against.
	 *
	 * An instalment with no payslip line is only a defect once the run for its period has been
	 * *paid* — before that it is simply waiting. Answering "which of the four is this?" needs the
	 * agreement's company, which the agreement itself does not carry, so the employment supplies it.
	 */
	const employmentQuery = $derived(
		employmentId
			? client.db.employments.findFirst({ where: { norbital_id: { eq: employmentId } } })
			: null
	);
	const companyId = $derived(employmentQuery?.current?.company_id ?? null);
	const runsQuery = $derived(
		companyId
			? client.db.payroll_runs.findMany({
					where: { company_id: { eq: companyId } },
					orderBy: { period: 'asc' },
					limit: 600
				})
			: null
	);

	const consumptionBySequence = $derived(
		repaymentConsumptionBySequence(
			(consumptionQuery?.current ?? []) as readonly RepaymentConsumptionSourceRow[]
		)
	);
	const runLifecycleByPeriod = $derived(
		repaymentRunLifecycleByPeriod((runsQuery?.current ?? []) as readonly RepaymentPeriodRunRow[])
	);
	const pendingQuery = (query: { loading?: boolean; current?: unknown; error?: unknown } | null) =>
		query == null || query.loading || (query.current === undefined && query.error == null);
	const consumptionPending = $derived(
		Boolean(
			agreementId &&
			(pendingQuery(consumptionQuery) ||
				// The calendar is part of the answer, so a cell must not resolve before it lands —
				// otherwise every unconsumed row would flash "Awaiting …" and then correct itself.
				(employmentId != null && (pendingQuery(employmentQuery) || pendingQuery(runsQuery))))
		)
	);
	const consumptionError = $derived(
		consumptionQuery?.error ?? employmentQuery?.error ?? runsQuery?.error ?? null
	);

	function consumptionCell(sequence: number, dueDate: string): RepaymentConsumptionCell {
		if (consumptionPending) return { status: 'loading' };
		if (consumptionError) return { status: 'error', message: consumptionError.message };
		return resolveRepaymentConsumption({
			dueDate,
			reference: consumptionBySequence.get(sequence),
			runLifecycleByPeriod,
			today: todayKey()
		});
	}

	const rows = $derived(
		schedule.map((entry, sequence): RepaymentScheduleMatrixRow => {
			const consumedBy = consumptionCell(sequence + 1, entry.due_date);
			return {
				id: `instalment-${sequence}`,
				due_date: entry.due_date,
				amount: entry.amount,
				consumed_by: consumedBy,
				consumed_at: consumedBy.status === 'consumed' ? consumedBy.reference.consumedAt : null
			};
		})
	);
	const locked = $derived(
		disabled || props.mode === 'display' || consumptionPending || consumptionError != null
	);

	function emit(next: Value): void {
		if (props.mode === 'edit') props.onValueChange(next);
	}

	function nextDate(): string {
		const last = schedule.at(-1)?.due_date ?? todayKey();
		const parsedDate = new Date(`${last}T00:00:00.000Z`);
		parsedDate.setUTCMonth(parsedDate.getUTCMonth() + 1);
		return parsedDate.toISOString().slice(0, 10);
	}
</script>

{#if props.mode === 'display'}
	<span class="block truncate" title={summary}>{summary}</span>
{:else}
	<MatrixRenderer
		{rows}
		{columns}
		disabled={locked}
		emptyMessage={t('renderer.repayment_schedule.empty')}
		createRow={(): RepaymentScheduleMatrixRow => {
			const dueDate = nextDate();
			return {
				id: crypto.randomUUID(),
				due_date: dueDate,
				amount: 0.01,
				consumed_by: consumptionCell(schedule.length + 1, dueDate),
				consumed_at: null
			};
		}}
		addRowLabel="Add instalment"
		allowRemoveRows={true}
		canRemoveRow={(row) =>
			schedule.length > 1 && row.consumed_by.status !== 'consumed' && !consumptionPending}
		isRowDisabled={(row) => row.consumed_by.status === 'consumed'}
		bounded={false}
		onChange={(nextRows) =>
			emit(nextRows.map(({ due_date, amount }) => ({ due_date, amount })) as Value)}
	/>
{/if}
