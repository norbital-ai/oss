<!--
@component
The latest runs of one automation matching `where`, newest first, each with its `RunStatus`.
-->
<script lang="ts" module>
	import type { Json } from './bolt.js';
	/** The latest runs of one automation that match `where` (e.g. those started for a record), newest first. */
	export type RunsForProps = { automation: string; where?: Json; limit?: number };
</script>

<script lang="ts">
	import { useBolt } from './bolt.js';
	import { watch } from './live.svelte.js';
	import { msg } from './model.js';
	import ReadGate from './ReadGate.svelte';
	import RunStatus from './RunStatus.svelte';

	let { automation, where, limit = 5 }: RunsForProps = $props();
	const bolt = useBolt();
	const runs = bolt.runs;
	const live = watch(() => runs === undefined ? null : runs(automation, { ...(where === undefined ? {} : { where }), limit }));
</script>

{#if runs !== undefined}
	<ReadGate state={live.state} what={automation}>
		{#snippet children(page)}
			<div class="flex flex-col gap-2" data-view="runs">
				{#each page.rows as r (r.id)}<RunStatus {automation} run={r} />{:else}
					<p class="text-muted-foreground text-sm" data-read="empty">{msg(bolt, 'run.none', 'No runs yet')}</p>{/each}
			</div>
		{/snippet}
	</ReadGate>
{/if}
