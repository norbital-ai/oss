<script lang="ts">
	import { mode } from 'mode-watcher';
	import { onMount } from 'svelte';
	import { Toaster as Sonner, type ToasterProps as SonnerProps } from 'svelte-sonner';

	let { ...restProps }: SonnerProps = $props();
	let mounted = $state(false);

	// stupidity:allow V11 -- svelte-sonner portals require a browser DOM and cannot render during SSR
	onMount(() => {
		mounted = true;
	});
</script>

{#if mounted}
	<Sonner
		theme={mode.current}
		class="toaster group"
		toastOptions={{
			classes: {
				toast:
					'group toast group-[.toaster]:bg-popover group-[.toaster]:text-foreground group-[.toaster]:border-border group-[.toaster]:shadow-lg',
				description: 'group-[.toast]:text-muted-foreground',
				actionButton: 'group-[.toast]:bg-primary group-[.toast]:text-primary-foreground',
				cancelButton: 'group-[.toast]:bg-muted group-[.toast]:text-muted-foreground'
			}
		}}
		closeButton
		richColors
		{...restProps}
	/>
{/if}
