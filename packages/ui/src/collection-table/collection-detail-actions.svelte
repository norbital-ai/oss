<script lang="ts">
	import Icon from '@iconify/svelte';
	import { Button } from '#lib/button';

	let {
		fullScreen,
		onToggleFullScreen,
		onClose
	}: {
		fullScreen: boolean;
		onToggleFullScreen: () => void;
		onClose: () => void;
	} = $props();
</script>

<div class="flex shrink-0 items-center justify-end gap-1">
	<Button
		type="button"
		variant="ghost"
		size="icon"
		class="size-8"
		aria-label={fullScreen ? 'Exit full screen' : 'Open full screen'}
		onclick={onToggleFullScreen}
	>
		<Icon icon={fullScreen ? 'lucide:minimize' : 'lucide:maximize'} class="size-4" />
	</Button>
	<Button
		type="button"
		variant="ghost"
		size="icon"
		class="size-8"
		aria-label="Close record detail"
		onclick={onClose}
	>
		<Icon icon="lucide:x" class="size-4" />
	</Button>
</div>
