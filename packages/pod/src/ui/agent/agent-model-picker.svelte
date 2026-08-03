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
	import type { AgentModelOption } from './models.js';
	import { AGENT_COMPOSER_CONTROL_TEXT_CLASS } from './composer-chrome.js';

	interface ModelFamily {
		id: string;
		label: string;
		defaultOption: AgentModelOption;
		options: AgentModelOption[];
	}

	let {
		value = $bindable<string>(),
		options,
		disabled = false,
		compact = false,
		class: className,
		onValueChange
	}: {
		value: string;
		options: readonly AgentModelOption[];
		disabled?: boolean;
		compact?: boolean;
		class?: string;
		onValueChange?: (value: string) => void;
	} = $props();

	function baseModelId(modelId: string): string {
		return modelId.split(':', 1)[0] ?? modelId;
	}

	function variantLabel(modelId: string, defaultModelId: string): string {
		if (modelId === defaultModelId) return 'Default';
		const variant = modelId.slice(baseModelId(modelId).length + 1);
		return variant.replaceAll(/[-_]/g, ' ').replace(/^\w/, (character) => character.toUpperCase());
	}

	// A selection the catalog does not list still has to be selectable, or the trigger renders blank
	// on a model the host resolved from an authored profile.
	const availableOptions = $derived.by(() => {
		if (options.some((option) => option.id === value)) return options;
		return [...options, { id: value, label: value, canonicalSlug: baseModelId(value) }];
	});
	const families = $derived.by((): ModelFamily[] => {
		const grouped = new Map<string, AgentModelOption[]>();
		for (const option of availableOptions) {
			const family = grouped.get(option.canonicalSlug) ?? [];
			family.push(option);
			grouped.set(option.canonicalSlug, family);
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
		(selectedFamily?.options ?? []).map((option) => ({
			value: option.id,
			label: variantLabel(option.id, selectedFamily?.defaultOption.id ?? option.id),
			search_term: `${option.label} ${option.id}`
		}))
	);

	function selectModel(modelId: string | null): void {
		if (!modelId) return;
		value = modelId;
		onValueChange?.(modelId);
	}
</script>

{#snippet fields()}
	<Stack gap="xs" class="min-w-0">
		{#if !compact}<span class="text-sm font-medium">Model</span>{/if}
		<Combobox
			options={modelOptions}
			ariaLabel="Model"
			value={selectedFamily?.defaultOption.id ?? value}
			onValueChange={selectModel}
			searchPlaceholder="Search all models…"
			itemHeight={36}
			maxHeight={360}
			class="min-w-0"
			triggerClass={compact
				? cn(
						'border-0 bg-transparent shadow-none hover:bg-muted',
						AGENT_COMPOSER_CONTROL_TEXT_CLASS
					)
				: undefined}
			minWidth={compact ? 280 : 320}
			sameWidth={!compact}
			{disabled}
		/>
	</Stack>
	<Stack gap="xs" class="min-w-0">
		{#if !compact}<span class="text-sm font-medium">Variant</span>{/if}
		<Combobox
			options={variantOptions}
			ariaLabel="Model variant"
			{value}
			onValueChange={selectModel}
			searchable={false}
			class="min-w-0"
			triggerClass={compact
				? cn(
						'border-0 bg-transparent shadow-none hover:bg-muted',
						AGENT_COMPOSER_CONTROL_TEXT_CLASS
					)
				: undefined}
			minWidth={compact ? 112 : undefined}
			sameWidth={!compact}
			disabled={disabled || variantOptions.length < 2}
		/>
	</Stack>
{/snippet}

{#if compact}
	<Inline align="center" gap="xs" class={cn('min-w-0', className)}>
		{@render fields()}
	</Inline>
{:else}
	<!-- stupidity:allow UI6 -- Model/Variant field pair is a viewport sm:grid-cols-[1fr_9rem] row that Grid minimum cannot express. -->
	<div class={cn('grid min-w-0 gap-2 sm:grid-cols-[minmax(0,1fr)_9rem]', className)}>
		{@render fields()}
	</div>
{/if}
