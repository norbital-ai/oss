<!--
	A `read` result as a table: one section per root, columns from the returned rows, structured cells
	open as the shared data renderer. The panel never prints a raw JSON read result.
-->
<script lang="ts">
	import { Schema } from 'effect';
	import { StructuredData } from '@norbital-ai/ui';

	let { value, t }: { value: unknown; t: (key: string) => string } = $props();
	type Row = Readonly<Record<string, unknown>>;
	const object = (v: unknown): v is Readonly<Record<string, unknown>> =>
		typeof v === 'object' && v !== null && !Array.isArray(v);
	const roots = $derived.by(() => {
		if (!object(value)) return [];
		return Object.entries(value).flatMap(([name, held]) => {
			if (Array.isArray(held))
				return [
					{ name, rows: held as readonly Row[], total: held.length, next: null as string | null }
				];
			if (!object(held) || !Array.isArray(held.rows)) return [];
			// a grouped row's key is its columns
			const rows: readonly Row[] = (held.rows.filter(object) as readonly Row[]).map(
				({ key, ...row }) =>
					object(key) ? { ...key, ...row } : key === undefined ? row : { key, ...row }
			);
			return [
				{
					name,
					rows,
					total: typeof held.total === 'number' ? held.total : rows.length,
					next: typeof held.next === 'string' ? held.next : null
				}
			];
		});
	});
	const columns = (rows: readonly Row[]) => {
		const keys = new Set<string>();
		for (const row of rows) for (const key of Object.keys(row)) keys.add(key);
		return [...keys].sort((a, b) => Number(b === 'id') - Number(a === 'id') || a.localeCompare(b));
	};
	const structured = (v: unknown) => typeof v === 'object' && v !== null;
</script>

<div class="grid gap-2" data-read-table>
	{#each roots as root (root.name)}
		<section class="overflow-hidden rounded-md border bg-background">
			<header class="flex items-center gap-2 border-b bg-muted/40 px-2 py-1">
				<span class="truncate font-mono text-micro">{root.name}</span>
				<span class="ml-auto text-meta">{root.total} {t(root.total === 1 ? 'row' : 'rows')}</span>
			</header>
			{#if root.rows.length === 0}<p class="px-2 py-2 text-meta">{t('No rows')}</p>{/if}
			{#if root.rows.length > 0}
				<div class="max-h-56 overflow-auto">
					<table class="w-full border-collapse text-micro">
						<thead class="sticky top-0 bg-muted/80 text-left text-meta">
							<tr>
								{#each columns(root.rows) as column (column)}
									<th class="whitespace-nowrap border-b px-2 py-1 font-medium">{column}</th>
								{/each}
							</tr>
						</thead>
						<tbody>
							{#each root.rows as row, index (typeof row.id === 'string' ? row.id : index)}
								<tr class="border-b last:border-0">
									{#each columns(root.rows) as column (column)}
										{@const cell = row[column]}
										<td class="max-w-64 px-2 py-1 align-top">
											{#if cell === null || cell === undefined}
												<span class="text-muted-foreground">—</span>
											{:else if structured(cell)}
												<details>
													<summary class="cursor-pointer text-muted-foreground"
														>{Array.isArray(cell) ? `${cell.length} items` : 'Open'}</summary
													>
													<div class="max-h-40 overflow-auto">
														<StructuredData
															value={Schema.decodeUnknownSync(Schema.Json)(cell)}
															name={column}
															frame={false}
														/>
													</div>
												</details>
											{:else}{String(cell)}{/if}
										</td>
									{/each}
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
				{#if root.next !== null}<p class="border-t px-2 py-1 text-meta">{t('More rows available')}</p>{/if}
			{/if}
		</section>
	{/each}
</div>
