<script lang="ts">
	/**
	 * What kind of thing a settled line links to — and only that.
	 *
	 * Each arm of the union carries the uuid of the record it links to, and this renderer used to
	 * print it: every payslip breakdown row read `single-use entry · 130b9e77-…`. The uuid is the
	 * link, not the answer. The surrounding table already resolves the linked record to its
	 * `code · name` through the physical projections beside this column, so all this cell owes the
	 * operator is the kind of link.
	 */
	import { payslipLineComponentSchema } from './+definition.js';
	import type { RendererProps } from './$types.js';

	const KIND_LABELS: Record<string, string> = {
		COMPONENT_ENTRY_ONCE: 'Single-use entry',
		COMPONENT_ENTRY_RECURRING: 'Recurring entry',
		STATUTORY_EMPLOYEE: 'Employee statutory',
		STATUTORY_EMPLOYER: 'Employer statutory'
	};

	let props: RendererProps = $props();
	const parsed = $derived(payslipLineComponentSchema.safeParse(props.value));
	const summary = $derived.by(() => {
		if (!parsed.success) return '—';
		const { kind } = parsed.data;
		return KIND_LABELS[kind] ?? kind.replaceAll('_', ' ').toLowerCase();
	});
</script>

<span class="block truncate" title={summary}>{summary}</span>
