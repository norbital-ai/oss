<script lang="ts">
	import Icon from '@iconify/svelte';
	import { ProductIcon, productIconNameFromReference } from '#lib/product-icon';
	import { resolveIcon } from '#lib/icon-wrapper/entity-icons';

	let {
		name,
		...restProps
	}: {
		name: string;
		class?: string;
	} = $props();

	const resolved = $derived(resolveIcon(name));
	const productIconName = $derived(productIconNameFromReference(resolved));
</script>

{#if productIconName}
	<ProductIcon name={productIconName} {...restProps} />
{:else}
	<Icon icon={resolved} {...restProps} />
{/if}
