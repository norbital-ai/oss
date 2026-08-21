<script lang="ts">
	import { IconWrapper } from '@norbital-ai/ui/icon-wrapper';
	import { Combobox } from '@norbital-ai/ui/combobox';
	import { Inline } from '@norbital-ai/ui/layout';
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
		onValueChange,
		icon
	}: {
		model: ConversationSelectorModel;
		value?: string;
		placeholder: string;
		searchPlaceholder: string;
		ariaLabel: string;
		emptyLabel: string;
		onValueChange: (id: string) => void;
		/** Marks what this picker selects, the way the person and envoy pickers beside it do. */
		icon?: string;
	} = $props();

	const options = $derived.by(() => {
		const rows = model.envoys.flatMap((envoy) => model.rowsByEnvoy[envoy.id] ?? []);
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
					label: row.title?.trim() || 'New conversation',
					icon: row.icon,
					search_term: row.searchText,
					...(type ? { type } : {})
				}
			];
		});
	});
</script>

<Inline align="center" gap="xs" class="w-full min-w-0">
	{#if icon}
		<IconWrapper name={icon} class="size-3.5 shrink-0 text-muted-foreground" />
	{/if}
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
</Inline>
