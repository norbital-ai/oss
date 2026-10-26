<!--
@component
Shows any stored or input value by its kind; readonly form values stay copyable.
-->
<script lang="ts" module>
	import { Array as Arr } from 'effect';
	import type { Value, Kind } from './kind.js';

	/** A value and its declared kind, with optional row/relation context for labels and currency; readonly output remains copyable and masked values stay hidden. */
	export type ShowProps = {
		kind: Kind;
		value: Value | undefined;
		name?: string;
		row?: { readonly [field: string]: Value };
		class?: string;
		readonly?: boolean;
		relation?: { targets: readonly string[] };
		address?: string;
		id?: string;
	};
</script>

<script lang="ts">
	import { Decimal } from '@norbital-ai/std/decimal';
	import { Schema } from 'effect';
	import { inputSchema } from '@norbital-ai/std/kind';
	import { useEnumText } from '../collection/context.js';
	import Badge from '../primitives/badge/badge.svelte';
	import CopyText from '../primitives/copy-text/copy-text.svelte';
	import ReadonlyMarkdown from '../editors/readonly-markdown.svelte';
	import CodeEditor from '../editors/code-editor.svelte';
	import Icon from '@iconify/svelte';
	import { cn, uiText } from '../primitives/utils.js';
	import { fieldEntry } from './builtin/index.js';
	import { useKinds } from './context.js';
	import { arcOf, currencyOf, format, isMasked, shownKind } from './kind.js';
	import { KINDS } from './registry.js';
	import Self from './show.svelte';
	import StateBadge from './state-badge.svelte';
	import StructuredData from './structured-data.svelte';
	import { isJsonSchemaDocument } from './json-schema.js';
	import Picker from './picker.svelte';

	let {
		kind: declared,
		value,
		name = '',
		row = {},
		class: className,
		readonly = false,
		relation,
		address,
		id
	}: ShowProps = $props();
	const host = useKinds();
	const t = uiText();
	const words = useEnumText();
	const kind = $derived(shownKind(declared));
	const v = $derived(value ?? null);
	const text = $derived(
		format(kind, value, {
			locale: host.locale,
			zone: host.zone,
			currency: kind.kind === 'money' ? currencyOf(kind, row, host.currency) : undefined
		})
	);
	const field = $derived(fieldEntry(kind, host));
	const shape = $derived(
		kind.kind === 'custom' && field?.entry.renderer === undefined
			? field?.entry.shape
			: kind.kind === 'json'
				? kind.shape
				: kind.kind === 'union' && 'of' in kind
					? kind.of.find((arm) => Schema.is(inputSchema(arm))(value))
					: undefined
	);
	const object = $derived(
		typeof v === 'object' && v !== null && !Arr.isArray<Value>(v) && !(v instanceof Decimal)
			? v
			: null
	);
	const numeric = $derived(KINDS[kind.kind].numeric);
</script>

{#snippet inline()}
	{#if kind.kind === 'text' && kind.format === 'email'}
		<a class={cn('underline-offset-2 hover:underline', className)} href={`mailto:${text}`}>{text}</a
		>
	{:else if kind.kind === 'text' && kind.format === 'url'}
		<a
			class={cn('underline-offset-2 hover:underline', className)}
			href={text}
			target="_blank"
			rel="noopener">{text}</a
		>
	{:else}
		<span class={cn(numeric && 'tabular-nums', className)}>{text}</span>
	{/if}
{/snippet}

{#if v === null || isMasked(v) || (readonly && Arr.isArray<Value>(v) && v.length === 0)}
	<span {id} class={cn('text-muted-foreground', className)}>{isMasked(v) ? '•••' : t('none')}</span>
{:else if readonly && (relation !== undefined || kind.kind === 'id')}
	{@const arc = arcOf(v)}
	<Picker
		of={arc?.collection ?? relation?.targets[0] ?? (kind.kind === 'id' ? kind.of : '')}
		value={arc?.id ?? String(v)}
		onChange={() => {}}
		{id}
		readonly
	/>
{:else if kind.kind === 'state' && typeof v === 'string'}
	<StateBadge state={v} label={words(v, name)} class={className} />
{:else if kind.kind === 'enum' && (typeof v === 'string' || Arr.isArray<Value>(v))}
	<span {id} class={cn('inline-flex flex-wrap gap-1', className)} data-enum-list>
		{#each Arr.isArray<Value>(v) ? v.map(String) : [v] as item (item)}<Badge
				variant="outline"
				class="font-medium"
				data-enum-value={item}>{words(item, name)}</Badge
			>{/each}
	</span>
{:else if kind.kind === 'text' && kind.format === 'markdown' && typeof v === 'string'}
	<ReadonlyMarkdown value={v} {id} class={className} />
{:else if kind.kind === 'text' && kind.format === 'cel' && typeof v === 'string'}
	{#if readonly}<CodeEditor
			{id}
			language="javascript"
			wrap
			readonly
			minHeight="2.25rem"
			value={v}
			aria-label={name}
		/>
	{:else}<code class={cn('font-mono text-xs whitespace-pre-wrap wrap-anywhere', className)} data-cel
			>{v}</code
		>{/if}
{:else if kind.kind === 'bool'}
	{#if readonly}<CopyText {id} text={v === true ? t('yes') : t('no')} />
	{:else}<Icon
			icon={v ? 'lucide:check' : 'lucide:x'}
			class={cn('size-4', v ? 'text-success' : 'text-muted-foreground', className)}
			aria-label={v ? t('yes') : t('no')}
		/>{/if}
{:else if field?.entry.renderer}
	{@const Renderer = field.entry.renderer}
	{@const where = address === undefined ? null : (row[address] ?? null)}
	<span {id} class={cn('min-w-0', readonly && 'text-sm', className)}
		><Renderer
			view={{
				mode: 'show',
				...(readonly ? {} : { dense: true as const }),
				name,
				value: v,
				row,
				kind: field.kind,
				...(address === undefined
					? {}
					: { address: { value: typeof where === 'string' ? where : null } })
			}}
		/></span
	>
{:else if shape !== undefined}
	<div {id} class={cn('min-w-0', className)}>
		<StructuredData kind={shape} value={v} mode="view" {name} {row} />
	</div>
{:else if kind.kind === 'union' && 'arms' in kind && object !== null}
	{@const arm = kind.arms[String(object[kind.by])] ?? {}}
	<Self
		kind={{ kind: 'object', fields: { [kind.by]: { kind: 'text' }, ...arm } }}
		value={v}
		{name}
		{row}
		{readonly}
		{id}
		class={className}
	/>
{:else if ((kind.kind === 'object' || kind.kind === 'record') && object !== null) || (kind.kind === 'list' && Arr.isArray<Value>(v))}
	<div {id} class={cn('min-w-0', className)}>
		<StructuredData {kind} value={v} mode="view" {name} {row} />
	</div>
{:else if kind.kind === 'json' && isJsonSchemaDocument(v)}
	<StructuredData schema={v} mode="schema" {name} {id} />
{:else if kind.kind === 'json' || kind.kind === 'custom'}
	<div {id} class={cn('min-w-0', className)}>
		<StructuredData value={v} mode="view" {name} {row} />
	</div>
{:else if readonly}
	<CopyText {id} {text} class={numeric ? 'tabular-nums' : undefined}>{@render inline()}</CopyText>
{:else}
	{@render inline()}
{/if}
