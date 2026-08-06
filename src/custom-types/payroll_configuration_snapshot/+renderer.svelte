<script lang="ts">
	import { useI18n } from '@norbital-ai/ui/i18n';
	import type { TenantI18nKeys } from '$pod/i18n-keys';
	import { payrollConfigurationSnapshotSchema } from './+definition.js';
	import type { RendererProps } from './$types.js';
	const { t } = useI18n<TenantI18nKeys>();

	let props: RendererProps = $props();
	const parsed = $derived(payrollConfigurationSnapshotSchema.safeParse(props.value));
	const current = $derived(parsed.success ? parsed.data : null);
	const summary = $derived(
		current === null
			? '—'
			: current.kind === 'CAPTURED'
				? t('component.captured_at_run_time')
				: t('component.legacy_snapshot')
	);
</script>

<span class="block truncate text-sm" title={summary}>{summary}</span>
