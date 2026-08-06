<script lang="ts">
	import Icon from '@iconify/svelte';
	import { useI18n, type UiKeys } from '../../../i18n/index.js';
	import type { ParseError } from 'papaparse';

	const { t } = useI18n<UiKeys>();

	let {
		headers,
		data,
		totalRows,
		errors
	}: {
		headers: string[];
		data: Record<string, unknown>[];
		totalRows: number;
		errors: ParseError[];
	} = $props();

	let visibleRows = $derived(data.slice(0, 50));
</script>

<div class="table-preview-container w-full rounded bg-background shadow">
	{#if errors.length > 0}
		<div class="border-b bg-yellow-50 px-3 py-2 text-sm text-yellow-800">
			<Icon icon="lucide:alert-triangle" width="14" height="14" class="mr-1 inline" />
			{t('misc.csvParsingWarnings', { count: errors.length })}
		</div>
	{/if}

	<table class="min-w-full divide-y divide-gray-200">
		<thead class="sticky top-0 bg-muted">
			<tr>
				{#each headers as header}
					<th
						class="px-3 py-2 text-left text-xs font-medium tracking-wider text-muted-foreground uppercase"
					>
						{header}
					</th>
				{/each}
			</tr>
		</thead>
		<tbody class="divide-y divide-gray-200 bg-background">
			{#each visibleRows as row}
				<tr>
					{#each headers as header}
						<td class="px-3 py-2 text-sm whitespace-nowrap text-muted-foreground">
							{row[header] || ''}
						</td>
					{/each}
				</tr>
			{/each}
		</tbody>
	</table>

	{#if totalRows > 50}
		<div class="border-t px-3 py-2 text-center text-sm text-muted-foreground">
			{t('misc.csvShowingRows', { count: totalRows })}
		</div>
	{/if}
</div>
