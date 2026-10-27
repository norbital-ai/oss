<script lang="ts">
	import { formatValue as show, format, inferKind, currencyOf } from '../kinds/kind.js';
	// One stored value, read-only: by its kind through the kit's `Show` when the catalog knows the field, else by shape
	// (files open through `/files`, where the viewer's read grant decides; a mask shows locked).
	import Show from '../kinds/show.svelte';
	import StructuredData from '../kinds/structured-data.svelte';
	import { dataEntries } from '../kinds/structured-data.js';
	import { isJsonSchemaDocument } from '../kinds/json-schema.js';
	import { useKinds } from '../kinds/context.js';
	import { fieldEntry } from '../kinds/builtin/index.js';
	import { fill, humanize } from '../text/messages.js';
	import type { Kind } from '../kinds/kind.js';
	import * as Popover from '../primitives/popover/index.js';
	import type { Values } from '../model/types.js';
	import { openRecord } from '../record/navigation.js';
	import { useOptionalBolt } from '../client/context.js';
	import Glyph from '../primitives/icon/Glyph.svelte';
	import { filesOf, isMasked } from './value.js';
	import { msg } from '../text/messages.js';
	import { type Ref } from '../relations/select.js';

	/** `ref`: a relation's target and label (`unref`), shown as a link opening that record (`?record=`); a many-relation
	 * shows its first label and a "+N" chip listing the rest. The glyph tells one link from many.
	 * `dense` (a table cell, a card): a structured value previews its fields and opens the same structured renderer.
	 * `name` reaches a custom field's renderer. `link={false}` (a row's title, which opens the row itself) shows a relation as
	 * text, so a tap on the title never lands on the related record instead. */
	let {
		value,
		kind,
		row,
		ref,
		name,
		dense = false,
		link: linked = true
	}: {
		value: import('@norbital-ai/std/kind').Value | undefined;
		kind?: Kind | undefined;
		row?: Values;
		ref?: Ref | undefined;
		name?: string;
		dense?: boolean;
		link?: boolean;
	} = $props();
	const bolt = useOptionalBolt();
	const text = (
		key: string,
		fallback: string,
		vars: { readonly [name: string]: string | number } = {}
	) => (bolt === undefined ? fill(fallback, vars) : msg(bolt, key, fallback, vars));
	const files = $derived(filesOf(value ?? null));
	const host = useKinds();
	const field = $derived(kind === undefined ? undefined : fieldEntry(kind, host));
	const structured = (k: Kind) => ['json', 'object', 'list', 'record', 'union'].includes(k.kind);
	const inspectKind = $derived(
		kind?.kind === 'json'
			? kind.shape
			: kind?.kind === 'custom' && field?.entry.renderer === undefined
				? field?.entry.shape
				: kind
	);
	const inspectable = $derived(
		dense &&
			value !== null &&
			value !== undefined &&
			!isMasked(value) &&
			field?.entry.renderer === undefined &&
			((inspectKind !== undefined && structured(inspectKind)) ||
				((kind === undefined ||
					kind.kind === 'custom' ||
					(kind.kind === 'json' && kind.shape === undefined)) &&
					files.length === 0 &&
					(Array.isArray(value) || dataEntries(value) !== undefined)))
	);
	function preview(
		held: import('@norbital-ai/std/kind').Value | undefined,
		declared?: Kind,
		depth = 0
	): string {
		if (held === undefined) return 'Not set';
		if (held === null) return 'Null';
		if (isMasked(held)) return '•••';
		let shape = declared;
		const seen = new Set<Kind>();
		for (let level = 0; shape !== undefined; level++) {
			if (level >= 24 || seen.has(shape)) return shape.label ?? 'Details';
			seen.add(shape);
			if (shape.kind === 'json' && shape.shape) {
				shape = shape.shape;
				continue;
			}
			if (shape.kind === 'custom') {
				const registered = fieldEntry(shape, host);
				if (registered?.entry.renderer !== undefined)
					return shape.label ?? registered.entry.label ?? humanize(shape.of);
				if (registered !== undefined) {
					shape = registered.entry.shape;
					continue;
				}
			}
			if (shape.kind === 'union') return shape.label ?? 'Details';
			break;
		}
		if (Array.isArray(held)) {
			if (held.length === 0) return 'Empty list';
			if (depth >= 2) return `${held.length} items`;
			const item = shape?.kind === 'list' ? shape.of : undefined;
			return (
				held
					.slice(0, 2)
					.map((value) => preview(value, item, depth + 1))
					.join(' · ') + (held.length > 2 ? ' …' : '')
			);
		}
		const entries = dataEntries(held);
		if (entries !== undefined) {
			const fields =
				shape?.kind === 'object'
					? Object.entries(shape.fields).filter(([, kind]) => !kind.hidden)
					: Object.keys(entries).map((key): [string, Kind | undefined] => [
							key,
							shape?.kind === 'record' ? shape.of : undefined
						]);
			if (fields.length === 0) return 'Empty object';
			if (depth >= 2) return `${fields.length} fields`;
			return (
				fields
					.slice(0, 2)
					.map(
						([key, kind]) =>
							`${kind?.label ?? humanize(key)}: ${preview(entries[key], kind, depth + 1)}`
					)
					.join(' · ') + (fields.length > 2 ? ' …' : '')
			);
		}
		const native = shape && !['json', 'custom'].includes(shape.kind) ? shape : inferKind(held);
		if (native.kind === 'json') return show(held, host.locale) || 'Empty text';
		return (
			format(native, held, {
				locale: host.locale,
				zone: host.zone,
				currency: native.kind === 'money' ? currencyOf(native, row, host.currency) : host.currency
			}) || 'Empty text'
		);
	}
