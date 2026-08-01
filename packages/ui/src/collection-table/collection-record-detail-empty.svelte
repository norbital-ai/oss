<script lang="ts">
	import Icon from '@iconify/svelte';
	import { Center, Stack } from '#lib/layout';

	let { icon, title, description }: { icon: string; title: string; description: string } = $props();
</script>

<Stack gap="sm" class="rounded-xl border bg-muted/20 px-5 py-8 text-center sm:px-8">
	<div
		class="mx-auto flex size-10 items-center justify-center rounded-full border bg-background shadow-xs"
	>
		<Icon {icon} class="size-4 text-muted-foreground" aria-hidden="true" />
	</div>
	<p class="text-sm font-medium">{title}</p>
	<Center measure="narrow">
		<p class="text-sm leading-6 text-muted-foreground">{description}</p>
	</Center>
</Stack>
