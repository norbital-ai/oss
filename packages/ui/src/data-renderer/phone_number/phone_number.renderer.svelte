<script lang="ts">
	import Icon from '@iconify/svelte';
	import { Schema } from 'effect';
	import { Button } from '#lib/button';
	import { useI18n, type UiKeys } from '#lib/i18n';
	import { Inline, Stack } from '#lib/layout';
	import type { DataRendererProps } from '#lib/data-renderer/data-renderer.types';
	import PhoneInput from './phone_number.input.svelte';

	const { t } = useI18n<UiKeys>();

	let {
		field,
		value,
		id,
		disabled = false,
		placeholder = t('dataRenderer.valuePlaceholder'),
		onValueChange,
		locale,
		class: className
	}: DataRendererProps = $props();
	const localeEffective = $derived(locale ?? useI18n<UiKeys>().intlLocale);

	const isString = Schema.is(Schema.String);

	const values = $derived(Array.isArray(value) ? value.filter(isString) : []);
	const valuePlaceholderText = t('dataRenderer.valuePlaceholder');
	const phonePlaceholder = $derived(
		placeholder === valuePlaceholderText ? t('dataRenderer.phonePlaceholder') : placeholder
	);

	function updateAt(index: number, next: string | null): void {
		const updated = [...values];
		updated[index] = next ?? '';
		onValueChange?.(updated);
	}

	function removeAt(index: number): void {
		onValueChange?.(values.filter((_, itemIndex) => itemIndex !== index));
	}
</script>

{#if field.array}
	<Stack gap="sm" class={className}>
		{#each values as phone, index (`${index}-${phone}`)}
			<Inline align="start" gap="sm">
				<PhoneInput
					id={id ? `${id}-${index}` : undefined}
					value={phone}
					placeholder={phonePlaceholder}
					locale={localeEffective}
					{disabled}
					class="min-w-0 flex-1"
					onValueChange={(next) => updateAt(index, next)}
				/>
				<Button
					type="button"
					variant="outline"
					size="icon"
					class="shrink-0"
					aria-label={t('dataRenderer.removePhoneNumber')}
					{disabled}
					onclick={() => removeAt(index)}
				>
					<Icon icon="lucide:x" />
				</Button>
			</Inline>
		{/each}
		<Button
			type="button"
			variant="outline"
			size="sm"
			{disabled}
			onclick={() => onValueChange?.([...values, ''])}
		>
			<Icon icon="lucide:plus" />
			{t('dataRenderer.addPhoneNumber')}
		</Button>
	</Stack>
{:else}
	<PhoneInput
		{id}
		value={typeof value === 'string' ? value : null}
		placeholder={phonePlaceholder}
		locale={localeEffective}
		{disabled}
		class={className}
		onValueChange={(next) => onValueChange?.(next)}
	/>
{/if}
