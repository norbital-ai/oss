<script lang="ts">
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
		class: className = 'w-28'
	}: {
		value: string;
		options: readonly { id: string; label: string; icon?: string }[];
		searchPlaceholder: string;
		ariaLabel: string;
		onValueChange: (id: string) => void;
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
