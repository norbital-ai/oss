<script lang="ts" module>
	import type { Json, Value } from './kind.js';
	import type { ModelKey, FieldOf, IdOf, OrderByOf, WhereOf } from '../model/types.js';
	import type { ReadError } from '../client/contract.js';

	/**
	 * Edits a relation or an `id` input (§3.6): searches the target model through the caller's own read grant, so
	 * it lists only rows (and fields) the viewer may read. `label` defaults to the target model's `label`; a target
	 * without `search` is searched over its label's text and patterned `seq` fields. Each keystroke is a server search,
	 * so `limit` is the page shown, never the rows searched; rows sort by `order_by`, else by the label.
	 */
	export type PickerProps<C = ModelKey> = {
		of: C;
		/** The chosen id; any text is shown as not found, never trusted. */
		value: string | null;
		onChange(next: IdOf<C> | null): void;
		label?: readonly FieldOf<C>[];
		where?: WhereOf<C> & Json;
		order_by?: OrderByOf<C> & Json;
		limit?: number;
		id?: string;
		/** Shows the chosen row's label as copyable text; an enclosing readonly form sets it. */
		readonly?: boolean;
		disabled?: boolean;
		invalid?: boolean;
	};
</script>

<script lang="ts" generics="const C extends ModelKey">
	import Combobox from '../primitives/combobox/combobox.svelte';
	import CopyText from '../primitives/copy-text/copy-text.svelte';
	import Input from '../primitives/input/input.svelte';
	import { label as title } from '@norbital-ai/std/label';
	import { uiText, useControls } from '../primitives/utils.js';
	import { useKinds } from './context.js';
	import { Effect } from 'effect';
	import { observeOnce as queryState } from '../effect/index.js';
	import { idsOf } from '../form/form-state.svelte.js';
	import { currencyOf, format, pickerRead, valueObject } from './kind.js';
	import { byId } from '../read/request.js';
	import { labelRead } from '../relations/select.js';
	import { withOutputs } from '../client/context.js';

	let {
		of,
		value,
		onChange,
		label,
		where,
		order_by,
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

	// a catalogue picked from a source row is versioned: only the version in force today is a choice
	const versionInForce = (read: NonNullable<typeof host.query>, today: string) =>
		read({
			jurisdiction_settings: {
				where: { status: { eq: 'SEALED' } },
				fields: ['id', 'effective_range'],
				limit: 1000
			}
		}).pipe(
			Effect.map((answer) => {
				const rows = answer.jurisdiction_settings?.rows ?? [];
				const period = (row: (typeof rows)[number]) => {
					const range = valueObject(row.effective_range) ? row.effective_range : {};
					return {
						from: typeof range['from'] === 'string' ? range['from'] : '',
						to: typeof range['to'] === 'string' ? range['to'] : null
					};
				};
				const covering = rows.find((row) => {
					const { from, to } = period(row);
					return from !== '' && from <= today && (to === null || today <= to);
				});
				const newest = [...rows].sort((left, right) =>
					period(right).from.localeCompare(period(left).from)
				)[0];
				return String((covering ?? newest)?.id ?? '') || null;
			})
		);
	let query = $state('');
	const options = queryState<Hit[], ReadError>(() => {
		const read = host.query;
		if (read === undefined) return null;
		const q = query;
		const base: Json | undefined = where ?? undefined;
		return Effect.gen(function* () {
			const scoped = of.endsWith('_catalog')
				? yield* versionInForce(read, new Date().toISOString().slice(0, 10))
				: null;
			const filter: Json | undefined =
				scoped === null
					? base
					: base === undefined
						? { settings_id: { eq: scoped } }
						: { and: [base, { settings_id: { eq: scoped } }] };
			yield* Effect.sleep(q === '' ? 0 : 250);
			return yield* read(
				withOutputs(
					target?.record_label !== undefined
						? labelRead(
								host.catalog,
								of,
								pickerRead(target, labels, { where: filter, order_by, limit }, q)
							)
						: { [of]: pickerRead(target, labels, { where: filter, order_by, limit }, q) },
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
					? labelRead(host.catalog, of, { where: { id: { eq: id } }, limit: 1 })
					: byId(of, id, labels),
				host.catalog
			)
		).pipe(
			Effect.map((answer): Hit => {
				const row = answer[of]?.rows[0];
				return { id, text: row === undefined ? t('notFound') : textOf(row) };
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
		onSearch={type}
		onChange={choose}
	/>
{/if}
