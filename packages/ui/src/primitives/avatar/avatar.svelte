<script lang="ts">
	// An internal primitive (final-ui §7.4, id 708): a round picture of a person, or their initials on a hue derived
	// from `name` while the picture is absent or fails to load.
	import { cn } from '../utils.js';

	let { name, src, class: className }: { name: string; src?: string | null; class?: string } = $props();
	let failed = $state(false);
	const initials = $derived(name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? '').join(''));
	const hue = $derived([...name].reduce((h, c) => (c.charCodeAt(0) + ((h << 5) - h)) | 0, 0));
</script>

<span class={cn('relative inline-grid size-10 shrink-0 place-items-center overflow-hidden rounded-full text-sm font-medium text-white', className)}
	style={src && !failed ? undefined : `background-color: hsl(${Math.abs(hue) % 360} 65% 45%)`} data-avatar>
	{#if src && !failed}
		<img {src} alt={name} class="size-full object-cover" onerror={() => (failed = true)} />
	{:else}
		<span aria-label={name} role="img">{initials}</span>
	{/if}
</span>
