<script lang="ts" module>
	import type { Json, Value } from './kind.js';
	import type { CollectionKey, FieldOf, IdOf, OrderByOf, WhereOf } from '../collection/types.js';
	import type { ReadError } from '../client/contract.js';

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
		where?: WhereOf<C> & Json;
		orderBy?: OrderByOf<C> & Json;
		limit?: number;
		id?: string;
		/** Shows the chosen row's label as copyable text; an enclosing readonly form sets it. */
		readonly?: boolean;
		disabled?: boolean;
		invalid?: boolean;
	};
</script>

<script lang="ts" generics="const C extends CollectionKey">
	import Combobox from '../primitives/combobox/combobox.svelte';
	import CopyText from '../primitives/copy-text/copy-text.svelte';
	import Input from '../primitives/input/input.svelte';
	import { label as title } from '@norbital-ai/std/label';
	import { uiText, useControls } from '../primitives/utils.js';
	import { useKinds } from './context.js';
	import { Effect } from 'effect';
	import { query as queryState } from '../effect/index.js';
	import { idsOf } from '../form/form-state.svelte.js';
	import { currencyOf, format, pickerRead } from './kind.js';

	let {
		of,
		value,
		onChange,
		label,
		where,
		orderBy,
		limit = 20,
		id,
		readonly,
		disabled,
		invalid = false
	}: PickerProps<C> = $props();
	const controls = useControls();
	const host = useKinds();
	const target = $derived(host.catalog?.[of]);
	const labels = $derived(label ?? target?.label ?? []);
	type Hit = { id: string; text: string };
	const t = uiText();
	// the record's title per kind (std/label): never its uuid; a row that cannot name itself reads as `none`
	const textOf = (row: { readonly [f: string]: Value }) =>
		title(row, labels, (f, v) => {
			const kind = target?.fields[f];
			return kind === undefined
				? String(v)
				: format(kind, v, {
						locale: host.locale,
						zone: host.zone,
						currency: kind.kind === 'money' ? currencyOf(kind, row, host.currency) : undefined
					});
		}) ?? t('none');
	const select = $derived(Object.fromEntries([['id', true], ...labels.map((f) => [f, true])]));

	let query = $state('');
	const options = queryState<Hit[], ReadError>(() => {
		const read = host.read;
		if (read === undefined) return null;
		const q = query;
		return Effect.sleep(q === '' ? 0 : 250).pipe(
			Effect.flatMap(() => read(of, pickerRead(target, labels, { where, orderBy, limit }, q))),
			Effect.map((page) => page.rows.map((row) => ({ id: row.id, text: textOf(row) })))
		);
	});
	const selected = queryState<Hit | null, ReadError>(() => {
		const read = host.read,
			id = value;
		if (read === undefined || id === null) return null;
		return read(of, { select, limit: 1, where: { id: { eq: id } } }).pipe(
			Effect.map((page): Hit => ({
				id,
				text: page.rows[0] === undefined ? t('notFound') : textOf(page.rows[0])
			}))
		);
	});
	const hits = $derived(options.current ?? []);
	const loading = $derived(options.loading);
	const failed = $derived(options.error !== undefined);
	let chosen = $state<Hit | null>(null);
	const current = $derived(
		chosen?.id === value
			? chosen
			: selected.current?.id === value
				? selected.current
				: selected.error === undefined || value === null
					? null
					: { id: value, text: t('notFound') }
	);
	const type = (q: string) => {
		query = q;
	};
	const choose = (next: string | null) => {
		chosen = hits.find((hit) => hit.id === next) ?? null;
		onChange(next === null ? null : (idsOf<C>([next])[0] ?? null));
	};
</script>

{#if readonly ?? controls.readonly}
	<!-- the row's label, never its id; nothing while the label loads -->
	<CopyText {id} text={value === null ? '' : (current?.text ?? '')}>
		{#if value === null}<span class="text-muted-foreground">{t('none')}</span
			>{:else}{current?.text ?? (host.read === undefined ? value : '')}{/if}
	</CopyText>
{:else if host.read === undefined}
	<!-- no client above: an id is typed -->
	<Input
		{id}
		value={value ?? ''}
		oninput={(e) => choose(e.currentTarget.value.trim() || null)}
		{readonly}
		{disabled}
		aria-invalid={invalid ? 'true' : undefined}
	/>
{:else}
	<!-- the list floats in a portal: a picker in a clipped header or a scroller still opens over the page -->
	<Combobox
		{id}
		{readonly}
		{disabled}
		{invalid}
		{loading}
		{failed}
		clearable
		options={hits.map((h) => ({ value: h.id, label: h.text }))}
		{value}
		display={current?.text}
		onSearch={type}
		onChange={choose}
	/>
{/if}
