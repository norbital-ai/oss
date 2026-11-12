<script lang="ts">
	import * as Popover from '../popover/index.js';
	import Icon from '../icon/icon-wrapper.svelte';
	import { cn } from '../utils.js';
	import { TAB_ICON } from './style.js';

	let { active, label, class: className }: {
		active: boolean;
		label: string;
		class: string;
	} = $props();
</script>

<Popover.Trigger>
	{#snippet child({ props })}
		<!-- `data-state` follows the popover's state: More is active when it holds the selected tab. -->
		<button
			{...props}
			type="button"
			class={cn(className, 'ml-auto')}
			data-tabs-more
			data-state={active ? 'active' : 'inactive'}
		>
			<Icon name="lucide:ellipsis" class={TAB_ICON} /><span>{label}</span>
		</button>
	{/snippet}
</Popover.Trigger>
