<!--
@component
An exact money amount in `currency`: the currency as the box's leading affix, the amount typed plain and shown grouped in
the currency's minor digits once the box loses focus. Kept as a decimal string, never a float.
-->
<script lang="ts" module>
	import type { Json } from './kind.js';

	/** An exact amount (a decimal string, never a float) in `currency`, typed to at most its minor digits (or `scale`). */
	export type MoneyInputProps = { value: Json; onChange(next: Json): void; currency?: string; scale?: number; id?: string; readonly?: boolean; disabled?: boolean; invalid?: boolean };
</script>

<script lang="ts">
	import { COUNTRY_CODES, flagOf } from '../primitives/country-picker/country-picker.svelte';
	import { cn, useControls } from '../primitives/utils.js';
	import { CONTROL } from './classes.js';
	import { useKinds } from './context.js';
	import CopyText from '../primitives/copy-text/copy-text.svelte';
	import { format, minorDigits, moneyProblem, untag } from './kind.js';

	let { value, onChange, currency, scale, id, readonly, disabled, invalid = false }: MoneyInputProps = $props();
	const controls = useControls();
	const host = useKinds();
	const off = $derived(disabled ?? controls.disabled);
	const minor = $derived(currency === undefined ? undefined : minorDigits(currency));
	const digits = $derived(scale ?? minor);
	const problem = $derived(value === null ? null : moneyProblem(String(untag(value)), currency, scale));
	// ISO 4217 codes lead with their country's (EUR's is the EU's)
	const flag = $derived(currency !== undefined && (COUNTRY_CODES.includes(currency.slice(0, 2)) || currency.startsWith('EU')) ? flagOf(currency.slice(0, 2)) : '');

	let text = $state(''), focused = $state(false);
	let last: Json | undefined;
	$effect.pre(() => {
		// an outside change (reset, refusal, a transform's echo) replaces the text; our own echo does not
		if (value !== last) { text = value === null ? '' : String(untag(value)); last = value; }
	});
	// grouped in the viewer's locale and padded to the minor digits, except while typed
	const shown = $derived(focused || text === '' || !/^-?\d+(\.\d+)?$/.test(text) ? text
		: format({ kind: 'decimal', scale: digits ?? 0 }, text, { locale: host.locale }));

	function input(raw: string) {
		// digits, one leading minus, one point, at most the currency's minor digits (staging's money input)
		const clean = raw.replace(/[^\d.-]/g, '').replace(/(?!^)-/g, '').replace(/(\..*)\./g, '$1');
		const [whole, fraction] = clean.split('.');
		text = fraction === undefined || digits === undefined ? clean : digits === 0 ? whole! : `${whole}.${fraction.slice(0, digits)}`;
		// a half-typed "1." or "-" never reaches the draft as a wrong amount
		const next = /^-?\d+(\.\d+)?$/.test(text) ? text : text === '' ? null : undefined;
		if (next !== undefined) { last = next; onChange(next); }
	}
</script>

{#if readonly ?? controls.readonly}
	{@const read = format({ kind: 'money' }, value, { locale: host.locale, ...(currency === undefined ? {} : { currency }) })}
	<CopyText {id} text={read} class="tabular-nums" />
{:else}
	<div
		class={cn(CONTROL, 'flex items-center gap-0 px-0 font-normal focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50 focus-within:ring-inset', off && 'cursor-not-allowed bg-muted opacity-50', (invalid || problem !== null) && 'border-destructive')}
	>
		{#if currency}
			<span class="flex h-full shrink-0 items-center gap-1 border-r border-input px-2.5 text-xs font-medium text-muted-foreground tabular-nums">
				{#if flag}<span aria-hidden="true">{flag}</span>{/if}{currency}
			</span>
		{/if}
		<input
			{id}
			type="text"
			inputmode="decimal"
			autocomplete="off"
			class="h-full min-w-0 flex-1 bg-transparent px-3 tabular-nums outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
			placeholder={minor === undefined || minor === 0 ? '0' : `0.${'0'.repeat(minor)}`}
			value={shown}
			disabled={off}
			aria-invalid={invalid || problem !== null ? 'true' : undefined}
			onfocus={() => (focused = true)}
			onblur={() => (focused = false)}
			oninput={(e) => input(e.currentTarget.value)}
		/>
	</div>
	{#if problem}<p class="text-xs text-destructive">{problem}</p>{/if}
{/if}
