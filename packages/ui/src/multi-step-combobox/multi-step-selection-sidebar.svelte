<script lang="ts" generics="TValueMap extends Record<string, unknown>">
	import Icon from '@iconify/svelte';
	import { Button } from '#lib/button';
	import { Indicator } from '#lib/indicator';
	import { Cluster, Inline, Stack } from '#lib/layout';
	import { cn } from '#lib/utils';
	import type { Snippet } from 'svelte';
	import type { SelectionDraft, StepsConfig } from './types.js';

	let {
		selections,
		currentSelectionIndex,
		multiple,
		disabled,
		ariaLabel,
		steps,
		isComplete,
		onSelect,
		onRemove,
		onAdd,
		stepValueLabel
	}: {
		selections: SelectionDraft<TValueMap>[];
		currentSelectionIndex: number;
		multiple: boolean;
		disabled: boolean;
		ariaLabel: string;
		steps: StepsConfig<TValueMap>;
		isComplete: (selection: SelectionDraft<TValueMap> | null | undefined) => boolean;
		onSelect: (index: number, event?: Event) => void;
		onRemove: (index: number, event?: Event) => void;
		onAdd: () => void;
		stepValueLabel: Snippet<
			[
				selection: SelectionDraft<TValueMap>,
				stepKey: keyof TValueMap,
				keyIndex: number,
				separatorClass: string,
				fallbackClass: string
			]
		>;
	} = $props();

	const stepKeys = $derived(Object.keys(steps) as Array<keyof TValueMap>);

	const MISSING_SEP = ', ';
</script>

<!-- stupidity:allow UI5 -- popover panel boundary -->
<aside class="w-[280px] shrink-0 overflow-hidden border-r bg-background">
	<Stack gap="none" class="h-full">
		<Inline gap="none" justify="between" class="h-11 border-b px-3">
			<Inline gap="sm" class="text-xs font-semibold text-muted-foreground">
				<Icon icon="lucide:list-tree" class="h-3.5 w-3.5" />
				<span>{multiple ? 'Selections' : 'Selection'}</span>
			</Inline>
			{#if multiple && !disabled}
				<Button
					variant="outline"
					size="sm"
					class="h-7 rounded-full px-3 text-micro"
					onclick={onAdd}
				>
					<Icon icon="lucide:plus" class="mr-1 h-3 w-3" /> New
				</Button>
			{/if}
		</Inline>
		<!-- stupidity:allow UI9 -- listbox scroll body of the popover panel; Scroll cannot carry role="listbox" -->
		<ul role="listbox" aria-label={ariaLabel} class="flex-1 overflow-auto px-2 py-2">
			{#if selections.length === 0}
				<li
					class="rounded-md border border-dashed border-muted-foreground/30 bg-background px-4 py-6 text-center text-xs text-muted-foreground"
				>
					No selections yet. {#if multiple}Click "New" to start.{/if}
				</li>
			{:else}
				{#each selections as selection, idx (idx)}
					{@const complete = isComplete(selection)}
					{@const missing = stepKeys.filter((key) => selection[key] == null)}
					{@const hasValues = stepKeys.some((key) => selection[key] != null)}
					{@const sepClass = 'opacity-40'}
					{@const fbClass = complete ? 'opacity-70' : 'opacity-60'}
					<li
						role="option"
						aria-selected={idx === currentSelectionIndex}
						class={cn(
							'group flex cursor-pointer items-start justify-between gap-3 rounded-md border border-transparent px-2.5 py-2 text-xs transition-colors hover:bg-brand-100/70 dark:hover:bg-brand-900/50',
							idx === currentSelectionIndex && 'border-accent/40 bg-accent/60'
						)}
						onclick={(e) => onSelect(idx, e)}
						onkeydown={(e) => {
							if (e.key === 'Enter' || e.key === ' ') onSelect(idx, e);
						}}
					>
						<div class="min-w-0 flex-1">
							{#if !complete}
								<Inline gap="xs" class="text-micro font-medium text-yellow-800">
									<Icon icon="lucide:alert-triangle" class="h-3 w-3" />
									Partial selection
								</Inline>
								{#if missing.length > 0}
									<div class="mt-1 text-micro text-yellow-700">
										Missing: {missing.map(String).join(MISSING_SEP)}
									</div>
								{/if}
							{/if}
							{#if hasValues}
								<Cluster
									gap="xs"
									class={cn(
										'text-micro',
										complete ? 'text-foreground/80' : 'mt-1 text-muted-foreground'
									)}
								>
									{#each stepKeys as stepKey, keyIndex}
										{@render stepValueLabel(selection, stepKey, keyIndex, sepClass, fbClass)}
									{/each}
								</Cluster>
							{/if}
						</div>
						<Indicator
							variant={complete ? 'success' : 'warning'}
							size="sm"
							position="top-right"
							animated={!complete}
							visible={true}
							wrapperClass="relative inline-flex h-3 w-3 flex-none"
						>
							<span class="sr-only">{complete ? 'Complete' : 'Partial'}</span>
						</Indicator>
						{#if !disabled}
							<button
								type="button"
								aria-label="Remove selection"
								class="rounded p-1 opacity-60 transition-opacity hover:bg-muted hover:opacity-100 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none focus-visible:ring-inset"
								onclick={(e) => onRemove(idx, e)}
							>
								<Icon icon="lucide:x" class="h-3 w-3" />
							</button>
						{/if}
					</li>
				{/each}
			{/if}
		</ul>
	</Stack>
</aside>
