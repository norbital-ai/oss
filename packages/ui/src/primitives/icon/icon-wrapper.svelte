<!--
@component
An icon by Iconify name (`lucide:users`), or a Bolt concept's own icon (`concept:approvals`).
-->
<script lang="ts">
	import Icon from '@iconify/svelte';
	import ConceptIcon from '../../brand/concept-icon.svelte';
	import { concept_of } from '../../brand/concept-icons.js';
	import { resolveIcon } from './entity-icons.js';

	let { name, class: className, ...restProps }: {
		/** An Iconify name (`lucide:users`), a concept (`concept:models`), or an entity name from the icon registry (`money`) resolved to its icon. */
		name: string;
		/** Classes on the svg (size and colour). */
		class?: string;
	} = $props();
	const icon = $derived(resolveIcon(name));
	const concept = $derived(concept_of(icon));
</script>

{#if concept}
	<ConceptIcon name={concept} class={className} />
{:else}
	<Icon {icon} class={className} {...restProps} />
{/if}
