<script lang="ts">
	import type { ComponentProps } from 'svelte';
	import Root from '../src/primitives/dialog/dialog.svelte';
	import Content from '../src/primitives/dialog/dialog-primitive-content.svelte';
	let { options }: {
		options: Omit<ComponentProps<typeof Content>, 'ref' | 'children'>;
	} = $props();
	let open = $state(false);
</script>

<input data-outside aria-label="Outside" />
<button data-open onclick={() => (open = true)}>Open</button>
<Root bind:open>
	<Content {...options} aria-label="Fixture dialog">
		<button data-inside>Inside</button>
	</Content>
</Root>
<output>{open ? 'open' : 'closed'}</output>
