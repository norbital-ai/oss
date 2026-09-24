<script module lang="ts">
	import type { CollectionField, CollectionRecordHistoryEntry } from '@norbital-ai/std/collection';
	import { createContext } from 'svelte';

	interface CollectionFormFieldContext {
		collectionName: () => string;
		field: (name: string) => CollectionField | undefined;
		row: () => Record<string, unknown>;
		value: (name: string) => unknown;
		setValue: (name: string, value: unknown) => void;
		setPending: (name: string, pending: boolean) => void;
		register: (name: string, hidden: boolean) => () => void;
		dirty: (name: string) => boolean;
		errors: (name: string) => string[];
		disabled: () => boolean;
		readonly: () => boolean;
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
	import Icon from '@iconify/svelte';
	import { DataRenderer, type FieldRendererComponent } from '#lib/data-renderer';
	import { useI18n, type UiKeys } from '#lib/i18n';
	import { Inline, Stack } from '#lib/layout';
	import { Tooltip } from '#lib/tooltip';
	import { onDestroy } from 'svelte';
	import type { CollectionFormFieldProps } from '#lib/collection-form/collection-form.types';
	import CollectionFormFieldHistory from './collection-form-field-history.svelte';

	const { t } = useI18n<UiKeys>();

	let {
		name,
		label,
		description,
		descriptionExtra,
		hidden = false,
		readonly: readonlyProp,
		disabled: disabledProp,
		placeholder,
		relationOptions,
		renderer,
		rendererProps = {},
		...rest
	}: CollectionFormFieldProps<TFieldName> = $props();

	const context = getCollectionFormFieldContext();
	const field = $derived(context.field(name));
	const value = $derived(context.value(name));
	const disabled = $derived((disabledProp ?? false) || context.disabled());
	const readonly = $derived(readonlyProp ?? context.readonly());
	const fieldId = $derived(`${context.collectionName()}-${name}`);
	const dirty = $derived(context.dirty(name));
	const errors = $derived(context.errors(name));
	const errorId = $derived(`${fieldId}-errors`);
	const fieldLabel = $derived(label ?? field?.label ?? humanize(name));

	// svelte-ignore state_referenced_locally -- field names are immutable for a mounted Field composition.
	onDestroy(context.register(name, hidden));
</script>

{#if field && !hidden}
	<Stack
		gap="sm"
		{...rest}
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
			{#if description || descriptionExtra}
				<Tooltip
					delayDuration={200}
					side="bottom"
					align="start"
					sideOffset={6}
					contentClass={descriptionExtra
						? 'max-w-[38rem] border bg-popover text-popover-foreground'
						: 'max-w-72 border bg-popover text-popover-foreground'}
					arrowClasses="text-popover"
				>
					{#snippet trigger({ props })}
						<button
							{...props}
							type="button"
							aria-label={t('form.fieldDescriptionLabel', { label: fieldLabel })}
							class="size-5 shrink-0 rounded-sm text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
						>
							<Inline as="span" justify="center" class="size-full">
								<Icon icon="lucide:info" class="size-3" aria-hidden="true" />
							</Inline>
						</button>
					{/snippet}
					{#snippet content()}
						<Stack gap="sm" class="px-2.5 py-2 text-left text-xs text-muted-foreground">
							{#if description}
								<p>{description}</p>
							{/if}
							{#if descriptionExtra}
								<div>{@render descriptionExtra()}</div>
							{/if}
						</Stack>
					{/snippet}
				</Tooltip>
			{/if}
			{#if dirty}
				<span
					class="size-1.5 rounded-full bg-brand"
					aria-label={t('form.unsavedChange')}
					title={t('form.unsavedChange')}
				></span>
			{/if}
		</Inline>
		<div class="min-h-0 min-w-0 flex-1">
			<DataRenderer
				id={fieldId}
				{field}
				{value}
				row={context.row()}
				mode={readonly ? 'display' : 'edit'}
				{disabled}
				{placeholder}
				{relationOptions}
				renderer={renderer as FieldRendererComponent | undefined}
				rendererProps={rendererProps as Readonly<Record<string, unknown>>}
				onValueChange={(next) => context.setValue(name, next)}
				onPendingChange={(pending) => context.setPending(name, pending)}
			/>
		</div>
		{#if errors.length > 0}
			<Stack id={errorId} gap="xs" shrink={false} class="text-sm text-destructive" role="alert">
				{#each errors as message, index (`${index}:${message}`)}
					<p>{message}</p>
				{/each}
			</Stack>
		{/if}
	</Stack>
{/if}
