<script lang="ts">
	import {
		getCollectionTableNavigationContext,
		type CollectionTableNavigationTarget
	} from '@norbital-ai/ui/collection-table';
	import type { MatrixCellRendererProps } from '@norbital-ai/ui/data-renderer/matrix';
	import { formatPayrollCycleDate } from './repayment-consumption.js';
	import type {
		RepaymentConsumptionCell,
		RepaymentScheduleMatrixRow
	} from './repayment-consumption.js';

	let { value }: MatrixCellRendererProps<RepaymentScheduleMatrixRow> = $props();
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
</script>

{#if consumption.status === 'loading'}
	<span class="text-sm text-muted-foreground" aria-live="polite">Checking payroll…</span>
{:else if consumption.status === 'error'}
	<span class="text-sm text-destructive" role="alert" title={consumption.message}>
		Unable to verify payroll
	</span>
{:else if consumption.status === 'available'}
	<span class="text-sm text-muted-foreground">Not consumed</span>
{:else}
	{@const reference = consumption.reference}
	{@const label = `Payslip item ${reference.payslipLineSequence} · ${formatPayrollCycleDate(reference.cycleDate)}`}
	{#if target && navigation && href}
		<a
			{href}
			class="inline-flex min-h-8 items-center text-sm font-medium text-foreground underline decoration-border underline-offset-4 hover:decoration-foreground focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
			title={label}
			onclick={(event) => {
				event.preventDefault();
				navigation.open(target);
			}}
		>
			{label}
		</a>
	{:else}
		<span class="text-sm font-medium" title={label}>{label}</span>
	{/if}
{/if}
