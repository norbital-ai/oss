<script lang="ts">
	import Icon from '@iconify/svelte';
	import { Button } from '#lib/button';
	import { Tooltip } from '#lib/tooltip';
	import { cn } from '#lib/utils';
	import type { CollectionToolbarActionProps } from '#lib/collection-toolbar/collection-toolbar.types';
	import { Effect } from 'effect';

	let {
		label,
		icon,
		iconOnly = false,
		variant = 'ghost',
		pending = false,
		unavailable,
		onRun
	}: CollectionToolbarActionProps = $props();

	const reasonId = $props.id();
	const blocked = $derived(unavailable != null && unavailable.length > 0);

	function run(): void {
		if (blocked || pending) return;
		const action = onRun();
		if (action) Effect.runFork(action);
	}
</script>

<!--
	A refused action stays reachable.

	`disabled` takes the control out of the tab order and stops it firing pointer events, which takes
	the reason down with it: no hover, no focus, no tooltip, and a screen reader that announces
	"dimmed button" and nothing else. `aria-disabled` leaves the button where the operator left it and
	lets the refusal be read; `run` still refuses to do anything.
-->
<Tooltip text={unavailable} delayDuration={0}>
	{#snippet trigger({ props })}
		<Button
			{...props}
			type="button"
			{variant}
			size={iconOnly ? 'icon' : 'sm'}
			class={cn(!iconOnly && 'h-8', (blocked || pending) && 'cursor-not-allowed opacity-50')}
			aria-label={iconOnly ? label : undefined}
			aria-disabled={blocked || pending ? 'true' : undefined}
			aria-describedby={blocked ? reasonId : undefined}
			onclick={run}
		>
			{#if icon}
				<Icon
					icon={pending ? 'lucide:loader-circle' : icon}
					class={pending ? 'size-4 animate-spin' : 'size-4'}
				/>
			{/if}
			{#if !iconOnly}{label}{/if}
		</Button>
	{/snippet}
</Tooltip>
{#if blocked}
	<span id={reasonId} class="sr-only">{unavailable}</span>
{/if}
