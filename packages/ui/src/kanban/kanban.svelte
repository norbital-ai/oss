<script lang="ts">
	import { fly } from 'svelte/transition';
	import { Inline, Scroll } from '#lib/layout';
	import { useI18n, type UiKeys } from '#lib/i18n';
	import type { KanbanProps } from './types.js';
	import KanbanColumn from './kanban-column.svelte';

	let {
		value,
		minColumnWidth = 320,
		groupName = 'kanban-shared',
		sortable = true,
		sortWithinColumn = true,
		...columnProps
	}: KanbanProps = $props();

	const { t } = useI18n<UiKeys>();
</script>

<Scroll axis="x" name={t('kanban.boardRegion')} class="p-3">
	<Inline gap="md" align="stretch" fill>
		{#each value as column, index (column._id)}
			<div class="h-full" in:fly={{ x: -20, duration: 400, delay: index * 100 }}>
				<KanbanColumn
					{column}
					{minColumnWidth}
					{groupName}
					{sortable}
					{sortWithinColumn}
					{...columnProps}
				/>
			</div>
		{/each}
	</Inline>
</Scroll>
