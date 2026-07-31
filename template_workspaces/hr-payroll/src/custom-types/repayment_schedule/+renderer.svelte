<script lang="ts">
	import { Button } from '@norbital-ai/ui/button';
	import { Input } from '@norbital-ai/ui/input';
	import * as Table from '@norbital-ai/ui/table';
	import { repaymentScheduleSchema } from './+definition.js';
	import type { RendererProps, Value } from './$types.js';

	let props: RendererProps = $props();
	const disabled = $derived(props.mode === 'edit' ? props.disabled : true);
	const parsed = $derived(repaymentScheduleSchema.safeParse(props.value));
	const schedule = $derived(parsed.success ? parsed.data : []);
	const total = $derived(schedule.reduce((sum, entry) => sum + entry.amount, 0));
	const summary = $derived(
		parsed.success
			? `${schedule.length} instalment${schedule.length === 1 ? '' : 's'} · ${total.toFixed(2)}`
			: 'Invalid schedule'
	);

	function emit(next: Value): void {
		if (props.mode === 'edit') props.onValueChange(next);
	}

	function update(index: number, patch: Partial<Value[number]>): void {
		emit(
			schedule.map((entry, position) =>
				position === index ? { ...entry, ...patch } : entry
			) as Value
		);
	}

	function nextDate(): string {
		const last = schedule.at(-1)?.due_date ?? new Date().toISOString().slice(0, 10);
		const parsedDate = new Date(`${last}T00:00:00.000Z`);
		parsedDate.setUTCMonth(parsedDate.getUTCMonth() + 1);
		return parsedDate.toISOString().slice(0, 10);
	}
</script>

{#if props.mode === 'display'}
	<span class="block truncate" title={summary}>{summary}</span>
{:else}
	<div class="space-y-3 rounded-md border border-border bg-muted/20 p-3">
		<div class="rounded-md border border-border bg-background">
			<Table.Root>
				<Table.Header>
					<Table.Row>
						<Table.Head class="w-12">#</Table.Head>
						<Table.Head>Due date</Table.Head>
						<Table.Head>Amount</Table.Head>
						<Table.Head class="w-20"><span class="sr-only">Action</span></Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each schedule as entry, index}
						<Table.Row>
							<Table.Cell class="text-xs tabular-nums text-muted-foreground">
								{index + 1}
							</Table.Cell>
							<Table.Cell>
								<Input
									type="date"
									value={entry.due_date}
									{disabled}
									oninput={(event) => update(index, { due_date: event.currentTarget.value })}
								/>
							</Table.Cell>
							<Table.Cell>
								<Input
									type="number"
									min="0.01"
									step="0.01"
									value={entry.amount}
									{disabled}
									oninput={(event) => {
										const amount = event.currentTarget.valueAsNumber;
										if (Number.isFinite(amount)) update(index, { amount });
									}}
								/>
							</Table.Cell>
							<Table.Cell>
								<Button
									type="button"
									size="sm"
									variant="ghost"
									disabled={disabled || schedule.length === 1}
									onclick={() => emit(schedule.filter((_entry, position) => position !== index))}
								>
									Remove
								</Button>
							</Table.Cell>
						</Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
		</div>
		<div class="flex flex-wrap items-center justify-between gap-2">
			<Button
				type="button"
				size="sm"
				variant="outline"
				{disabled}
				onclick={() => emit([...schedule, { due_date: nextDate(), amount: 0.01 }])}
			>
				Add instalment
			</Button>
			<span class="text-sm font-medium tabular-nums">
				{schedule.length} instalment{schedule.length === 1 ? '' : 's'} · {total.toFixed(2)}
			</span>
		</div>
		{#if !parsed.success}
			<p class="text-sm text-destructive" role="alert">
				Every repayment needs a valid date and a positive amount.
			</p>
		{/if}
	</div>
{/if}
