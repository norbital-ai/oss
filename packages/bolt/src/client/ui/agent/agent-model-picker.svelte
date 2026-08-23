<script lang="ts">
	/**
	 * Model and variant for the next turn.
	 *
	 * Restored from the Core-era `AgentModelPicker`: one combobox for the model family and a second
	 * for the variant within it, because a catalog lists `deepseek/deepseek-v4-flash-0731` and
	 * `deepseek/deepseek-v4-flash-0731:free` as two entries a person reads as one model.
	 */
	import { Combobox } from '@norbital-ai/ui/combobox';
	import { Inline, Stack } from '@norbital-ai/ui/layout';
	import { cn } from '@norbital-ai/ui/utils';
	import type { AgentModelCatalogStatus, AiModelOption } from './agent-model-state.svelte.js';
	import { AGENT_COMPOSER_CONTROL_TEXT_CLASS } from '#lib/client/ui/agent/composer-chrome.js';
	import { useI18n } from '@norbital-ai/ui/i18n';

	const { t } = useI18n();

	interface ModelFamily {
		id: string;
		label: string;
		defaultOption: AiModelOption;
		options: AiModelOption[];
	}

	let {
		value = $bindable<string>(),
		options,
		disabled = false,
		status = 'ready',
		compact = false,
		class: className,
		onValueChange
	}: {
		value: string;
		options: readonly AiModelOption[];
		disabled?: boolean;
		status?: AgentModelCatalogStatus;
		compact?: boolean;
		class?: string;
		onValueChange?: (value: string) => void;
	} = $props();

	/** Strips the OpenRouter-style variant suffix so catalog entries group by model family. */
	function baseModelId(modelId: string): string {
		return modelId.split(':', 1)[0] ?? modelId;
	}

	// A selection the catalog does not list still has to be selectable, or the trigger renders blank
	// on a model the host resolved from an authored profile.
	const availableOptions = $derived.by(() => {
		if (!value) return options;
		if (options.some((option) => option.id === value)) return options;
		return [...options, { id: value, label: value, canonicalSlug: baseModelId(value) }];
	});
	const families = $derived.by((): ModelFamily[] => {
		const grouped = new Map<string, AiModelOption[]>();
		for (const option of availableOptions) {
			// An option the provider did not group is its own family.
			const canonicalSlug = option.canonicalSlug ?? option.id;
			const family = grouped.get(canonicalSlug) ?? [];
			family.push(option);
			grouped.set(canonicalSlug, family);
		}
		return [...grouped.entries()].map(([id, familyOptions]) => {
			const defaultOption =
				familyOptions.find((option) => option.id === baseModelId(option.id)) ?? familyOptions[0]!;
			return {
				id,
				label: defaultOption.label,
				defaultOption,
				options: familyOptions.sort((left, right) => left.id.localeCompare(right.id))
			};
		});
	});
	const selectedFamily = $derived(
		families.find((family) => family.options.some((option) => option.id === value)) ?? null
	);
	const modelOptions = $derived(
		families.map((family) => ({
			value: family.defaultOption.id,
			label: family.label,
			type: family.defaultOption.id.split('/', 1)[0] ?? 'Other',
			search_term: `${family.label} ${family.defaultOption.id}`
		}))
	);
	const variantOptions = $derived(
		(selectedFamily?.options ?? []).map((option) => {
			const defaultModelId = selectedFamily?.defaultOption.id ?? option.id;
			const label =
				option.id === defaultModelId
					? t('bolt.agent.default')
					: option.id
							.slice(baseModelId(option.id).length + 1)
							.replaceAll(/[-_]/g, ' ')
							.replace(/^\w/, (character) => character.toUpperCase());
			return {
				value: option.id,
				label,
				search_term: `${option.label} ${option.id}`
			};
		})
	);
	const unavailableLabel = $derived(
		status === 'loading' || status === 'idle' ? t('common.loading') : t('common.notAvailable')
	);

	/** Writes the picked model id back to the bound value and optional change callback. */
	function selectModel(modelId: string | null): void {
		if (!modelId) return;
		value = modelId;
		onValueChange?.(modelId);
	}
</script>

{#snippet fields()}
	<Stack gap="xs" class="min-w-0">
		{#if !compact}<span class="text-sm font-medium">{t('bolt.agent.model')}</span>{/if}
		<Combobox
			options={modelOptions}
			ariaLabel={t('bolt.agent.model')}
			value={selectedFamily?.defaultOption.id ?? value}
			onValueChange={selectModel}
			searchPlaceholder={t('bolt.agent.searchAllModels')}
			emptyPlaceholder={unavailableLabel}
			itemHeight={36}
			maxHeight={360}
			class="min-w-0"
			{...compact
				? {
						triggerClass: cn(
							'border-0 bg-transparent shadow-none hover:bg-muted',
							AGENT_COMPOSER_CONTROL_TEXT_CLASS
						)
					}
				: {}}
			minWidth={compact ? 280 : 320}
			sameWidth={!compact}
			{disabled}
		/>
	</Stack>
	{#if variantOptions.length > 1}
		<Stack gap="xs" class="min-w-0">
			{#if !compact}<span class="text-sm font-medium">{t('bolt.agent.variant')}</span>{/if}
			<Combobox
				options={variantOptions}
				ariaLabel={t('bolt.agent.modelVariantAria')}
				{value}
				onValueChange={selectModel}
				searchable={false}
				class="min-w-0"
				{...compact
					? {
							triggerClass: cn(
								'border-0 bg-transparent shadow-none hover:bg-muted',
								AGENT_COMPOSER_CONTROL_TEXT_CLASS
							),
							minWidth: 112
						}
					: {}}
				sameWidth={!compact}
				{disabled}
			/>
		</Stack>
	{/if}
{/snippet}

{#if compact}
	<Inline align="center" gap="xs" class={cn('min-w-0', className)}>
		{@render fields()}
	</Inline>
{:else}
	<div class={cn('grid min-w-0 gap-2 sm:grid-cols-[minmax(0,1fr)_9rem]', className)}>
		{@render fields()}
	</div>
{/if}
