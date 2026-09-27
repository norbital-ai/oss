<!--
@component
A value as a readonly form shows it: plain, copyable text formatted by its kind — refs by the related row's label, enums by
their label, booleans as Yes/No, groups as a label/value grid, empty as an em dash. No field chrome.
-->
<script lang="ts" module>
	import type { Kind } from './kind.js';

	export type ReadValueProps = {
		kind: Kind;
		value: unknown;
		name?: string;
		row?: { readonly [f: string]: unknown };
		/** One-relation target(s), when `kind` is the FK column of a relationship. */
		relation?: { targets: readonly string[] };
		/** A `point` field's address sibling in `row`, shown above its coordinates. */
		address?: string;
		id?: string;
	};
</script>

<script lang="ts">
	import CopyText from '../primitives/copy-text/copy-text.svelte';
	import { uiText } from '../primitives/utils.js';
	import { humanize } from '../views/model.js';
	import { useKinds } from './context.js';
	import { fieldEntry } from './builtin/index.js';
	import { currencyOf, format, isMasked, NUMERIC, untag, type Json } from './kind.js';
	import Picker from './picker.svelte';
	import Self from './read-value.svelte';
	import Show from './show.svelte';

	let { kind, value, name = '', row = {}, relation, address, id }: ReadValueProps = $props();
	const host = useKinds();
	const t = uiText();
	const v = $derived(untag(value));
	// money, file, point and phone read through their built-in custom field, a tenant's custom field through its own
	const field = $derived(fieldEntry(kind, host));
	const custom = $derived(kind.kind === 'custom' ? field?.entry : undefined);
	// a custom field without its own renderer, or a shaped json value, reads as its shape
	const shape = $derived(custom !== undefined && custom.renderer === undefined ? custom.shape : kind.kind === 'json' ? kind.shape : undefined);
	const text = $derived(format(kind, value, {
		locale: host.locale, zone: host.zone,
		currency: kind.kind === 'money' ? currencyOf(kind, row, host.currency) : undefined
	}));
	const isObj = (x: Json): x is { readonly [k: string]: Json } => typeof x === 'object' && x !== null && !Array.isArray(x);
	const numeric = $derived(NUMERIC.has(kind.kind));
</script>

{#if v === null || isMasked(value) || (Array.isArray(v) && v.length === 0)}
	<span {id} class="text-sm text-muted-foreground">{isMasked(value) ? '•••' : t('none')}</span>
{:else if relation !== undefined || kind.kind === 'id'}
	<Picker of={relation?.targets[0] ?? (kind.kind === 'id' ? kind.of : '')} value={String(v)} onChange={() => {}} {id} readonly />
{:else if kind.kind === 'bool'}
	<CopyText {id} text={v === true ? t('yes') : t('no')} />
{:else if kind.kind === 'enum'}
	<CopyText {id} text={(Array.isArray(v) ? v : [v]).map((x) => humanize(String(x))).join(', ')} />
{:else if field?.entry.renderer}
	{@const Renderer = field.entry.renderer}
	{@const where = address === undefined ? null : untag(row[address] ?? null)}
	<div {id} class="min-w-0 text-sm"><Renderer view={{ mode: 'show', name, value: v, row: row as { readonly [f: string]: Json }, kind: field.kind,
		...(address === undefined ? {} : { address: { value: typeof where === 'string' ? where : null } }) }} /></div>
{:else if shape !== undefined}
	<Self kind={shape} {value} {name} {row} {id} />
{:else if kind.kind === 'object' && isObj(v)}
	<dl {id} class="grid grid-cols-1 gap-x-4 gap-y-2 text-sm sm:grid-cols-[minmax(0,max-content)_minmax(0,1fr)] sm:gap-y-1.5">
		{#each Object.entries(kind.fields).filter(([, k]) => !k.hidden) as [f, k] (f)}
			<dt class="text-muted-foreground">{k.label ?? humanize(f)}</dt>
			<dd class="-mt-1.5 min-w-0 sm:mt-0"><Self kind={k} value={v[f]} name={f} row={v} /></dd>
		{/each}
	</dl>
{:else if kind.kind === 'list' && Array.isArray(v)}
	<ul {id} class="grid gap-1">
		{#each v as item, i (i)}<li><Self kind={kind.of} value={item} {name} /></li>{/each}
	</ul>
{:else if ['text', 'int', 'number', 'decimal', 'money', 'sum', 'count', 'duration', 'currency', 'date', 'instant', 'time', 'period'].includes(kind.kind)}
	<!-- email, url and phone keep their links; the plain text is what is copied -->
	<CopyText {id} {text} class={numeric ? 'tabular-nums' : undefined}><Show {kind} {value} {name} {row} /></CopyText>
{:else}
	<!-- files, states, custom renderers, unions, records, untyped json: the kind's own display -->
	<span {id} class="text-sm"><Show {kind} {value} {name} {row} /></span>
{/if}
