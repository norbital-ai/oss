<!--
@component
An icon by Iconify name (`lucide:users`).
-->
<script lang="ts">
	import Icon from '@iconify/svelte';
	import { resolveIcon } from './entity-icons.js';

	let { name, ...restProps }: { name: string; class?: string } = $props();
</script>

<Icon icon={resolveIcon(name)} {...restProps} />
