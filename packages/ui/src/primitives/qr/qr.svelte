<!--
@component
A scannable code. `value` is the payload the provider published; the matrix is drawn from it here, so nothing is fetched
and nothing leaves the browser. Colours are fixed rather than themed: a code is read by a camera, not by a person, and a
low-contrast code in dark mode is one that simply does not scan.
-->
<script lang="ts">
	import { toDataURL } from 'qrcode';

	let { value, size = 240, alt = 'Scannable code', class: className }: {
		value: string;
		/** The rendered pixel size; the code keeps its own quiet zone. */
		size?: number;
		alt?: string;
		class?: string;
	} = $props();

	// a rotated code is a new promise, so the previous one never paints over the current payload
	// ponytail: `toDataURL` returns a promise but works synchronously; a synchronous encoder when one is worth it
	const src = $derived(value === '' ? null : toDataURL(value, { margin: 2, width: size, color: { dark: '#000000', light: '#ffffff' } }));
</script>

{#if src !== null}
	{#await src}
		<span class="inline-block animate-pulse bg-muted" style="width:{size}px;height:{size}px"></span>
	{:then url}
		<img src={url} {alt} width={size} height={size} class={className} />
	{/await}
{/if}
