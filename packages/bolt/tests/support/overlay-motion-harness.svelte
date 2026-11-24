<script lang="ts">
	import * as Dialog from '../../../ui/src/primitives/dialog/index.js';
	import * as Popover from '../../../ui/src/primitives/popover/index.js';
	import Tooltip from '../../../ui/src/primitives/tooltip/tooltip.svelte';

	let {
		longText = 'Paid annual leave at full pay on a calendar-year window: statutory Employment Act s.88A minimum (7 to 14 days by completed service after 3 months), and company policy 14-18D (14 days in the joining calendar year rising by 1 day per calendar year to 18, prorated by calendar days served in partial years; floored at EA s.88A); unused days paid out at the gross daily rate except on dismissal for misconduct.'
	}: {
		longText?: string;
	} = $props();

	let popoverOpen = $state(false);
	let dialogOpen = $state(false);
</script>

<div style="position:relative;min-height:1600px;width:100%;padding:24px" data-testid="page-body">
	<div style="position:fixed;top:320px;right:24px">
		<Tooltip text={longText} delay_duration={0}>
			{#snippet trigger({ props })}
				<button type="button" data-testid="edge-tooltip-trigger" style="width:24px;height:24px" {...props}>
					i
				</button>
			{/snippet}
		</Tooltip>
	</div>

	<div style="position:fixed;top:12px;right:24px">
		<Tooltip text={longText} delay_duration={0}>
			{#snippet trigger({ props })}
				<button type="button" data-testid="flip-tooltip-trigger" style="width:24px;height:24px" {...props}>
					f
				</button>
			{/snippet}
		</Tooltip>
	</div>

	<div style="position:fixed;top:320px;left:96px">
		<Popover.Root bind:open={popoverOpen}>
			<Popover.Trigger data-testid="popover-trigger" style="height:32px;width:48px">Menu</Popover.Trigger>
			<Popover.Content align="start" side="bottom" style="width:256px">
				<div data-testid="popover-body">Popover content</div>
			</Popover.Content>
		</Popover.Root>
	</div>

	<button type="button" data-testid="open-dialog" onclick={() => (dialogOpen = true)}>
		Open dialog
	</button>

	<Dialog.Root bind:open={dialogOpen}>
		<Dialog.Content>
			<Dialog.Title>Dialog title</Dialog.Title>
			<Tooltip text="Tooltip inside dialog" delay_duration={0}>
				{#snippet trigger({ props })}
					<button type="button" data-testid="dialog-tip-trigger" {...props}>Help</button>
				{/snippet}
			</Tooltip>
		</Dialog.Content>
	</Dialog.Root>
</div>
