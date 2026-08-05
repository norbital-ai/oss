<script lang="ts">
	import {
		getCollectionTableNavigationContext,
		type CollectionTableNavigationTarget
	} from '@norbital-ai/ui/collection-table';
	import type { MatrixCellRendererProps } from '@norbital-ai/ui/data-renderer/matrix';
	import { formatPayrollCycleDate, repaymentShortfall } from './repayment-consumption.js';
	import type {
		RepaymentConsumptionCell,
		RepaymentScheduleMatrixRow
	} from './repayment-consumption.js';

	let { value, row }: MatrixCellRendererProps<RepaymentScheduleMatrixRow> = $props();
	const navigation = getCollectionTableNavigationContext();
	const consumption = $derived(value as RepaymentConsumptionCell);
	const target = $derived.by((): CollectionTableNavigationTarget | null => {
		if (consumption.status !== 'consumed') return null;
		return {
			collectionName: 'payslip_lines',
			recordId: consumption.reference.payslipLineId,
			routeKey: `repayment-consumption:${consumption.reference.payslipLineId}`,
			parentRouteKey: navigation?.current?.routeKey
		};
	});
	const href = $derived(target && navigation ? navigation.href(target) : undefined);

	/**
	 * Every non-consumed state says which payroll run it is waiting on, or which one closed without
	 * it. A row that reads only "Not consumed" cannot be acted on and cannot be dismissed.
	 */
	const pending = $derived.by((): { label: string; title: string; alarming: boolean } | null => {
		switch (consumption.status) {
			case 'not_due':
				return {
					label: `Due in ${consumption.period}`,
					title: `Not yet due. The ${consumption.period} payroll run deducts this instalment.`,
					alarming: false
				};
			case 'awaiting_run':
				return {
					label: `Awaiting ${consumption.period} payroll`,
					title:
						`No payroll run exists for ${consumption.period} yet. This instalment is deducted ` +
						'when that run is built.',
					alarming: false
				};
			case 'awaiting_rebuild':
				return {
					label: `Draft ${consumption.period} payroll`,
					title:
						`The ${consumption.period} payroll run is still a draft, so nothing has been ` +
						'deducted yet. Recalculating that run takes this instalment.',
					alarming: false
				};
			case 'unrecovered':
				return {
					label: `Missed · ${consumption.period} paid`,
					title:
						`The ${consumption.period} payroll run was paid without this instalment, so the ` +
						'money was never recovered. A paid run is never rebuilt — reschedule the ' +
						'outstanding amount into a period that is still open.',
					alarming: true
				};
			default:
				return null;
		}
	});

	const shortfall = $derived(
		consumption.status === 'consumed'
			? repaymentShortfall(Number(row.amount), consumption.reference)
			: null
	);
</script>

{#if consumption.status === 'loading'}
	<span class="text-sm text-muted-foreground" aria-live="polite">Checking payroll…</span>
{:else if consumption.status === 'error'}
	<span class="text-sm text-destructive" role="alert" title={consumption.message}>
		Unable to verify payroll
	</span>
{:else if pending}
	<span
		class={pending.alarming
			? 'text-sm font-medium text-destructive'
			: 'text-sm text-muted-foreground'}
		role={pending.alarming ? 'alert' : undefined}
		title={pending.title}
	>
		{pending.label}
	</span>
{:else if consumption.status === 'consumed'}
	{@const reference = consumption.reference}
	{@const label = `Payslip item ${reference.payslipLineSequence} · ${formatPayrollCycleDate(reference.cycleDate)}`}
	{@const title =
		shortfall == null
			? label
			: `${label} — payroll could only take ${(reference.recoveredAmount ?? 0).toFixed(2)} of ${Number(row.amount).toFixed(2)}; the remaining ${shortfall.toFixed(2)} was carried forward as arrears.`}
	{#if target && navigation && href}
		<a
			{href}
			class="inline-flex min-h-8 items-center text-sm font-medium text-foreground underline decoration-border underline-offset-4 hover:decoration-foreground focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
			{title}
			onclick={(event) => {
				event.preventDefault();
				navigation.open(target);
			}}
		>
			{label}{#if shortfall != null}<span class="ml-1 font-normal text-destructive"
					>· short {shortfall.toFixed(2)}</span
				>{/if}
		</a>
	{:else}
		<span class="text-sm font-medium" {title}
			>{label}{#if shortfall != null}<span class="ml-1 font-normal text-destructive"
					>· short {shortfall.toFixed(2)}</span
				>{/if}</span
		>
	{/if}
{/if}
