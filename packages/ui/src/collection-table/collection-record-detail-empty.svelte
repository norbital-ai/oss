<script lang="ts">
	import Icon from '@iconify/svelte';

	let { icon, title, description }: { icon: string; title: string; description: string } = $props();
</script>

<div class="rounded-xl border bg-muted/20 px-5 py-8 text-center sm:px-8">
	<div
		class="mx-auto flex size-10 items-center justify-center rounded-full border bg-background shadow-xs"
	>
		<Icon {icon} class="size-4 text-muted-foreground" aria-hidden="true" />
	</div>
	<p class="mt-3 text-sm font-medium">{title}</p>
	<p class="mx-auto mt-1 max-w-md text-sm leading-6 text-muted-foreground">{description}</p>
</div>
