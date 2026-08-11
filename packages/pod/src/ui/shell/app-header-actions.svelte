<!-- fallow-ignore-file unrendered-component -- exported package component rendered by authored workspace applications -->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import { getAppHeaderActionsSlot } from './app-header-actions.svelte.js';

	let { children }: { children: Snippet } = $props();

	const slot = getAppHeaderActionsSlot();

	/**
	 * Registered in an effect, not at init: the shell renders its header and this app in the same
	 * pass, so writing the snippet during init would be a mutation of state the header is already
	 * reading. The teardown clears the slot so navigating to another app cannot leave the previous
	 * app's picker stranded in the chrome.
	 */
	$effect(() => {
		if (!slot) return;
		slot.current = children;
		return () => {
			slot.current = null;
		};
	});
</script>

{#if !slot}
	{@render children()}
{/if}
