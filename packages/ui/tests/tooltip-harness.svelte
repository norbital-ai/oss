<script lang="ts">
	import * as Dialog from '../src/primitives/dialog/index.js';
	import Tooltip from '../src/primitives/tooltip/tooltip.svelte';

	let {
		dialogOpen = $bindable(false),
		longText = 'Paid annual leave at full pay on a calendar-year window with statutory minimums and company policy accrual across partial years.'
	}: {
		dialogOpen?: boolean;
		longText?: string;
	} = $props();
</script>

<Tooltip text={longText} delay_duration={100}>
	{#snippet trigger({ props })}
		<button type="button" data-testid="tip-a" {...props}>A</button>
	{/snippet}
</Tooltip>

<Tooltip text="Second hint" delay_duration={100}>
	{#snippet trigger({ props })}
		<button type="button" data-testid="tip-b" {...props}>B</button>
	{/snippet}
</Tooltip>

<Dialog.Root bind:open={dialogOpen}>
	<Dialog.Content>
		<Dialog.Title>Modal</Dialog.Title>
		<Tooltip text="Inside modal" delay_duration={0}>
			{#snippet trigger({ props })}
				<button type="button" data-testid="modal-tip" {...props}>Info</button>
			{/snippet}
		</Tooltip>
	</Dialog.Content>
</Dialog.Root>
