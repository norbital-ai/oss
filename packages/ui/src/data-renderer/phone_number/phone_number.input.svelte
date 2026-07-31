<script lang="ts">
	import { Combobox, type TOption } from '#lib/combobox';
	import { Input } from '#lib/input';
	import { Inline } from '#lib/layout';
	import { cn } from '#lib/utils';
	import type { CountryCode } from 'libphonenumber-js/min';
	import { watch } from 'runed';
	import {
		changePhoneCountry,
		formatPhoneInput,
		normalizePhoneValue,
		phoneCountryFromLocale,
		phoneCountryOptions,
		phoneInputPlaceholder,
		resolvePhoneCountry,
		sanitizePhoneInput
	} from './phone_number.utils.js';

	let {
		value,
		id,
		disabled = false,
		placeholder = 'Phone number',
		locale = 'en-US',
		class: className,
		onValueChange
	}: {
		value?: string | null;
		id?: string;
		disabled?: boolean;
		placeholder?: string;
		locale?: string;
		class?: string;
		onValueChange?: (value: string | null) => void;
	} = $props();

	const fallbackCountry = $derived(phoneCountryFromLocale(locale));
	const countries = $derived(phoneCountryOptions(locale));
	const countryOptions = $derived.by((): TOption<CountryCode, Record<string, never>>[] =>
		countries.map((option) => ({
			value: option.country,
			label: `${option.flag} ${option.name} (+${option.callingCode})`,
			search_term: `${option.name} ${option.country} +${option.callingCode}`
		}))
	);
	let country = $state<CountryCode>('US');
	let draft = $state('');
	let hasBlurred = $state(false);
	let lastEmittedValue: string | null | undefined;
	const inputPlaceholder = $derived(
		placeholder === 'Phone number' ? phoneInputPlaceholder(country) : placeholder
	);
	const invalid = $derived(hasBlurred && draft !== '' && !normalizePhoneValue(draft, country));
	const errorId = $derived(id ? `${id}-error` : undefined);

	watch(
		() => [value, locale] as const,
		([nextValue]) => {
			if (nextValue === lastEmittedValue) return;
			const text = nextValue ?? '';
			hasBlurred = false;
			country = resolvePhoneCountry(text, fallbackCountry);
			draft = formatPhoneInput(text, country);
		},
		{ lazy: false }
	);

	function emitDraft(): void {
		lastEmittedValue = normalizePhoneValue(draft, country) ?? (draft.trim() || null);
		onValueChange?.(lastEmittedValue);
	}

	function updateValue(event: Event & { currentTarget: HTMLInputElement }): void {
		const raw = sanitizePhoneInput(event.currentTarget.value);
		country = resolvePhoneCountry(raw, country);
		draft = formatPhoneInput(raw, country);
		emitDraft();
	}

	function updateCountry(nextCountry: CountryCode | null): void {
		if (!nextCountry || nextCountry === country) return;
		draft = changePhoneCountry(draft, country, nextCountry);
		country = nextCountry;
		if (draft) emitDraft();
	}

	function handleBlur(): void {
		hasBlurred = true;
	}
</script>

{#snippet countryDisplay(selectedCountry: CountryCode)}
	{@const option = countries.find((item) => item.country === selectedCountry)}
	<Inline as="span" gap="xs">
		<span aria-hidden="true">{option?.flag}</span>
		<span class="font-mono text-xs tabular-nums">+{option?.callingCode}</span>
	</Inline>
{/snippet}

<div class={cn('min-w-0 space-y-1.5', className)}>
	<div class="flex min-w-0">
		<Combobox
			options={countryOptions}
			value={country}
			display={countryDisplay}
			ariaLabel="Country calling code"
			searchPlaceholder="Search countries..."
			preserveOptionOrder
			scrollToSelection
			sameWidth={false}
			minWidth={280}
			align="start"
			class="w-28 shrink-0"
			triggerClass="h-9 rounded-r-none border-r-0"
			{disabled}
			onValueChange={updateCountry}
		/>
		<Input
			{id}
			type="tel"
			inputmode="tel"
			autocomplete="tel"
			value={draft}
			placeholder={inputPlaceholder}
			{disabled}
			aria-label={id ? undefined : placeholder}
			aria-invalid={invalid}
			aria-describedby={invalid ? errorId : undefined}
			class="rounded-l-none font-mono tabular-nums"
			oninput={updateValue}
			onblur={handleBlur}
		/>
	</div>
	{#if invalid}
		<p id={errorId} class="text-xs text-destructive" role="alert">Enter a valid phone number.</p>
	{/if}
</div>
