<!--
	A system row's actions (a run's Stop, a request's Approve, a key's Revoke): the same list in the table's actions
	column and in the row's detail sheet, so a phone (whose rows are cards) reaches every action through the sheet.
-->
<script lang="ts" module>
	import type { ButtonProps } from '@norbital-ai/ui';
	export type Act = { label: string; run: () => unknown; variant?: ButtonProps['variant'] };
</script>

<script lang="ts">
	import { Button, Icon, Popover } from '@norbital-ai/ui';

	/** `all`: every action as a button (a detail sheet has the room); else one line for a table row. */
	let { acts, all = false, more = 'More actions' }: { acts: readonly Act[]; all?: boolean; more?: string } = $props();
	const run = (a: Act) => (e: MouseEvent) => { e.stopPropagation(); void a.run(); };
	const [first, ...rest] = $derived(acts);
</script>

{#if all && acts.length > 0}
	<span class="flex flex-wrap items-center gap-1">
		{#each acts as a (a.label)}<Button size="sm" variant={a.variant ?? 'ghost'} onclick={run(a)}>{a.label}</Button>{/each}
	</span>
<!-- one line in a table row: the first action as a button, the others behind "…" -->
{:else if first !== undefined}
	<span class="flex flex-nowrap items-center gap-1 whitespace-nowrap">
		<Button size="sm" variant={first.variant ?? 'ghost'} onclick={run(first)}>{first.label}</Button>
		{#if rest.length > 0}
			<Popover.Root>
				<Popover.Trigger class="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
					aria-label={more} title={more} onclick={(e: MouseEvent) => e.stopPropagation()}>
					<Icon name="lucide:ellipsis" class="size-4" />
				</Popover.Trigger>
				<Popover.Content align="end" class="grid w-auto min-w-40 gap-0.5 p-1">
					{#each rest as a (a.label)}
						<Button size="sm" variant={a.variant ?? 'ghost'} class="justify-start" onclick={run(a)}>{a.label}</Button>
					{/each}
				</Popover.Content>
			</Popover.Root>
		{/if}
	</span>
{/if}
