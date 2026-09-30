<script lang="ts">
	// One stored value, read-only: by its kind through the kit's `Show` when the catalog knows the field, else by shape
	// (files open through `/files`, where the viewer's read grant decides; a mask shows locked).
	import Show from '../kinds/show.svelte';
	import type { Kind } from '../kinds/kind.js';
	import * as Popover from '../primitives/popover/index.js';
	import type { Json, Row } from './bolt.js';
	import { openRecord, useBolt } from './bolt.js';
	import Glyph from './Glyph.svelte';
	import { filesOf, isMasked, msg, show, type Ref } from './model.js';

	/** `ref`: a relation's target and label (`unref`), shown as a link opening that record (`?record=`); a many-relation
	 * shows its first label and a "+N" chip listing the rest. The glyph tells one link from many.
	 * `dense` (a table cell, a card): one line — a structured value (json, object, list) previews as one line of JSON.
	 * `name` reaches a custom field's renderer. */
	let { value, kind, row, ref, name, dense = false }: { value: Json | undefined; kind?: Kind | undefined; row?: Row; ref?: Ref | undefined; name?: string; dense?: boolean } = $props();
	const bolt = useBolt();
	const files = $derived(filesOf(value ?? null));
	const structured = (k: Kind) => ['json', 'object', 'list', 'record', 'union'].includes(k.kind);
</script>

{#snippet link(of: string, id: string, text: string)}
	<button type="button" class="text-primary max-w-full truncate text-left underline-offset-4 hover:underline" data-ref-open={id}
		onclick={(e) => { e.stopPropagation(); openRecord(of, id); }}>{text}</button>
{/snippet}

{#if ref?.items !== undefined}
	{@const [first, ...rest] = ref.items}
	{#if first}
		<span class="inline-flex max-w-full min-w-0 items-center gap-1 align-middle" data-ref="many" title={ref.text}>
			<Glyph name="links" class="text-muted-foreground size-3 shrink-0" />
			{@render link(ref.of, first.id, first.text)}
			{#if rest.length > 0}
				<Popover.Root>
					<Popover.Trigger class="bg-muted text-muted-foreground hover:text-foreground shrink-0 rounded-full px-1.5 text-xs leading-5 tabular-nums max-sm:min-h-6"
						aria-label={msg(bolt, 'table.moreLinks', 'Show all {n} linked', { n: ref.items.length })} data-ref-more onclick={(e: MouseEvent) => e.stopPropagation()}>+{rest.length}{ref.more ? '+' : ''}</Popover.Trigger>
					<Popover.Content align="start" class="flex max-h-72 w-60 flex-col gap-0.5 overflow-auto p-1.5 text-xs" data-ref-list>
						{#each ref.items as it (it.id)}
							<span class="hover:bg-accent flex min-w-0 rounded-sm px-2 py-1.5">{@render link(ref.of, it.id, it.text)}</span>
						{/each}
						{#if ref.more}<p class="text-muted-foreground px-2 py-1">{msg(bolt, 'table.moreLinked', 'And more — open the record to see all')}</p>{/if}
					</Popover.Content>
				</Popover.Root>
			{/if}
		</span>
	{/if}
{:else if ref !== undefined && typeof value === 'string'}
	<span class="inline-flex max-w-full min-w-0 items-center gap-1 align-middle" data-ref="one">
		<Glyph name="link" class="text-muted-foreground size-3 shrink-0" />{@render link(ref.of, value, ref.text)}
	</span>
{:else if kind === undefined && (value === null || value === undefined)}
	<span class="text-muted-foreground">—</span>
{:else if kind?.kind === 'text' && kind.format === 'markdown' && dense && typeof value === 'string'}
	<!-- one line of a stored document: its text, the prose is the record's -->
	{value}
{:else if kind !== undefined && dense && structured(kind) && !isMasked(value) && value !== null && value !== undefined}
	<code class="text-muted-foreground block truncate font-mono text-xs" data-json-preview>{JSON.stringify(value)}</code>
{:else if kind !== undefined || typeof value === 'boolean'}
	<!-- a boolean without a catalog kind (a local array's column) is still a check or a cross, not a glyph in text -->
	<Show kind={kind ?? { kind: 'bool' }} {value} {...row === undefined ? {} : { row }} {...name === undefined ? {} : { name }} />
{:else if isMasked(value)}
	<span class="text-muted-foreground" title="restricted" aria-label="restricted">•••</span>
{:else if files.length > 0}
	{#each files as f (f.id)}
		<a class="text-primary mr-2 underline-offset-4 hover:underline" href={bolt.fileUrl(f)} target="_blank" rel="noopener">{f.name}</a>
	{/each}
{:else}
	{show(value, bolt.locale)}
{/if}
