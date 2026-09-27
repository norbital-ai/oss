<!--
@component
The built-in `phone` custom field's renderer: calling code and number when edited, a formatted `tel:` link when shown.
-->
<script lang="ts">
	import CopyText from '../../primitives/copy-text/copy-text.svelte';
	import type { CustomFieldView } from '../context.js';
	import PhoneInput from '../phone-input.svelte';
	import { formatPhone } from '../phone.js';

	let { view }: { view: CustomFieldView } = $props();
	const raw = $derived(typeof view.value === 'string' ? view.value : '');
</script>

{#snippet link()}
	<a class="tabular-nums underline-offset-2 hover:underline" href={`tel:${raw.replace(/[^\d+]/g, '')}`}>{formatPhone(raw)}</a>
{/snippet}

{#if view.mode === 'edit'}
	<PhoneInput value={view.value} onChange={view.onChange} id={view.id} disabled={view.disabled} invalid={view.error !== undefined} />
{:else if view.dense}
	{@render link()}
{:else}
	<!-- the stored E.164 is what is copied: it dials from anywhere -->
	<CopyText id={view.id} text={raw}>{@render link()}</CopyText>
{/if}
