<script lang="ts">
	import {
		getCollectionTableNavigationContext,
		type CollectionTableNavigationTarget
	} from '@norbital-ai/ui/collection-table';
	import { useI18n } from '@norbital-ai/ui/i18n';
	import type { TenantI18nKeys } from '$pod/i18n-keys';
	import type { MatrixCellRendererProps } from '@norbital-ai/ui/data-renderer/matrix';
	import { formatPayrollCycleDate, repaymentShortfall } from './repayment-consumption.js';
	import type {
		RepaymentConsumptionCell,
		RepaymentScheduleMatrixRow
	} from './repayment-consumption.js';

	let { value, row }: MatrixCellRendererProps<RepaymentScheduleMatrixRow> = $props();

	const { t } = useI18n<TenantI18nKeys>();

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
					label: t('component.due_in', { period: consumption.period }),
					title: t('component.not_yet_due', { period: consumption.period }),
					alarming: false
				};
			case 'awaiting_run':
				return {
					label: t('component.awaiting_run', { period: consumption.period }),
					title: t('component.awaiting_run_title', { period: consumption.period }),
					alarming: false
				};
			case 'awaiting_rebuild':
				return {
					label: t('component.awaiting_rebuild', { period: consumption.period }),
					title: t('component.awaiting_rebuild_title', { period: consumption.period }),
					alarming: false
				};
			case 'unrecovered':
				return {
					label: t('component.missed_paid', { period: consumption.period }),
					title: t('component.missed_paid_title', { period: consumption.period }),
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
	<span class="text-sm text-muted-foreground" aria-live="polite"
		>{t('component.checking_payroll')}</span
	>
{:else if consumption.status === 'error'}
	<span class="text-sm text-destructive" role="alert" title={consumption.message}>
		{t('component.unable_to_verify')}
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
	{@const label = t('component.payslip_item', {
		sequence: reference.payslipLineSequence,
		date: formatPayrollCycleDate(reference.cycleDate)
	})}
	{@const title =
		shortfall == null
			? label
			: t('component.partial_recovery', {
					label,
					recovered: (reference.recoveredAmount ?? 0).toFixed(2),
					amount: Number(row.amount).toFixed(2),
					shortfall: shortfall.toFixed(2)
				})}
	{#if target && navigation && href}
		<a
			{href}
			class="inline-flex min-h-8 items-center text-sm font-medium text-foreground underline decoration-border underline-offset-4 hover:decoration-foreground focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
			{title}
			onclick={(event) => {
				event.preventDefault();
				navigation.open(target);
			}}
		>
			{label}{#if shortfall != null}<span class="ml-1 font-normal text-destructive"
					>{t('component.short_amount', { amount: shortfall.toFixed(2) })}</span
				>{/if}
		</a>
	{:else}
		<span class="text-sm font-medium" {title}
			>{label}{#if shortfall != null}<span class="ml-1 font-normal text-destructive"
					>{t('component.short_amount', { amount: shortfall.toFixed(2) })}</span
				>{/if}</span
		>
	{/if}
{/if}
