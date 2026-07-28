<script lang="ts">
	import type {
		CollectionField,
		CollectionRecordHistoryEntry
	} from '@norbital-ai/platform-utils/collection';
	import Icon from '@iconify/svelte';
	import { formatDataValue } from '../data-renderer/index.js';
	import { Label } from '#lib/label';
	import { StructuredValue } from '#lib/structured-value';
	import { Tooltip } from '#lib/tooltip';
	import { collectionFieldHistory } from './collection-form-history.js';

	interface Props {
		field: CollectionField;
		fieldId: string;
		label: string;
		value: unknown;
		dirty: boolean;
		available: boolean;
		history: readonly CollectionRecordHistoryEntry[];
		loading: boolean;
		error: Error | undefined;
		load: () => void;
	}

	let { field, fieldId, label, value, dirty, available, history, loading, error, load }: Props =
		$props();

	const fieldHistory = $derived(collectionFieldHistory(history, field.name));
	const timestampField: CollectionField = {
		name: 'history_timestamp',
		kind: 'timestamptz',
		nullable: false
	};
</script>

{#snippet HistoryValue(entryValue: unknown)}
	{#if entryValue != null && typeof entryValue === 'object'}
		<div class="max-h-32 overflow-auto rounded-md border bg-muted/30 p-2">
			<StructuredValue value={entryValue} />
		</div>
	{:else}
		<p class="break-words text-sm text-foreground">{formatDataValue(field, entryValue)}</p>
	{/if}
{/snippet}

{#if available}
	<div class="inline-flex min-w-0 items-center gap-1">
		<Label for={fieldId} class="text-sm leading-none font-medium">{label}</Label>
		<Tooltip
			delayDuration={200}
			side="bottom"
			align="start"
			sideOffset={6}
			contentClass="w-80 max-w-[min(20rem,calc(100vw-2rem))] border border-border bg-popover p-0 text-popover-foreground shadow-md"
			arrowClasses="text-popover"
			onOpenChange={(open) => {
				if (open) load();
			}}
		>
			{#snippet trigger({ props })}
				<button
					{...props}
					type="button"
					aria-label={`${label} field history`}
					class="inline-flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
				>
					<Icon icon="lucide:history" class="size-3" aria-hidden="true" />
				</button>
			{/snippet}
			{#snippet content()}
				<div class="border-b px-3 py-2.5 text-left">
					<p class="text-sm font-semibold text-foreground">{label}</p>
					<p class="text-xs text-muted-foreground">Local edits and saved history</p>
				</div>
				{#if dirty}
					<div class="border-b bg-brand/5 px-3 py-2.5 text-left">
						<div class="mb-1 flex items-center gap-1.5 text-xs font-medium text-brand">
							<span class="size-1.5 rounded-full bg-brand"></span>
							Unsaved local value
						</div>
						{@render HistoryValue(value)}
					</div>
				{/if}
				<div class="max-h-64 overflow-y-auto px-3 py-3 text-left">
					<p class="mb-3 text-xs font-medium text-muted-foreground">Saved timeline</p>
					{#if loading}
						<div class="flex items-center gap-2 text-xs text-muted-foreground" role="status">
							<Icon icon="lucide:loader-circle" class="size-3.5 animate-spin" />
							Loading history…
						</div>
					{:else if error}
						<p class="text-xs text-destructive" role="alert">History could not be loaded.</p>
					{:else if fieldHistory.length === 0}
						<p class="text-xs text-muted-foreground">No saved history yet.</p>
					{:else}
						<ol aria-label={`${label} saved history`}>
							{#each fieldHistory as entry, index (`${entry.version}:${entry.validFrom}`)}
								<li class="relative grid grid-cols-[0.75rem_1fr] gap-2 pb-4 last:pb-0">
									<div class="flex justify-center">
										<span class="relative z-10 mt-1 size-2 rounded-full bg-muted-foreground"></span>
										{#if index < fieldHistory.length - 1}
											<span class="absolute top-3 bottom-0 w-px bg-border"></span>
										{/if}
									</div>
									<div class="min-w-0">
										<div class="flex items-baseline justify-between gap-2">
											<p class="text-xs font-medium text-foreground">
												{entry.validTo === null
													? 'Current saved value'
													: `Version ${entry.version}`}
											</p>
											<time
												class="shrink-0 text-tiny text-muted-foreground"
												datetime={entry.validFrom}
											>
												{formatDataValue(timestampField, entry.validFrom)}
											</time>
										</div>
										<div class="mt-1">{@render HistoryValue(entry.value)}</div>
									</div>
								</li>
							{/each}
						</ol>
					{/if}
				</div>
			{/snippet}
		</Tooltip>
	</div>
{:else}
	<Label for={fieldId}>{label}</Label>
{/if}
