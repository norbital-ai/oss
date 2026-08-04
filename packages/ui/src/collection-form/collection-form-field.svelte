<script module lang="ts">
	import type {
		CollectionField,
		CollectionRecordHistoryEntry
	} from '@norbital-ai/platform-utils/collection';
	import { createContext } from 'svelte';

	interface CollectionFormFieldContext {
		collectionName: () => string;
		field: (name: string) => CollectionField | undefined;
		row: () => Record<string, unknown>;
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
	import { Inline, Stack } from '#lib/layout';
	import { cn } from '#lib/utils';
	import { onDestroy } from 'svelte';
	import type { CollectionFormFieldProps } from './collection-form.types.js';
	import CollectionFormFieldHistory from './collection-form-field-history.svelte';

	let {
		name,
		label,
		class: className,
		renderer: Renderer,
		rendererProps
	}: CollectionFormFieldProps<TFieldName> = $props();

	const context = getCollectionFormFieldContext();
	const field = $derived(context.field(name));
	const value = $derived(context.value(name));
	const resolvedRendererProps = $derived(rendererProps ?? {});
	const readonly = $derived.by(() => {
		const flag = Reflect.get(resolvedRendererProps, 'readonly');
		return typeof flag === 'boolean' ? flag : false;
	});
	const disabled = $derived.by(() => {
		const flag = Reflect.get(resolvedRendererProps, 'disabled');
		return typeof flag === 'boolean' ? flag : context.disabled();
	});
	const fieldId = $derived(`${context.collectionName()}-${name}`);
	const dirty = $derived(context.dirty(name));
	const errors = $derived(context.errors(name));
	const errorId = $derived(`${fieldId}-errors`);
	const fieldLabel = $derived(label ?? field?.label ?? humanize(name));

	// svelte-ignore state_referenced_locally -- field names are immutable for a mounted Field composition.
	onDestroy(context.register(name));
</script>

{#if field}
	<!-- stupidity:allow UI6 -- this leaf component root is the reusable layout boundary being defined -->
	<div
		class={cn('flex min-h-0 flex-col gap-2', className)}
		data-collection-field={name}
		data-dirty={dirty ? 'true' : undefined}
		data-invalid={errors.length > 0 ? 'true' : undefined}
		aria-describedby={errors.length > 0 ? errorId : undefined}
	>
		<Inline gap="sm" shrink={false}>
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
		</Inline>
		<div class="min-h-0 min-w-0 flex-1">
			{#if Renderer}
				<Renderer
					{...resolvedRendererProps}
					{field}
					{value}
					row={context.row()}
					{readonly}
					{disabled}
					onValueChange={(next) => context.setValue(name, next)}
				/>
			{:else}
				<DataRenderer
					{...resolvedRendererProps}
					id={fieldId}
					{field}
					{value}
					row={context.row()}
					mode={readonly ? 'display' : 'edit'}
					{disabled}
					onValueChange={(next) => context.setValue(name, next)}
				/>
			{/if}
		</div>
		{#if errors.length > 0}
			<Stack id={errorId} gap="xs" shrink={false} class="text-sm text-destructive" role="alert">
				{#each errors as message, index (`${index}:${message}`)}
					<p>{message}</p>
				{/each}
			</Stack>
		{/if}
	</div>
{/if}
