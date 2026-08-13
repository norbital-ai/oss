<!-- fallow-ignore-file unrendered-component -- exported package component rendered by authored workspace applications -->
<script lang="ts">
	import { onMount, type Snippet } from 'svelte';
	import { getAppHeaderActionsSlot } from './app-header-actions.svelte.js';

	let { children }: { children: Snippet } = $props();

	const slot = getAppHeaderActionsSlot();

	/**
	 * Registration is a component lifetime, not reactive synchronization: `children` and the context
	 * slot belong to this mount. Waiting until mount avoids mutating shell state during render; the
	 * teardown clears the slot so navigation cannot strand the previous app's picker in the chrome.
	 */
	onMount(() => {
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
