<script lang="ts">
	import AppHeaderActions from '../../src/ui/shell/app-header-actions.svelte';
	import {
		setAppHeaderActionsSlot,
		type AppHeaderActionsSlot
	} from '../../src/ui/shell/app-header-actions.svelte.js';

	const slot: AppHeaderActionsSlot = $state({ current: null });
	setAppHeaderActionsSlot(slot);
	let mounted = $state(true);
</script>

<button aria-label="Toggle actions" onclick={() => (mounted = !mounted)}>Toggle</button>

{#if mounted}
	<AppHeaderActions>
		<button aria-label="Scoped action">Scope</button>
	</AppHeaderActions>
{/if}

{#if slot.current}
	{@render slot.current()}
{/if}
