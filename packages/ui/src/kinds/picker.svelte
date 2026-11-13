<!--
@component
Picks one row of a model by searching it through the viewer's own read grant; the value is the row's id.

@example
```svelte
<Picker {ctx} of="employee" where={{ active: { eq: true } }} value={id} on_change={(next) => (id = next)} />
```
-->
<script lang="ts" module>
	import type { UiContext } from '../client/contract.js';
	import type { Json, Value } from './kind.js';
	import type { ModelKey, FieldOf, IdOf, OrderByOf, WhereOf } from '../model/types.js';
	import type { ReadError } from '../client/contract.js';

	/**
	 * Edits a relation or an `id` input: searches the target model through the caller's own read grant, so
	 * it lists only rows (and fields) the viewer may read. `label` defaults to the target model's `label`; a target
	 * without `search` is searched over its label's text and patterned `seq` fields. Each keystroke is a server search,
	 * so `limit` is the page shown, never the rows searched; rows sort by `order_by`, else by the label.
	 */
	export type PickerProps<C = ModelKey> = {
		/** The page context (`ctx`), passed whole. */
		ctx: UiContext;
		/** The target model's handle. */
		of: C;
		/** The chosen id; any text is shown as not found, never trusted. */
		value: string | null;
		/** Called with the picked id, or `null` when cleared. */
		on_change(next: IdOf<C> | null): void;
		/** Fields that label each row; defaults to the target model's `label`. */
		label?: readonly FieldOf<C>[];
		/** Narrows the choices (a versioned catalogue's version in force, say): the caller decides, the picker only reads. */
		where?: WhereOf<C> & Json;
		/** Row order; defaults to the label. */
		order_by?: OrderByOf<C> & Json;
		/** Rows shown per search (default 20); never caps what is searched. */
		limit?: number;
		/** The id on the control, for `<label for>`. */
		id?: string;
		/** Shows the chosen row's label as copyable text; an enclosing readonly form sets it. */
		readonly?: boolean;
		/** Muted and inert; defaults to the enclosing `Form`/`Field` mode. */
		disabled?: boolean;
		/** Marks the control invalid. */
		invalid?: boolean;
	};
</script>

<script lang="ts" generics="const C extends ModelKey">
	import Combobox from '../primitives/combobox/combobox.svelte';
	import CopyText from '../primitives/copy-text/copy-text.svelte';
	import Input from '../primitives/input/input.svelte';
	import { label as title } from '@norbital-ai/store/label';
	import { ui_text, use_controls } from '../primitives/utils.js';
	import { Effect } from 'effect';
	import { observe_once as queryState } from '../effect/index.js';
	import { is_id } from '../form/form-state.svelte.js';
	import { currencyOf, format, picker_read } from './kind.js';
	import { by_id } from '../read/request.js';
	import { label_read } from '../relations/select.js';
	import { withOutputs } from '../client/context.js';

	let {
		ctx,
		of,
		value,
		on_change,
		label,
		where,
		order_by,
		limit = 20,
		id,
		readonly,
		disabled,
		invalid = false
	}: PickerProps<C> = $props();
	const controls = use_controls();
	const host = $derived(ctx.ui.kinds);
	const target = $derived(host.catalog?.[of]);
	const labels = $derived(label ?? target?.label ?? []);
	type Hit = { id: string; text: string };
	const t = ui_text();
	// The shared record identifier: declared label, otherwise its stable id.
	const textOf = (row: { readonly [f: string]: Value }) =>
		title(row, label === undefined ? (target?.record_label ?? []) : labels, (f, v) => {
			const kind = target?.fields[f];
			return kind === undefined
				? String(v)
				: format(kind, v, {
						locale: host.locale,
						zone: host.zone,
						currency: kind.kind === 'money' ? currencyOf(kind, row, host.currency) : undefined
					});
		}) ?? t('none');

	let query = $state('');
	const options = queryState<Hit[], ReadError>(() => {
		const read = host.query;
		if (read === undefined) return null;
		const q = query;
		const filter: Json | undefined = where ?? undefined;
		return Effect.gen(function* () {
			yield* Effect.sleep(q === '' ? 0 : 250);
			return yield* read(
				withOutputs(
					target?.record_label !== undefined
						? label_read(
								host.catalog,
								of,
								picker_read(target, labels, { where: filter, order_by, limit }, q)
							)
						: { [of]: picker_read(target, labels, { where: filter, order_by, limit }, q) },
					host.catalog
				)
			);
		}).pipe(
			Effect.map((answer) =>
				(answer[of]?.rows ?? []).map((row) => ({ id: row.id, text: textOf(row) }))
			)
		);
	});
	const selected = queryState<Hit | null, ReadError>(() => {
		const read = host.query,
			id = value;
		if (read === undefined || id === null) return null;
		return read(
			withOutputs(
				target?.record_label !== undefined
					? label_read(host.catalog, of, { where: { id: { eq: id } }, limit: 1 })
					: by_id(of, id, labels),
				host.catalog
			)
		).pipe(
			Effect.map((answer): Hit => {
				const row = answer[of]?.rows[0];
				return { id, text: row === undefined ? t('not_found') : textOf(row) };
			})
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
					: { id: value, text: t('not_found') }
	);
	const type = (q: string) => {
		query = q;
	};
	const choose = (next: string | null) => {
		chosen = hits.find((hit) => hit.id === next) ?? null;
		on_change(is_id<C>(next) ? next : null);
	};
</script>

{#if readonly ?? controls.readonly}
	<!-- The declared label or id fallback; nothing while the label loads. -->
	<CopyText {id} text={value === null ? '' : (current?.text ?? '')}>
		{#if value === null}<span class="text-muted-foreground">{t('none')}</span
			>{:else}{current?.text ?? (host.query === undefined ? value : '')}{/if}
	</CopyText>
{:else if host.query === undefined}
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
		on_search={type}
		on_change={choose}
	/>
{/if}
