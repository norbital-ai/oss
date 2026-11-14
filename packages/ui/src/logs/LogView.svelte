<!--
@component
A dense log: one fixed-height line per event (a JSON payload previewed, highlighted and truncated), oldest first,
following the tail and loading older pages on request, under CustomView's toolbar (search, filter and sort over its
level, message and source). It fills its parent.
-->
<script lang="ts" module>
	import { Effect } from 'effect';
	import type { Snippet } from 'svelte';
	import type { UiContext } from '../client/contract.js';
	import type { LogLine } from './logs.js';

	/** The props of `LogView`. */
	export type LogViewProps = {
		/** The page context (`ctx`), passed whole. */
		ctx: UiContext;
		/** Oldest first; new events append. */
		rows: readonly LogLine[];
		/** Loads the next older page (the caller holds the cursor) and prepends it to `rows`. */
		load_older?: () => Effect.Effect<unknown, Error>;
		has_older?: boolean;
		/** Keep the newest line in view; scrolling up pauses it. */
		follow?: boolean;
		/** The toolbar's view-local controls, before search (a title, a scope picker, a run picker). */
		controls?: Snippet;
		/** Before Follow (an Auto-refresh toggle). */
		trailing?: Snippet | undefined;
	};
</script>

<script lang="ts">
	import CustomView from '../model/CustomView.svelte';
	import { cn } from '../primitives/utils.js';
	import LogLines from './LogLines.svelte';

	let {
		ctx,
		rows,
		load_older,
		has_older = false,
		follow = $bindable(true),
		controls,
		trailing
	}: LogViewProps = $props();
</script>

{#snippet tail()}
	{@render trailing?.()}
	<button
		type="button"
		aria-pressed={follow}
		onclick={() => (follow = !follow)}
		class={cn('h-8 max-sm:min-h-11 rounded border px-2 text-xs', follow && 'bg-foreground text-background')}
		>{follow ? 'Following' : 'Follow'}</button
	>
{/snippet}

<CustomView
	{ctx}
	of={rows}
	fields={['level', 'message', 'source']}
	key="logs"
	toolbar={{ title: false, description: false, controls, trailing: tail }}
	empty={false}
>
	{#snippet children(shown)}<LogLines {ctx} rows={shown} {load_older} {has_older} bind:follow />{/snippet}
</CustomView>
