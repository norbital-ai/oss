<!--
	Runtime classifier and connected-automation toggles for a conversation connection (`sys_integration.classifier`).
	Composes on top of the deterministic Listening Scope (`sys_integration.listen`).
-->
<script lang="ts">
	import { Checkbox, Textarea } from '@norbital-ai/ui';
	import { Stack } from '@norbital-ai/ui/layout';
	import {
		normalizeClassifierConfig,
		type ClassifierConfig,
		type ClassifierMode
	} from '../../engine/integrations/scope.ts';
	import { humanise_word } from '../i18n.ts';

	let {
		value,
		on_change,
		automations = [],
		disabled = false,
		t
	}: {
		value: ClassifierConfig | null;
		on_change: (next: ClassifierConfig | null) => void;
		automations?: readonly { readonly name: string; readonly description: string }[];
		disabled?: boolean;
		t: (key: string) => string;
	} = $props();

	const mode = $derived<ClassifierMode>(value?.mode ?? 'smart');
	const instructions = $derived(value?.instructions ?? '');
	const disabledSet = $derived(new Set(value?.disabled_automations ?? []));

	const emit = (next: ClassifierConfig) => {
		on_change(normalizeClassifierConfig(next));
	};

	const setMode = (nextMode: ClassifierMode) => {
		emit({
			mode: nextMode,
			...(instructions !== '' ? { instructions } : {}),
			...(disabledSet.size > 0 ? { disabled_automations: [...disabledSet] } : {})
		});
	};

	const setInstructions = (nextText: string) => {
		emit({
			mode,
			...(nextText !== '' ? { instructions: nextText } : {}),
			...(disabledSet.size > 0 ? { disabled_automations: [...disabledSet] } : {})
		});
	};

	const toggleAutomation = (name: string) => {
		const next = new Set(disabledSet);
		if (next.has(name)) next.delete(name);
		else next.add(name);
		emit({
			mode,
			...(instructions !== '' ? { instructions } : {}),
			...(next.size > 0 ? { disabled_automations: [...next] } : {})
		});
	};
</script>

<Stack gap="md" data-classifier-editor>
	<Stack gap="sm">
		<div class="flex flex-wrap items-center justify-between gap-2">
			<div class="min-w-0">
				<p class="text-sm font-medium text-foreground">{t('Smart classifier')}</p>
				<p class="text-meta">
					{mode === 'smart'
						? t('Uses a 30-message conversation window to drop unrelated noise and detect workspace updates.')
						: mode === 'all'
							? t('Passes every message within your listening scope without semantic filtering.')
							: t('Stores messages for on-demand assistant lookups without running background automations.')}
				</p>
			</div>
			<div
				class="inline-flex rounded-md bg-surface-track p-0.5"
				role="radiogroup"
				data-classifier-mode
			>
				{#each (['smart', 'all', 'off'] as const) as option (option)}
					{@const active = mode === option}
					<button
						type="button"
						role="radio"
						aria-checked={active}
						{disabled}
						data-classifier-option={option}
						class="rounded-badge px-2.5 py-1 text-xs font-medium transition-colors outline-hidden focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 {active
							? 'bg-background text-foreground shadow-2xs ring-1 ring-border'
							: 'text-muted-foreground hover:text-foreground'}"
						onclick={() => setMode(option)}
					>
						{option === 'smart' ? t('Smart') : option === 'all' ? t('Pass all') : t('Off')}
					</button>
				{/each}
			</div>
		</div>

		{#if mode === 'smart'}
			<label class="flex flex-col gap-1">
				<span class="text-label">{t('Classifier instructions')}</span>
				<Textarea
					rows={3}
					{disabled}
					value={instructions}
					placeholder={t('Optional: describe what to ignore or keep (e.g. ignore personal chatter; capture project updates, orders, and defects).')}
					oninput={(event) => setInstructions(event.currentTarget.value)}
					data-classifier-instructions
				/>
			</label>
		{/if}
	</Stack>

	{#if automations.length > 0 && mode !== 'off'}
		<Stack gap="xs" class="border-t border-border pt-3" data-connected-automations>
			<p class="text-sm font-medium text-foreground">{t('Connected automations')}</p>
			<p class="text-meta">
				{t('Choose which reactive automations trigger when messages arrive on this connection.')}
			</p>
			<ul class="flex flex-col divide-y divide-border/60 rounded-control border border-border bg-background">
				{#each automations as item (item.name)}
					{@const enabled = !disabledSet.has(item.name)}
					<li>
						<label
							class="flex cursor-pointer items-start gap-2.5 px-3 py-2 text-sm hover:bg-surface-hover"
							data-connection-automation={item.name}
						>
							<span class="pt-0.5">
								<Checkbox
									checked={enabled}
									{disabled}
									on_checked_change={() => toggleAutomation(item.name)}
								/>
							</span>
							<span class="min-w-0 flex-1">
								<span class="block font-medium text-foreground">
									{humanise_word(item.name)}
								</span>
								{#if item.description !== ''}
									<span class="block text-meta">{item.description}</span>
								{/if}
							</span>
						</label>
					</li>
				{/each}
			</ul>
		</Stack>
	{/if}
</Stack>
