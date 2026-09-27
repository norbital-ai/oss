<!--
@component
The built-in `money` custom field's renderer: the amount box with its currency affix, grouped tabular figures when shown.
-->
<script lang="ts">
	import CopyText from '../../primitives/copy-text/copy-text.svelte';
	import { useKinds, type CustomFieldView } from '../context.js';
	import { currencyOf, format, type KindOf } from '../kind.js';
	import MoneyInput from '../money-input.svelte';

	let { view }: { view: CustomFieldView } = $props();
	const host = useKinds();
	const kind = $derived<KindOf<'money'>>(view.kind?.kind === 'money' ? view.kind : { kind: 'money' });
	const currency = $derived(currencyOf(kind, view.row ?? {}, host.currency));
	const text = $derived(format(kind, view.value, { locale: host.locale, ...(currency === undefined ? {} : { currency }) }));
</script>

{#if view.mode === 'edit'}
	<MoneyInput value={view.value} onChange={view.onChange} {currency} id={view.id} disabled={view.disabled} invalid={view.error !== undefined} />
{:else if view.dense}
	<span class="tabular-nums">{text}</span>
{:else}
	<CopyText id={view.id} {text} class="tabular-nums" />
{/if}
