<script lang="ts">
	import { leaveEntitlementSchema } from './+definition.js';
	import type { RendererProps } from './$types.js';

	let props: RendererProps = $props();
	const parsed = $derived(leaveEntitlementSchema.safeParse(props.value));
	const summary = $derived(
		parsed.success
			? `${parsed.data.layers.length} statutory / organisation / employee entitlement layer${parsed.data.layers.length === 1 ? '' : 's'}`
			: '—'
	);
</script>

<span class="block truncate" title={summary}>{summary}</span>
