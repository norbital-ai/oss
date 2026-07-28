<script lang="ts">
	import Icon from '@iconify/svelte';
	import { ProductIcon, productIconNameFromReference } from '#lib/product-icon';
	import { resolveIcon } from './entity-icons';

	let {
		name,
		class: className,
		...restProps
	}: {
		name: string;
		class?: string;
	} = $props();

	const resolved = $derived(resolveIcon(name));
	const productIconName = $derived(productIconNameFromReference(resolved));
</script>

{#if productIconName}
	<ProductIcon name={productIconName} class={className} {...restProps} />
{:else}
	<Icon icon={resolved} class={className} {...restProps} />
{/if}
