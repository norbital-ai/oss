<script lang="ts">
	import { payrollConfigurationSnapshotSchema } from './+definition.js';
	import type { RendererProps } from './$types.js';

	let props: RendererProps = $props();
	const parsed = $derived(payrollConfigurationSnapshotSchema.safeParse(props.value));
	const current = $derived(parsed.success ? parsed.data : null);
	const summary = $derived(
		current === null
			? '—'
			: current.kind === 'CAPTURED'
				? `Captured · ${current.configuration_hash.slice(0, 12)}`
				: `Legacy hash only · ${current.configuration_hash.slice(0, 12)}`
	);
</script>

<span class="block truncate font-mono text-xs" title={summary}>{summary}</span>
