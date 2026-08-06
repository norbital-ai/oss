<script lang="ts">
	import { useI18n } from '@norbital-ai/ui/i18n';
	import type { TenantI18nKeys } from '$pod/i18n-keys';
	const { t, has } = useI18n<TenantI18nKeys>();

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

	let props: RendererProps = $props();
	const parsed = $derived(payslipLineComponentSchema.safeParse(props.value));
	const summary = $derived.by(() => {
		if (!parsed.success) return '—';
		const { kind } = parsed.data;
		const key =
			kind === 'COMPONENT_ENTRY_ONCE'
				? 'renderer.payslip_line_component.entry_once'
				: kind === 'COMPONENT_ENTRY_RECURRING'
					? 'renderer.payslip_line_component.entry_recurring'
					: kind === 'STATUTORY_EMPLOYEE'
						? 'renderer.payslip_line_component.statutory_employee'
						: 'renderer.payslip_line_component.statutory_employer';
		return has(key) ? t(key as TenantI18nKeys) : kind.replaceAll('_', ' ').toLowerCase();
	});
</script>

<span class="block truncate" title={summary}>{summary}</span>
