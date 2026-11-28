<script lang="ts">
	import type { UiContext } from '../client/contract.js';
	import { words_of } from '../client/context.js';
	import Glyph from '../primitives/icon/Glyph.svelte';
	import { msg } from '../text/messages.js';

	let { ctx, grid = false }: { ctx: UiContext; grid?: boolean } = $props();
	const words = $derived(words_of(ctx));
</script>

<!-- an empty lane remains a drop target and matches across model-backed and local boards -->
<div
	class={[
		'flex min-h-28 flex-col items-center justify-center gap-1 rounded-sm border border-transparent p-4 text-center dark:border-border dark:border-dashed dark:bg-background/50',
		grid && 'col-span-full'
	]}
	data-lane-empty
>
	<Glyph name="inbox" class="text-muted-foreground mb-1 size-5 dark:mb-0" />
	<p class="text-sm text-muted-foreground dark:font-medium dark:text-foreground">
		{msg(words, 'board.laneEmpty')}
	</p>
	<p class="text-meta hidden dark:block">{msg(words, 'board.laneClear')}</p>
</div>
