<script lang="ts">
	import type { RepresentationProps } from './$types.js';
	import PayslipRepresentation from './payslip-representation.svelte';

	let { record }: RepresentationProps = $props();
</script>

{#if record}
	<PayslipRepresentation {record} />
{:else}
	<p class="text-sm text-muted-foreground">
		A payslip is written by the payroll engine, never by hand: create a payroll run for the company
		and period, and the run produces one payslip per employment it covers.
	</p>
{/if}
