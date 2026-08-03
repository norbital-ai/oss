<script lang="ts">
	import { payslipLineComponentSchema } from './+definition.js';
	import type { RendererProps } from './$types.js';

	let props: RendererProps = $props();
	const parsed = $derived(payslipLineComponentSchema.safeParse(props.value));
	const summary = $derived.by(() => {
		if (!parsed.success) return '—';
		const value = parsed.data;
		switch (value.kind) {
			case 'COMPONENT_ENTRY_ONCE':
			case 'COMPONENT_ENTRY_RECURRING':
				return `${value.kind === 'COMPONENT_ENTRY_RECURRING' ? 'Recurring' : 'Single-use'} entry · ${value.component_entry_id}`;
			case 'STATUTORY_EMPLOYEE':
			case 'STATUTORY_EMPLOYER':
				return `${value.kind === 'STATUTORY_EMPLOYEE' ? 'Employee' : 'Employer'} statutory · ${value.statutory_contribution_id}`;
			default:
				return `${value.kind.replaceAll('_', ' ').toLowerCase()} · ${value.pay_component_id}`;
		}
	});
</script>

<span class="block truncate" title={summary}>{summary}</span>
