<script lang="ts">
	import { IconWrapper } from '@norbital-ai/ui/icon-wrapper';
	import { Combobox } from '@norbital-ai/ui/combobox';
	import { Inline } from '@norbital-ai/ui/layout';
	import { cn } from '@norbital-ai/ui/utils';
	import { AGENT_COMPOSER_CONTROL_TEXT_CLASS } from './composer-chrome.js';
	import type { TaskSelectorModel } from './conversation-selector.js';

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
		model: TaskSelectorModel;
		value?: string | undefined;
		placeholder: string;
		searchPlaceholder: string;
		ariaLabel: string;
		emptyLabel: string;
		onValueChange: (id: string) => void;
		icon?: string;
	} = $props();

	const options = $derived.by(() => {
		const rows = model.agents.flatMap((agent) => model.rowsByAgent[agent.id] ?? []);
		const groupLabel = new Map<string, string>();
		for (const row of rows) {
			if (row.kind === 'heading') groupLabel.set(row.id.split(':').at(-1) ?? '', row.label);
		}
		return rows.flatMap((row) => {
			if (row.kind !== 'task') return [];
			const type = groupLabel.get(row.audience);
			return [
				{
					value: row.id,
					label: row.title,
					icon: row.icon,
					search_term: row.searchText,
					...(type === undefined ? {} : { type })
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
