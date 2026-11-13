<!--
@component
An icon by Iconify name (`lucide:users`).
-->
<script lang="ts">
	import Icon from '@iconify/svelte';
	import { resolveIcon } from './entity-icons.js';

	let { name, ...restProps }: {
		/** An Iconify name (`lucide:users`), or an entity name from the icon registry (`money`) resolved to its icon. */
		name: string;
		/** Classes on the svg (size and colour). */
		class?: string;
	} = $props();
</script>

<Icon icon={resolveIcon(name)} {...restProps} />
