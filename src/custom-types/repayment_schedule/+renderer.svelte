<script lang="ts">
	import { client } from '$pod/client';
	import type { CollectionField } from '@norbital-ai/ui/data-renderer';
	import { MatrixRenderer, type MatrixColumn } from '@norbital-ai/ui/data-renderer/matrix';
	import { repaymentScheduleSchema } from './+definition.js';
	import type { RendererProps, Value } from './$types.js';
	import ConsumedByCell from '../../lib/ui/repayment-schedule/consumed-by-cell.svelte';
	import {
		repaymentConsumptionBySequence,
		type RepaymentConsumptionCell,
		type RepaymentConsumptionSourceRow,
		type RepaymentScheduleMatrixRow
	} from '../../lib/ui/repayment-schedule/repayment-consumption.js';

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
	const consumptionQuery = $derived(
		agreementId
			? client.db.component_entries.findMany({
					where: { repayment_agreement_id: { eq: agreementId } },
					columns: { norbital_id: true, repayment_sequence: true },
					with: {
						entry_payslip_lines: {
							columns: { norbital_id: true, sequence: true, norbital_created_at: true },
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

	const consumptionBySequence = $derived(
		repaymentConsumptionBySequence(
			(consumptionQuery?.current ?? []) as readonly RepaymentConsumptionSourceRow[]
		)
	);
	const consumptionPending = $derived(
		Boolean(
			agreementId &&
			(consumptionQuery == null ||
				consumptionQuery.loading ||
				(consumptionQuery.current === undefined && consumptionQuery.error == null))
		)
	);
	const consumptionError = $derived(consumptionQuery?.error ?? null);

	function consumptionCell(sequence: number): RepaymentConsumptionCell {
		if (consumptionPending) return { status: 'loading' };
		if (consumptionError) return { status: 'error', message: consumptionError.message };
		const reference = consumptionBySequence.get(sequence);
		return reference ? { status: 'consumed', reference } : { status: 'available' };
	}

	const rows = $derived(
		schedule.map((entry, sequence): RepaymentScheduleMatrixRow => {
			const consumedBy = consumptionCell(sequence + 1);
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
		const last = schedule.at(-1)?.due_date ?? new Date().toISOString().slice(0, 10);
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
		emptyMessage="No repayment instalments."
		createRow={(): RepaymentScheduleMatrixRow => ({
			id: crypto.randomUUID(),
			due_date: nextDate(),
			amount: 0.01,
			consumed_by: { status: 'available' },
			consumed_at: null
		})}
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
