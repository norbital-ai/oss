<script lang="ts">
	import { useI18n } from '@norbital-ai/ui/i18n';
	import type { TenantI18nKeys } from '$pod/i18n-keys';
	import type { RepresentationProps } from './$types.js';
	import PayslipRepresentation from './payslip-representation.svelte';

	let { record }: RepresentationProps = $props();
	const { t } = useI18n<TenantI18nKeys>();
</script>

<svelte:head>
	<meta
		name="pod:banner"
		content="/api/template-seed-assets/hr-payroll/record-media/payslips-banner.svg"
	/>
</svelte:head>

{#if record}
	<PayslipRepresentation {record} />
{:else}
	<p class="text-sm text-muted-foreground">
		A payslip is written by the payroll engine, never by hand: create a payroll run for the company
		and period, and the run produces one payslip per employment it covers.
	</p>
{/if}
