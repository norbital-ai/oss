<!--
@component
The latest runs of one automation matching `where`, newest first, each with its `RunStatus`.
-->
<script lang="ts" module>
	import type { Json } from './bolt.js';
	/** The latest runs of one automation that match `where` (e.g. those started for a record), newest first; `title`
	 * names the automation (else its catalog label `automations.<key>.label`, else its name in words). */
	export type RunsForProps = { automation: string; title?: string; where?: Json; limit?: number };
	/** Set by a record's Runs tab: each `RunsFor` reports its row count, and the tab alone says when there are none. */
	export const RUNS_GROUP = Symbol('ui.views.runsGroup');
</script>

<script lang="ts">
	import { getContext } from 'svelte';
	import { watch as onChange } from 'runed';
	import { useBolt } from './bolt.js';
	import { watch } from './live.svelte.js';
	import { msg } from './model.js';
	import ReadGate from './ReadGate.svelte';
	import RunStatus from './RunStatus.svelte';

	let { automation, title, where, limit = 5 }: RunsForProps = $props();
	const bolt = useBolt();
	const runs = bolt.runs;
	const live = watch(() => runs === undefined ? null : runs(automation, { ...(where === undefined ? {} : { where }), limit }));
	const group = getContext<((automation: string, rows: number) => void) | undefined>(RUNS_GROUP);
	onChange(() => live.state, (s) => { if (s.kind === 'ready') group?.(automation, s.value.rows.length); });
</script>

{#if runs !== undefined}
	<ReadGate state={live.state} what={automation}>
		{#snippet children(page)}
			<div class="flex flex-col gap-2" data-view="runs">
				{#each page.rows as r (r.id)}<RunStatus {automation} {title} run={r} />{:else}
					{#if group === undefined}<p class="text-muted-foreground text-sm" data-read="empty">{msg(bolt, 'run.none', 'No runs yet')}</p>{/if}{/each}
			</div>
		{/snippet}
	</ReadGate>
{/if}
