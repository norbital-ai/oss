<script module lang="ts">
	import type {
		CollectionField,
		CollectionRecordHistoryEntry
	} from '@norbital-ai/platform-utils/collection';
	import { createContext } from 'svelte';

	interface CollectionFormFieldContext {
		collectionName: () => string;
		field: (name: string) => CollectionField | undefined;
		value: (name: string) => unknown;
		setValue: (name: string, value: unknown) => void;
		register: (name: string) => () => void;
		dirty: (name: string) => boolean;
		errors: (name: string) => string[];
		disabled: () => boolean;
		historyAvailable: () => boolean;
		loadHistory: () => void;
		history: () => readonly CollectionRecordHistoryEntry[];
		historyLoading: () => boolean;
		historyError: () => Error | undefined;
	}

	export const [getCollectionFormFieldContext, setCollectionFormFieldContext] =
		createContext<CollectionFormFieldContext>();
</script>

<script lang="ts" generics="TFieldName extends string">
	import { humanize } from '@norbital-ai/std/string';
	import { DataRenderer } from '../data-renderer/index.js';
	import { cn } from '#lib/utils';
	import { onDestroy } from 'svelte';
	import type { CollectionFormFieldProps } from './collection-form.types.js';
	import CollectionFormFieldHistory from './collection-form-field-history.svelte';

	let {
		name,
		label,
		class: className,
		renderer: Renderer,
		rendererProps = {}
	}: CollectionFormFieldProps<TFieldName> = $props();

	const context = getCollectionFormFieldContext();
	const field = $derived(context.field(name));
	const value = $derived(context.value(name));
	const readonly = $derived(rendererProps.readonly ?? false);
	const disabled = $derived(rendererProps.disabled ?? context.disabled());
	const fieldId = $derived(`${context.collectionName()}-${name}`);
	const dirty = $derived(context.dirty(name));
	const errors = $derived(context.errors(name));
	const errorId = $derived(`${fieldId}-errors`);
	const fieldLabel = $derived(label ?? field?.label ?? humanize(name));

	// svelte-ignore state_referenced_locally -- field names are immutable for a mounted Field composition.
	onDestroy(context.register(name));
</script>

{#if field}
	<div
		class={cn('flex min-h-0 flex-col gap-2', className)}
		data-collection-field={name}
		data-dirty={dirty ? 'true' : undefined}
		data-invalid={errors.length > 0 ? 'true' : undefined}
		aria-describedby={errors.length > 0 ? errorId : undefined}
	>
		<div class="flex shrink-0 items-center gap-2">
			<CollectionFormFieldHistory
				{field}
				{fieldId}
				label={fieldLabel}
				{value}
				{dirty}
				available={context.historyAvailable()}
				history={context.history()}
				loading={context.historyLoading()}
				error={context.historyError()}
				load={context.loadHistory}
			/>
			{#if dirty}
				<span
					class="size-1.5 rounded-full bg-brand"
					aria-label="Unsaved change"
					title="Unsaved change"
				></span>
			{/if}
		</div>
		<div class="min-h-0 min-w-0 flex-1">
			{#if Renderer}
				<Renderer
					{...rendererProps}
					{field}
					{value}
					{readonly}
					{disabled}
					onValueChange={(next) => context.setValue(name, next)}
				/>
			{:else}
				<DataRenderer
					{...rendererProps}
					id={fieldId}
					{field}
					{value}
					mode={readonly ? 'display' : 'edit'}
					{disabled}
					onValueChange={(next) => context.setValue(name, next)}
				/>
			{/if}
		</div>
		{#if errors.length > 0}
			<div id={errorId} class="grid shrink-0 gap-1 text-sm text-destructive" role="alert">
				{#each errors as message, index (`${index}:${message}`)}
					<p>{message}</p>
				{/each}
			</div>
		{/if}
	</div>
{/if}
