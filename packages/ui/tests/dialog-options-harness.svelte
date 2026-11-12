<script lang="ts">
	import { Dialog } from 'bits-ui';
	import type { ComponentProps } from 'svelte';
	import Content from '../src/primitives/dialog/dialog-primitive-content.svelte';
	let { options }: {
		options: Omit<ComponentProps<typeof Content>, 'ref' | 'child' | 'children'>;
	} = $props();
	let open = $state(false);
</script>

<input data-outside aria-label="Outside" />
<button data-open onclick={() => (open = true)}>Open</button>
<Dialog.Root bind:open>
	<Content {...options} aria-label="Fixture dialog">
		<button data-inside>Inside</button>
	</Content>
</Dialog.Root>
<output>{open ? 'open' : 'closed'}</output>
