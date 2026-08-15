<script lang="ts">
	import { Combobox } from '@norbital-ai/ui/combobox';
	import { cn } from '@norbital-ai/ui/utils';
	import { AGENT_COMPOSER_CONTROL_TEXT_CLASS } from './composer-chrome.js';
	import type { ConversationSelectorModel } from './conversation-selector.js';

	let {
		model,
		value,
		placeholder,
		searchPlaceholder,
		ariaLabel,
		emptyLabel,
		onValueChange
	}: {
		model: ConversationSelectorModel;
		value?: string;
		placeholder: string;
		searchPlaceholder: string;
		ariaLabel: string;
		emptyLabel: string;
		onValueChange: (id: string) => void;
	} = $props();

	const options = $derived.by(() => {
		const rows = model.channels.flatMap((channel) => model.rowsByChannel[channel.id] ?? []);
		const groupLabel = new Map<string, string>();
		for (const row of rows) {
			if (row.kind !== 'heading') continue;
			if (row.id.endsWith(':users')) groupLabel.set('user', row.label);
			else if (row.id.endsWith(':groups')) groupLabel.set('group', row.label);
		}
		return rows.flatMap((row) => {
			if (row.kind !== 'conversation') return [];
			const type = groupLabel.get(row.audience);
			return [
				{
					value: row.id,
					label: row.title,
					icon: row.icon,
					search_term: row.searchText,
					...(type ? { type } : {})
				}
			];
		});
	});
</script>

<Combobox
	{options}
	searchable
	{searchPlaceholder}
	{ariaLabel}
	value={value ?? null}
	onValueChange={(id) => {
		if (typeof id === 'string') onValueChange(id);
	}}
	allowClear={false}
	emptyPlaceholder={value ? emptyLabel : placeholder}
	itemHeight={32}
	maxHeight={280}
	sameWidth={true}
	preserveOptionOrder={true}
	align="start"
	class="w-full min-w-0"
	triggerClass={cn(
		'border-0 bg-transparent shadow-none hover:bg-muted',
		AGENT_COMPOSER_CONTROL_TEXT_CLASS
	)}
/>
