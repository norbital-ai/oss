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
				? 'Captured at run time'
				: 'Legacy snapshot'
	);
</script>

<span class="block truncate text-sm" title={summary}>{summary}</span>
