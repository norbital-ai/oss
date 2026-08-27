<script lang="ts">
	import type { CollectionRecord, CollectionRelationOptions } from '@norbital-ai/std/collection';
	import { resolveRecordLabel } from '@norbital-ai/std/collection';
	import { humanize } from '@norbital-ai/std/string';
	import type { Component } from 'svelte';
	import { getOptionalCollectionClientContext } from '#lib/collection-runtime';
	import { useI18n } from '#lib/i18n';
	import DataRendererBuiltin from './data-renderer-builtin.svelte';
	import DataRendererControl from './data-renderer-control.svelte';
	import { getDataRendererRuntimeContext } from './data-renderer-runtime.js';
	import type { DataRendererProps, FieldRendererProps } from './data-renderer.types.js';
	import RelationshipRenderer from './relationship/relationship.renderer.svelte';

	const { t } = useI18n();
	let {
		field,
		value,
		id,
		mode = 'display',
		disabled = false,
		placeholder = t('dataRenderer.valuePlaceholder'),
		onValueChange,
		row,
		onRowChange,
		locale,
		class: className,
		renderer,
		rendererProps = {},
		relationOptions
	}: DataRendererProps = $props();
	const localeEffective = $derived(locale ?? useI18n().intlLocale);
	const effectiveDisabled = $derived(disabled || mode === 'display');
	const rendererRuntime = getDataRendererRuntimeContext();
	const customRendererState = $derived(rendererRuntime?.customTypeRenderer(field.kind));
	const explicitRenderer = $derived(
		renderer as Component<FieldRendererProps & Record<string, unknown>> | undefined
	);
	const collectionClient = getOptionalCollectionClientContext();
	const relationTarget = $derived(field.relation?.target);
	const relationDefinition = $derived(
		relationTarget ? collectionClient?.collections[relationTarget] : undefined
	);
	const automaticRelationOptions = $derived.by((): CollectionRelationOptions | undefined => {
		if (!relationTarget) return undefined;
		return {
			label: (record: CollectionRecord) =>
				resolveRecordLabel(relationDefinition?.recordLabel ?? null, record) ??
				humanize(relationTarget)
		};
	});
	const automaticRelationLabel = $derived.by((): string | string[] | null => {
		if (!field.relation || !row) return null;
		const related = Reflect.get(row, field.relation.name);
		const records = Array.isArray(related) ? related : related == null ? [] : [related];
		const labels = records.flatMap((record) => {
			if (record == null || typeof record !== 'object' || Array.isArray(record)) return [];
			const label = (relationOptions ?? automaticRelationOptions)?.label(record);
			return label ? [label] : [];
		});
		if (labels.length === 0) return null;
		return field.array ? labels : (labels[0] ?? null);
	});
</script>

<DataRendererControl {mode} class={className}>
	{#snippet children()}
		{#if explicitRenderer}
			{@const ExplicitRenderer = explicitRenderer}
			<ExplicitRenderer
				{...rendererProps}
				{field}
				{value}
				{id}
				{mode}
				disabled={effectiveDisabled}
				{placeholder}
				{onValueChange}
				{row}
				{onRowChange}
				locale={localeEffective}
				class="min-w-0 w-full"
			/>
		{:else if field.relation}
			<RelationshipRenderer
				{field}
				{value}
				{id}
				{mode}
				disabled={effectiveDisabled}
				{placeholder}
				{onValueChange}
				{row}
				locale={localeEffective}
				options={relationOptions ?? automaticRelationOptions}
				label={automaticRelationLabel}
				class="min-w-0 w-full"
			/>
		{:else if customRendererState?.status === 'ready'}
			{@const CustomRenderer = customRendererState.renderer}
			<CustomRenderer
				{field}
				{value}
				{id}
				{mode}
				disabled={effectiveDisabled}
				{placeholder}
				{onValueChange}
				{row}
				{onRowChange}
				locale={localeEffective}
				class="min-w-0 w-full"
			/>
		{:else if customRendererState?.status === 'loading'}
			<span class="block min-w-0 truncate text-muted-foreground" role="status">
				{t('dataRenderer.rendererLoading')}
			</span>
		{:else if customRendererState?.status === 'failed'}
			<span
				class="block min-w-0 truncate text-destructive"
				role="alert"
				title={customRendererState.error.message}
			>
				{t('dataRenderer.rendererFailed')}
			</span>
		{:else}
			<DataRendererBuiltin
				{field}
				{value}
				{id}
				{mode}
				disabled={effectiveDisabled}
				{placeholder}
				{onValueChange}
				{row}
				{onRowChange}
				locale={localeEffective}
				class="min-w-0 w-full"
			/>
		{/if}
	{/snippet}
</DataRendererControl>
