<script lang="ts">
	import { IconWrapper } from '@norbital-ai/ui/icon-wrapper';
	import { Combobox } from '@norbital-ai/ui/combobox';
	import { Inline } from '@norbital-ai/ui/layout';
	import { cn } from '@norbital-ai/ui/utils';
	import { AGENT_COMPOSER_CONTROL_TEXT_CLASS } from './composer-chrome.js';

	let {
		value,
		options,
		searchPlaceholder,
		ariaLabel,
		onValueChange,
		icon,
		class: className = 'w-28'
	}: {
		value: string;
		options: readonly { id: string; label: string; icon?: string }[];
		searchPlaceholder: string;
		ariaLabel: string;
		onValueChange: (id: string) => void;
		/** Marks what this picker selects. Two unlabelled triggers side by side say nothing about which
		 * is the person and which is the thread. */
		icon?: string;
		class?: string;
	} = $props();

	const comboboxOptions = $derived(
		options.map((option) => ({
			value: option.id,
			label: option.label,
			icon: option.icon ?? (option.id === value ? 'lucide:user' : 'lucide:user-round'),
			search_term: option.label
		}))
	);
</script>

<Inline align="center" gap="xs" shrink={false} class={className}>
	{#if icon}
		<IconWrapper name={icon} class="size-3.5 shrink-0 text-muted-foreground" />
	{/if}
	<Combobox
		options={comboboxOptions}
		searchable
		{searchPlaceholder}
		{ariaLabel}
		{value}
		onValueChange={(id) => {
			if (typeof id === 'string') onValueChange(id);
		}}
		allowClear={false}
		itemHeight={32}
		maxHeight={280}
		minWidth={220}
		sameWidth={false}
		align="start"
		class="w-full"
		triggerClass={cn(
			'border-0 bg-transparent shadow-none hover:bg-muted',
			AGENT_COMPOSER_CONTROL_TEXT_CLASS
		)}
	/>
</Inline>