</script>

{#snippet link(of: string, id: string, text: string)}
	{#if !linked || bolt === undefined}<span class="max-w-full truncate">{text}</span>{:else}<button
			type="button"
			class="text-primary max-w-full truncate text-left underline-offset-4 hover:underline"
			data-ref-open={id}
			onclick={(e) => {
				e.stopPropagation();
				openRecord(of, id);
			}}>{text}</button
		>{/if}
{/snippet}

{#if ref?.items !== undefined}
	{@const [first, ...rest] = ref.items}
	{#if first}
		<span
			class="inline-flex max-w-full min-w-0 items-center gap-1 align-middle"
			data-ref="many"
			title={ref.text}
		>
			<Glyph name="links" class="text-muted-foreground size-3 shrink-0" />
			{@render link(ref.of, first.id, first.text)}
			{#if rest.length > 0}
				<Popover.Root>
					<Popover.Trigger
						class="bg-muted text-muted-foreground hover:text-foreground shrink-0 rounded-full px-1.5 text-xs leading-5 tabular-nums max-sm:min-h-6"
						aria-label={text('table.moreLinks', 'Show all {n} linked', {
							n: ref.items.length
						})}
						data-ref-more
						onclick={(e: MouseEvent) => e.stopPropagation()}
						>+{rest.length}{ref.more ? '+' : ''}</Popover.Trigger
					>
					<Popover.Content
						align="start"
						class="flex max-h-72 w-60 flex-col gap-0.5 overflow-auto p-1.5 text-xs"
						data-ref-list
					>
						{#each ref.items as it (it.id)}
							<span class="hover:bg-accent flex min-w-0 rounded-sm px-2 py-1.5"
								>{@render link(ref.of, it.id, it.text)}</span
							>
						{/each}
						{#if ref.more}<p class="text-muted-foreground px-2 py-1">
								{text('table.moreLinked', 'And more — open the record to see all')}
							</p>{/if}
					</Popover.Content>
				</Popover.Root>
			{/if}
		</span>
	{/if}
{:else if ref !== undefined && typeof value === 'string'}
	<span class="inline-flex max-w-full min-w-0 items-center gap-1 align-middle" data-ref="one">
		{#if linked}<Glyph
				name="link"
				class="text-muted-foreground size-3 shrink-0"
			/>{/if}{@render link(ref.of, value, ref.text)}
	</span>
{:else if kind === undefined && (value === null || value === undefined)}
	<span class="text-muted-foreground">—</span>
{:else if kind?.kind === 'text' && kind.format === 'markdown' && dense && typeof value === 'string'}
	<!-- one line of a stored document: its text, the prose is the record's -->
	{value}
{:else if inspectable}
	<Popover.Root>
		<Popover.Trigger
			class="hover:text-foreground flex max-w-full min-w-0 items-center gap-1 text-left text-muted-foreground"
			aria-label={text('table.inspectValue', 'Inspect {name}', { name: name ?? 'value' })}
			data-structured-preview
			onclick={(event: MouseEvent) => event.stopPropagation()}
		>
			<span class="truncate">{preview(value, inspectKind)}</span>
			<Glyph name="expand" class="size-3 shrink-0" />
		</Popover.Trigger>
		<Popover.Content
			align="start"
			class="max-h-[min(32rem,80vh)] w-[min(44rem,calc(100vw-2rem))] overflow-auto"
			data-structured-inspector
		>
			{#if isJsonSchemaDocument(value)}
				<StructuredData schema={value} mode="schema" {name} />
			{:else}
				<StructuredData kind={inspectKind} {value} mode="view" {name} {row} />
			{/if}
		</Popover.Content>
	</Popover.Root>
{:else if kind !== undefined || typeof value === 'boolean'}
	<!-- a boolean without a catalog kind (a local array's column) is still a check or a cross, not a glyph in text -->
	<Show
		kind={kind ?? { kind: 'bool' }}
		{value}
		{...row === undefined ? {} : { row }}
		{...name === undefined ? {} : { name }}
	/>
{:else if isMasked(value)}
	<span class="text-muted-foreground" title="restricted" aria-label="restricted">•••</span>
{:else if files.length > 0}
	{#each files as f (f.id)}
		{#if bolt === undefined}<span>{f.name}</span>{:else}<a
				class="text-primary mr-2 underline-offset-4 hover:underline"
				href={bolt.fileUrl(f)}
				target="_blank"
				rel="noopener">{f.name}</a
			>{/if}
	{/each}
{:else if dataEntries(value) !== undefined || Array.isArray(value)}
	<StructuredData {value} mode="view" {name} {row} />
{:else}
	{show(value, bolt?.locale ?? host.locale)}
{/if}
