<!--
@component
The approval proposals for a record (or for a request id) with the decisions the viewer may take.
-->
<script lang="ts" module>
	/** A stored record, or the request id a `pendingApproval` outcome carries. */
	export type ReviewBannerProps = { target: { collection: string; id: string } | string };
</script>

<script lang="ts">
	import { Effect } from 'effect';
	import { fork, query } from '../effect/index.js';
	// Read-filtered native proposals are separate from domain records.
	import { useBolt } from '../client/context.js';
	import ApprovalPanel from './ApprovalPanel.svelte';
	import { msg } from '../text/messages.js';

	let { target }: ReviewBannerProps = $props();
	const bolt = useBolt();
	const requests = query(() =>
		typeof target === 'string'
			? Effect.succeed([])
			: (bolt.approvals.list?.({ collection: target.collection, records: [target.id] }) ??
				Effect.succeed([]))
	);
	const requestId = $derived(
		typeof target === 'string' ? target : (requests.current?.[0]?.id ?? null)
	);
</script>

{#if requests.error}<p role="alert" class="text-destructive text-sm">
		{msg(bolt, 'approval.loadFailed', 'Approval requests could not be loaded.')}
	</p>{/if}
{#if requestId !== null}
	<details class="border-warning bg-warning/10 rounded-md border p-3" data-view="review-banner">
		<summary class="cursor-pointer text-sm font-medium"
			>{msg(bolt, 'record.pending', 'Pending review')}</summary
		>
		<div class="mt-2">
			<ApprovalPanel
				{requestId}
				onOutcome={() => {
					fork(requests.refetch());
				}}
			/>
		</div>
	</details>
{/if}
