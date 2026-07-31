<script lang="ts">
	import Icon from '@iconify/svelte';
	import { Button } from '#lib/button';
	import { Inline } from '#lib/layout';

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

<Inline justify="end" gap="xs" class="shrink-0">
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
</Inline>
