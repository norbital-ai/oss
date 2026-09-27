<!--
@component
A phone number: a country calling-code picker (flag and code) joined to the number box; the value is E.164.
-->
<script lang="ts" module>
	import type { Json } from './kind.js';

	/** A phone number (E.164, `+6591234567`): the calling code is picked, the national digits typed and grouped as they read. */
	export type PhoneInputProps = { value: Json; onChange(next: Json): void; id?: string; disabled?: boolean; invalid?: boolean };
</script>

<script lang="ts">
	import Combobox from '../primitives/combobox/combobox.svelte';
	import { COUNTRY_CODES, flagOf } from '../primitives/country-picker/country-picker.svelte';
	import Input from '../primitives/input/input.svelte';
	import { uiText } from '../primitives/utils.js';
	import { useKinds } from './context.js';
	import { callingCode, groupDigits, regionOf, splitPhone, toE164 } from './phone.js';

	let { value, onChange, id, disabled = false, invalid = false }: PhoneInputProps = $props();
	const host = useKinds();
	const t = uiText();
	const home = regionOf(host.locale);
	const options = $derived.by(() => {
		const names = new Intl.DisplayNames([host.locale ?? 'en'], { type: 'region' });
		return COUNTRY_CODES.flatMap((r) => {
			const code = callingCode(r);
			const name = names.of(r) ?? r;
			return code === undefined ? [] : [{ value: r, label: `${flagOf(r)} +${code}`, description: name, keywords: `${name} ${r} ${code}` }];
		}).sort((a, b) => a.description.localeCompare(b.description));
	});

	let region = $state(home), text = $state(''), blurred = $state(false);
	let last: Json | undefined;
	$effect.pre(() => {
		// an outside value (reset, refusal) replaces the draft; our own echo does not
		if (value === last) return;
		last = value;
		const p = typeof value === 'string' ? splitPhone(value, region) : null;
		if (p !== null) region = p.region;
		text = p !== null ? groupDigits(p.national) : typeof value === 'string' ? value : '';
		blurred = false;
	});
	const bad = $derived(blurred && text.trim() !== '' && toE164(text, region) === null);

	function emit() {
		const digits = text.replace(/\D/g, '');
		// an incomplete number is still written, as typed, so the field's own check names it
		last = digits === '' ? null : toE164(text, region) ?? (text.trim().startsWith('+') ? `+${digits}` : `+${callingCode(region) ?? ''}${digits}`);
		onChange(last);
	}
	function typed(next: string) {
		// a typed or pasted "+…" picks the region from its calling code; the digits keep the viewer's own spacing until blur
		const p = splitPhone(next, region);
		if (p !== null) region = p.region;
		text = p !== null ? p.national : next.replace(/[^\d\s()+-]/g, '');
		emit();
	}
	function blur() {
		blurred = true;
		if (!text.trim().startsWith('+')) text = groupDigits(text.replace(/\D/g, ''));
	}
</script>

<div class="grid min-w-0 gap-1.5">
	<div class="flex min-w-0">
		<Combobox
			{options}
			value={region}
			onChange={(r) => { if (r !== null) { region = r; if (text.trim() !== '') emit(); } }}
			searchable
			{disabled}
			aria-label={t('countryCode')}
			class="w-28 shrink-0 rounded-r-none border-r-0 font-mono text-xs tabular-nums"
		/>
		<Input
			{id}
			type="tel"
			inputmode="tel"
			autocomplete="tel"
			value={text}
			oninput={(e) => typed(e.currentTarget.value)}
			onblur={blur}
			{disabled}
			aria-invalid={invalid || bad ? 'true' : undefined}
			class="min-w-0 rounded-l-none font-mono tabular-nums"
		/>
	</div>
	{#if bad}<p class="text-xs text-destructive" role="alert">{t('invalidPhone')}</p>{/if}
</div>
