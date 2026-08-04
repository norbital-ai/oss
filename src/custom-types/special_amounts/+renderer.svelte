<script lang="ts">
	import { Button } from '@norbital-ai/ui/button';
	import { Input } from '@norbital-ai/ui/input';
	import { Inline, Stack } from '@norbital-ai/ui/layout';
	import { specialAmountsSchema, type SpecialAmounts } from './+definition.js';
	import type { RendererProps } from './$types.js';

	interface AmountRow {
		readonly id: string;
		readonly rule: string;
		readonly amount: number;
	}

	function toRows(record: SpecialAmounts): AmountRow[] {
		return Object.entries(record).map(([rule, amount], index) => ({
			id: `${rule}:${index}`,
			rule,
			amount
		}));
	}

	function toRecord(rows: readonly AmountRow[]): SpecialAmounts {
		const record: Record<string, number> = {};
		for (const row of rows) {
			const key = row.rule.trim();
			if (key.length > 0) record[key] = row.amount;
		}
		return record;
	}

	let props: RendererProps = $props();
	const disabled = $derived(props.mode === 'edit' ? props.disabled : true);
	const parsedIncoming = $derived(specialAmountsSchema.safeParse(props.value));
	const incomingRows = $derived(parsedIncoming.success ? toRows(parsedIncoming.data) : []);
	let edits = $state<AmountRow[] | null>(null);
	const rows = $derived(edits ?? incomingRows);

	const summary = $derived(
		rows.length === 0 ? '—' : rows.map((row) => `${row.rule}: ${row.amount}`).join(', ')
	);

	function commit(nextRows: AmountRow[]): void {
		edits = nextRows;
		if (props.mode === 'edit') props.onValueChange(toRecord(nextRows));
	}

	function numberFrom(raw: string, fallback: number): number {
		const next = Number(raw);
		return Number.isFinite(next) ? next : fallback;
	}
</script>

{#if props.mode === 'display'}
	<span class="block truncate" title={summary}>{summary}</span>
{:else}
	<Stack class="rounded-md border border-border bg-muted/20 p-3" gap="sm">
		{#if rows.length === 0}
			<p class="text-sm text-muted-foreground">No special-rule amounts.</p>
		{/if}
		{#each rows as row, index (row.id)}
			<Inline align="end" gap="xs">
				<label class="grid flex-1 gap-1.5 text-sm font-medium">
					Rule
					<Input
						value={row.rule}
						{disabled}
						placeholder="Rule name"
						oninput={(event) =>
							commit(
								rows.map((entry, position) =>
									position === index ? { ...entry, rule: event.currentTarget.value } : entry
								)
							)}
					/>
				</label>
				<label class="grid flex-1 gap-1.5 text-sm font-medium">
					Amount
					<Input
						type="number"
						step="0.01"
						value={row.amount}
						{disabled}
						oninput={(event) =>
							commit(
								rows.map((entry, position) =>
									position === index
										? { ...entry, amount: numberFrom(event.currentTarget.value, 0) }
										: entry
								)
							)}
					/>
				</label>
				<Button
					variant="ghost"
					size="sm"
					{disabled}
					onclick={() => commit(rows.filter((_, position) => position !== index))}
				>
					Remove
				</Button>
			</Inline>
		{/each}
		<Button
			variant="outline"
			size="sm"
			{disabled}
			onclick={() => commit([...rows, { id: crypto.randomUUID(), rule: '', amount: 0 }])}
		>
			Add rule amount
		</Button>
	</Stack>
{/if}
