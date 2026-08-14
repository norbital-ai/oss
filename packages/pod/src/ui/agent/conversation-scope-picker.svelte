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
		onValueChange
	}: {
		value: string;
		options: readonly { id: string; label: string }[];
		searchPlaceholder: string;
		ariaLabel: string;
		onValueChange: (id: string) => void;
	} = $props();

	const comboboxOptions = $derived(
		options.map((option) => ({
			value: option.id,
			label: option.label,
			icon: option.id === value ? 'lucide:user' : 'lucide:user-round',
			search_term: option.label
		}))
	);

	/** Forwards a combobox pick only when Combobox yields a concrete id. */
	function handleValueChange(id: string | null): void { // stupidity:allow Q3 -- template handler; stupidity:allow Q4 -- template handler
		if (typeof id !== 'string') return;
		onValueChange(id);
	}
</script>

<Inline align="center" gap="xs" class="min-w-0">
	<Combobox
		options={comboboxOptions}
		searchable
		{searchPlaceholder}
		{ariaLabel}
		{value}
		onValueChange={handleValueChange}
		allowClear={false}
		itemHeight={32}
		maxHeight={280}
		minWidth={220}
		sameWidth={false}
		class="w-auto max-w-36 shrink-0"
		triggerClass={cn(
			'border-0 bg-transparent shadow-none hover:bg-muted',
			AGENT_COMPOSER_CONTROL_TEXT_CLASS
		)}
	/>
</Inline>
