<!--
@component
A phone number: a country calling-code picker (flag and code) joined to the number box; the value is E.164.
-->
<script lang="ts" module>
	import type { UiContext } from '../client/contract.js';
	import type { Value } from './kind.js';

	/** A phone number (E.164, `+6591234567`): the calling code is picked, the national digits typed and grouped as they read. */
	export type PhoneInputProps = {
		/** The page context (`ctx`), passed whole. */
		ctx: UiContext;
		/** The E.164 number; `null` when empty. The region starts at the viewer's locale. */
		value: Value;
		/** Called on every keystroke; an incomplete number is still written (as `+` and its digits) so the field's check names it. */
		on_change(next: Value): void;
		/** The id on the number box, for `<label for>`. */
		id?: string;
		/** Disables both the code picker and the number box. */
		disabled?: boolean;
		/** Marks the number box invalid. */
		invalid?: boolean;
	};
</script>

<script lang="ts">
	import { untrack } from 'svelte';
	import { watch } from 'runed';
	import Combobox from '../primitives/combobox/combobox.svelte';
	import { COUNTRY_CODES, flagOf } from '../primitives/country-picker/country-picker.svelte';
	import Input from '../primitives/input/input.svelte';
	import { ui_text } from '../primitives/utils.js';
	import { callingCode, groupDigits, regionOf, splitPhone, toE164 } from './phone.js';

	let { ctx, value, on_change, id, disabled = false, invalid = false }: PhoneInputProps = $props();
	const host = $derived(ctx.ui.kinds);
	const t = ui_text();
	const home = $derived(regionOf(host.locale));
	const options = $derived.by(() => {
		const names = new Intl.DisplayNames([host.locale ?? 'en'], { type: 'region' });
		return COUNTRY_CODES.flatMap((r) => {
			const code = callingCode(r);
			const name = names.of(r) ?? r;
			return code === undefined
				? []
				: [
						{
							value: r,
							label: `${flagOf(r)} +${code}`,
							description: name,
							keywords: `${name} ${r} ${code}`
						}
					];
		}).sort((a, b) => a.description.localeCompare(b.description));
	});

	let region = $state(untrack(() => home)),
		text = $state(''),
		blurred = $state(false);
	let last: Value | undefined;
	watch.pre(
		// an outside value (reset, refusal) replaces the draft; our own echo does not
		() => value === last ? null : {
			value,
			parsed: typeof value === 'string' ? splitPhone(value, region) : null
		},
		(next) => {
			if (next === null) return;
			last = next.value;
			if (next.parsed !== null) region = next.parsed.region;
			text = next.parsed !== null
				? groupDigits(next.parsed.national)
				: typeof next.value === 'string' ? next.value : '';
			blurred = false;
		}
	);
	const bad = $derived(blurred && text.trim() !== '' && toE164(text, region) === null);

	function emit() {
		const digits = text.replace(/\D/g, '');
		// an incomplete number is still written, as typed, so the field's own check names it
		last =
			digits === ''
				? null
				: (toE164(text, region) ??
					(text.trim().startsWith('+') ? `+${digits}` : `+${callingCode(region) ?? ''}${digits}`));
		on_change(last);
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
			on_change={(r) => {
				if (r !== null) {
					region = r;
					if (text.trim() !== '') emit();
				}
			}}
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
