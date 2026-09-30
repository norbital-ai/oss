<!--
@component
Shows any stored or input value read-only, formatted by its field kind.
@example
<Show kind={{ kind: 'money' }} value={row.amount} {row} name="amount" />
-->
<script lang="ts" module>
	import type { Json, Kind } from './kind.js';

	/** One stored or input value, read-only, by its kind (§3.6 `Show`): any value a row holds. */
	export type ShowProps = {
		kind: Kind;
		value: unknown;
		/** The field's name, for a custom field's renderer. */
		name?: string;
		/** The row, for a money field whose currency is a sibling field. */
		row?: { readonly [f: string]: unknown };
		class?: string;
	};
</script>

<script lang="ts">
	import { useEnumText } from '../views/bolt.js';
	import { humanize } from '../views/model.js';
	import Badge from '../primitives/badge/badge.svelte';
	import ReadonlyMarkdown from '../editors/readonly-markdown.svelte';
	import Icon from '@iconify/svelte';
	import { cn, uiText } from '../primitives/utils.js';
	import { fieldEntry } from './builtin/index.js';
	import { useKinds } from './context.js';
	import { currencyOf, format, isMasked, NUMERIC, shownKind, untag } from './kind.js';
	import Self from './show.svelte';
	import StateBadge from './state-badge.svelte';

	let { kind: declared, value, name = '', row = {}, class: className }: ShowProps = $props();
	const host = useKinds();
	const t = uiText();
	const words = useEnumText();
	// a sum of a money field reads as that money
	const kind = $derived(shownKind(declared));
	const v = $derived(untag(value));
	const text = $derived(format(kind, value, {
		locale: host.locale, zone: host.zone,
		currency: kind.kind === 'money' ? currencyOf(kind, row, host.currency) : undefined
	}));
	// money, file, point and phone show through their built-in custom field, a tenant's custom field through its own
	const field = $derived(fieldEntry(kind, host));
	const custom = $derived(kind.kind === 'custom' ? field?.entry : undefined);
	const isObj = (x: Json): x is { readonly [k: string]: Json } => typeof x === 'object' && x !== null && !Array.isArray(x);
</script>

{#if v === null || isMasked(value)}
	<span class={cn('text-muted-foreground', className)}>{isMasked(value) ? '•••' : t('none')}</span>
{:else if kind.kind === 'state' && typeof v === 'string'}
	<StateBadge state={v} label={words(v, name)} class={className} />
{:else if kind.kind === 'enum' && (typeof v === 'string' || Array.isArray(v))}
	<!-- a plain enum or tag is a neutral chip; only a state is coloured -->
	<span class={cn('inline-flex flex-wrap gap-1', className)} data-enum-list>
		{#each Array.isArray(v) ? v.map(String) : [v] as item (item)}<Badge variant="outline" class="font-medium" data-enum-value={item}>{words(item, name)}</Badge>{/each}
	</span>
{:else if kind.kind === 'text' && kind.format === 'markdown' && typeof v === 'string'}
	<ReadonlyMarkdown value={v} class={className} />
{:else if kind.kind === 'bool'}
	<Icon icon={v ? 'lucide:check' : 'lucide:x'} class={cn('size-4', v ? 'text-success' : 'text-muted-foreground', className)} aria-label={v ? t('yes') : t('no')} />
{:else if field?.entry.renderer}
	{@const Renderer = field.entry.renderer}
	<span class={cn('min-w-0', className)}><Renderer view={{ mode: 'show', dense: true, name, value: v, row: row as { readonly [f: string]: Json }, kind: field.kind }} /></span>
{:else if kind.kind === 'text' && kind.format === 'email'}
	<a class={cn('underline-offset-2 hover:underline', className)} href={`mailto:${text}`}>{text}</a>
{:else if kind.kind === 'text' && kind.format === 'url'}
	<a class={cn('underline-offset-2 hover:underline', className)} href={text} target="_blank" rel="noopener">{text}</a>
{:else if (kind.kind === 'custom' && custom) || (kind.kind === 'json' && kind.shape)}
	<Self kind={kind.kind === 'custom' ? custom!.shape : (kind as { shape: Kind }).shape} value={v} {name} {row} class={className} />
{:else if kind.kind === 'object' && isObj(v)}
	<dl class={cn('grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm', className)}>
		{#each Object.entries(kind.fields).filter(([, k]) => !k.hidden) as [f, k] (f)}
			<dt class="text-muted-foreground">{k.label ?? humanize(f)}</dt>
			<dd class="min-w-0"><Self kind={k} value={v[f]} name={f} row={v} /></dd>
		{/each}
	</dl>
{:else if kind.kind === 'union' && isObj(v)}
	{@const arm = kind.arms[String(v[kind.by])] ?? {}}
	<Self kind={{ kind: 'object', fields: { [kind.by]: { kind: 'text' }, ...arm } }} value={v} {name} class={className} />
{:else if (kind.kind === 'list' && Array.isArray(v))}
	<ul class={cn('grid gap-1', className)}>
		{#each v as item, i (i)}<li><Self kind={kind.of} value={item} {name} /></li>{/each}
	</ul>
{:else if kind.kind === 'record' && isObj(v)}
	<Self kind={{ kind: 'object', fields: Object.fromEntries(Object.keys(v).map((k) => [k, kind.of])) }} value={v} {name} class={className} />
{:else if kind.kind === 'json'}
	<pre class={cn('max-h-64 overflow-auto rounded-sm bg-muted p-2 text-xs', className)}>{JSON.stringify(v, null, 2)}</pre>
{:else}
	<span class={cn(NUMERIC.has(kind.kind) && 'tabular-nums', className)}>{text}</span>
{/if}
