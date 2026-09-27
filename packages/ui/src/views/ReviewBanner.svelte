<!--
@component
The approval state of a held row (or of a request id) with the decisions the viewer may take.
-->
<script lang="ts" module>
	/** A held row, or the request id a `pendingApproval` outcome carries. */
	export type ReviewBannerProps = { target: { collection: string; id: string } | string };
</script>

<script lang="ts">
	// "Pending review" with the approval view behind it (final-ui rule 29): shown only while the row is held.
	import type { Row } from './bolt.js';
	import { useBolt } from './bolt.js';
	import ApprovalPanel from './ApprovalPanel.svelte';
	import { watch } from './live.svelte.js';
	import { msg } from './model.js';

	let { target }: ReviewBannerProps = $props();
	const bolt = useBolt();
	const row = watch(() => typeof target === 'string' ? null : bolt.live(bolt.get<Row | null>(target.collection, target.id)));
	const requestId = $derived(typeof target === 'string' ? target
		: row.state.kind === 'ready' && typeof row.state.value?.['approval_id'] === 'string' ? row.state.value['approval_id'] : null);
</script>

{#if requestId !== null}
	<details class="border-warning bg-warning/10 rounded-md border p-3" data-view="review-banner">
		<summary class="cursor-pointer text-sm font-medium">{msg(bolt, 'record.pending', 'Pending review')}</summary>
		<div class="mt-2">
			<ApprovalPanel {requestId} {...typeof target === 'string' ? {} : { collection: target.collection, id: target.id }}
				{...row.state.kind === 'ready' && typeof row.state.value?.['revision'] === 'number' ? { revision: row.state.value['revision'] } : {}} />
		</div>
	</details>
{/if}
