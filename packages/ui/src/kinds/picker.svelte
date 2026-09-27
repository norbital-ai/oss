<script lang="ts" module>
	import type { Json } from './kind.js';
	import type { CollectionKey, FieldOf, IdOf, OrderByOf, WhereOf } from '../views/bolt.js';

	/**
	 * Edits a relation or an `id` input (§3.6): searches the target collection through the caller's own read grant, so
	 * it lists only rows (and fields) the viewer may read. `label` defaults to the target model's `label`; a target
	 * without `search` is searched over its label's text and patterned `seq` fields. Each keystroke is a server search,
	 * so `limit` is the page shown, never the rows searched; rows sort by `orderBy`, else by the label.
	 */
	export type PickerProps<C = CollectionKey> = {
		of: C;
		/** The chosen id; any text is shown as not found, never trusted. */
		value: string | null;
		onChange(next: IdOf<C> | null): void;
		label?: readonly FieldOf<C>[];
		where?: WhereOf<C>;
		orderBy?: OrderByOf<C>;
		limit?: number;
		id?: string;
		/** Shows the chosen row's label as copyable text; an enclosing readonly form sets it. */
		readonly?: boolean;
		disabled?: boolean;
		invalid?: boolean;
	};
</script>

<script lang="ts">
	import Combobox from '../primitives/combobox/combobox.svelte';
	import CopyText from '../primitives/copy-text/copy-text.svelte';
	import Input from '../primitives/input/input.svelte';
	import { label as title } from '@norbital-ai/std/label';
	import { uiText, useControls } from '../primitives/utils.js';
	import { useKinds } from './context.js';
	import { currencyOf, format, pickerRead } from './kind.js';

	let { of, value, onChange, label, where, orderBy, limit = 20, id, readonly, disabled, invalid = false }: PickerProps = $props();
	const controls = useControls();
	const host = useKinds();
	const target = $derived(host.catalog?.[of]);
	const labels = $derived(label ?? target?.label ?? []);
	type Hit = { id: string; text: string };
	const t = uiText();
	// the record's title per kind (std/label): never its uuid; a row that cannot name itself reads as `none`
	const textOf = (row: { readonly [f: string]: Json }) => title(row, labels, (f, v) => {
		const kind = target?.fields[f];
		return kind === undefined ? String(v) : format(kind, v, { locale: host.locale, zone: host.zone, currency: kind.kind === 'money' ? currencyOf(kind, row, host.currency) : undefined });
	}) ?? t('none');
	const select = $derived(Object.fromEntries([['id', true], ...labels.map((f) => [f, true])]));

	let query = $state(''), hits = $state<Hit[]>([]), loading = $state(false), current = $state<Hit | null>(null);
	async function load(q: string) {
		if (host.read === undefined) return;
		loading = true;
		try {
			const page = await host.read(of, pickerRead(target, labels, { where, orderBy, limit }, q));
			if (q === query) hits = page.rows.map((r) => ({ id: String(r['id']), text: textOf(r) }));
		} catch {
			hits = [];
		} finally {
			loading = false;
		}
	}
	// the chosen row's label, read once per value
	$effect(() => {
		const v = value;
		if (v === null || host.read === undefined) { current = null; return; }
		if (current?.id === v) return;
		host.read(of, { select, limit: 1, where: { id: { eq: v } } }).then((p) => {
			if (value === v) current = { id: v, text: p.rows[0] === undefined ? t('notFound') : textOf(p.rows[0]) };
		}, () => (current = { id: v, text: t('notFound') }));
	});
	let timer: ReturnType<typeof setTimeout> | undefined;
	function type(q: string) {
		query = q;
		clearTimeout(timer);
		timer = setTimeout(() => void load(q), q === '' ? 0 : 250);
	}
</script>

{#if readonly ?? controls.readonly}
	<!-- the row's label, never its id; nothing while the label loads -->
	<CopyText {id} text={value === null ? '' : (current?.text ?? '')}>
		{#if value === null}<span class="text-muted-foreground">{t('none')}</span>{:else}{current?.text ?? (host.read === undefined ? value : '')}{/if}
	</CopyText>
{:else if host.read === undefined}
	<!-- no client above: an id is typed -->
	<Input {id} value={value ?? ''} oninput={(e) => onChange(e.currentTarget.value.trim() || null)} {readonly} {disabled} aria-invalid={invalid ? 'true' : undefined} />
{:else}
	<!-- the list floats in a portal: a picker in a clipped header or a scroller still opens over the page -->
	<Combobox
		{id}
		{readonly}
		{disabled}
		{invalid}
		{loading}
		clearable
		options={hits.map((h) => ({ value: h.id, label: h.text }))}
		{value}
		display={current?.text}
		onSearch={type}
		onChange={(next) => { current = hits.find((h) => h.id === next) ?? null; onChange(next); }}
	/>
{/if}
