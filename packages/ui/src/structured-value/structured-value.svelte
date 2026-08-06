<script lang="ts">
	import { humanize } from '@norbital-ai/std/string';
	import { useI18n, type UiKeys } from '#lib/i18n';
	import { Scroll } from '#lib/layout';
	import { cn } from '#lib/utils';

	let {
		value,
		class: className
	}: {
		value: unknown;
		class?: string;
	} = $props();

	const { t } = useI18n<UiKeys>();

	function primitiveLabel(item: unknown): string {
		if (item == null || item === '') return '—';
		if (typeof item === 'boolean') return item ? 'Yes' : 'No';
		return String(item);
	}

	function recordColumns(items: unknown[]): string[] | null {
		if (
			items.length === 0 ||
			items.some((item) => item == null || typeof item !== 'object' || Array.isArray(item))
		)
			return null;
		return [
			...new Set(
				items.flatMap((item) => (item != null && typeof item === 'object' ? Object.keys(item) : []))
			)
		];
	}

	function recordProperty(item: unknown, key: string): unknown {
		return item != null && typeof item === 'object' ? Reflect.get(item, key) : undefined;
	}
</script>

{#snippet renderValue(item: unknown)}
	{#if Array.isArray(item)}
		{#if item.length === 0}
			<span class="text-muted-foreground">{t('misc.none')}</span>
		{:else}
			{@const columns = recordColumns(item)}
			{#if columns}
				<Scroll axis="x" name={t('misc.valueTable')} class="rounded-md border bg-muted/20">
					<table class="w-full border-collapse text-left text-xs">
						<thead class="bg-muted/40 text-muted-foreground">
							<tr>
								{#each columns as column (column)}
									<th class="border-b px-2.5 py-2 font-medium whitespace-nowrap">
										{humanize(column)}
									</th>
								{/each}
							</tr>
						</thead>
						<tbody class="divide-y">
							{#each item as entry, index (index)}
								<tr>
									{#each columns as column (column)}
										<td class="max-w-64 min-w-24 px-2.5 py-2 align-top break-words">
											{@render renderValue(recordProperty(entry, column))}
										</td>
									{/each}
								</tr>
							{/each}
						</tbody>
					</table>
				</Scroll>
			{:else}
				<ol class="divide-y rounded-md border bg-muted/20">
					{#each item as entry, index (index)}
						<li class="min-w-0 px-3 py-2.5">{@render renderValue(entry)}</li>
					{/each}
				</ol>
			{/if}
		{/if}
	{:else if item != null && typeof item === 'object'}
		{@const entries = Object.entries(item)}
		{#if entries.length === 0}
			<span class="text-muted-foreground">{t('misc.none')}</span>
		{:else}
			<dl class="divide-y rounded-md border bg-muted/20">
				{#each entries as [key, entry] (key)}
					<!-- stupidity:allow UI6 -- structured dl entry row needs explicit responsive key/value tracks -->
					<div class="grid min-w-0 gap-1 px-3 py-2.5 sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-3">
						<dt class="text-xs font-medium text-muted-foreground">{humanize(key)}</dt>
						<dd class="min-w-0 break-words">{@render renderValue(entry)}</dd>
					</div>
				{/each}
			</dl>
		{/if}
	{:else}
		<span class="break-words">{primitiveLabel(item)}</span>
	{/if}
{/snippet}

<div class={cn('min-w-0 text-sm', className)}>{@render renderValue(value)}</div>
