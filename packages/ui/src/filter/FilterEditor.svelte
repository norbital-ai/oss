<script module lang="ts">
	import type { Json } from '../client/contract.js';
	import type { FilterVariables } from './filter.js';

	/** A saved native filter, independent of a table's viewer preferences and URL. */
	export type FilterValue = { readonly where?: Json; readonly orderBy?: Json };
	export type FilterEditorProps = {
		model: string;
		value?: FilterValue;
		readonly?: boolean;
		variables?: FilterVariables;
		onChange?(value: FilterValue): void;
	};
</script>

<script lang="ts">
	import { Effect } from 'effect';
	import { watch } from 'runed';
	import { useBolt } from '../client/context.js';
	import { useKinds } from '../kinds/context.js';
	import { msg } from '../text/messages.js';
	import FilterPanel from './FilterPanel.svelte';
	import {
		fromWhere,
		localFilterFields,
		orderKeys,
		orderOf,
		orderText,
		parseOrder,
		rowsWhere,
		sortable,
		type Node,
		type Offer,
		type SortKey
	} from './filter.js';

	let { model, value = {}, readonly = false, variables, onChange }: FilterEditorProps = $props();
	const bolt = useBolt();
	const kinds = useKinds();
	const catalog = $derived(kinds.catalog ?? {});
	const sortFields = $derived(sortable(catalog[model], true, catalog));
	let rows = $state<readonly Node[]>([]);
	let order = $state<readonly SortKey[]>([]);
	let notice = $state<string | null>(null);
	let unsupported = $state(false);
	let source = $state('');
	let offers = $state<readonly Offer[]>([]);
	const offerSpec = $derived({ model, fields: localFilterFields(model, catalog[model]) });
	let loaded = $state.raw<typeof offerSpec | null>(null);
	let loading: typeof offerSpec | null = null;
	let generation = 0;

	function parse(next: FilterValue) {
		const parsed = fromWhere(catalog, model, next.where ?? {}, model, '', variables);
		const sorted = parseOrder(orderText(orderKeys(next.orderBy)), sortFields);
		return parsed === null || sorted.dropped > 0 ? null : { rows: parsed, order: sorted.keys };
	}
	watch(() => JSON.stringify([model, value, catalog[model]]), (key) => {
		if (key === source) return;
		const parsed = parse(value);
		rows = parsed?.rows ?? [];
		order = parsed?.order ?? [];
		unsupported = parsed === null;
		notice =
			parsed === null
				? msg(
						bolt,
						'view.unsupportedSaved',
						'This saved filter contains a condition this editor cannot represent. It has been preserved.'
					)
				: null;
		source = key;
	});
	function changed() {
		const where = rowsWhere(catalog, model, rows, undefined, variables);
		const orderBy = orderOf(order);
		const next: FilterValue = {
			...(where === null ? {} : { where }),
			...(order.length === 0 ? {} : { orderBy })
		};
		source = JSON.stringify([model, next, catalog[model]]);
		onChange?.(next);
	}
	const loadOffers = () =>
		Effect.suspend(() => {
			const spec = offerSpec;
			if (bolt.options === undefined || loaded === spec || loading === spec) return Effect.void;
			loading = spec;
			const request = ++generation;
			return bolt.options(spec.model, spec.fields).pipe(
				Effect.tap((result) =>
					Effect.sync(() => {
						if (request === generation) {
							offers = result.fields;
							loaded = spec;
						}
					})
				),
				Effect.catch(() => Effect.void),
				Effect.ensuring(
					Effect.sync(() => {
						if (request === generation) loading = null;
					})
				)
			);
		});
	const view = {
		get rows() {
			return rows;
		},
		get order() {
			return order;
		},
		get offers() {
			return loaded === offerSpec ? offers : [];
		},
		get offersKey() {
			return offerSpec;
		},
		get notice() {
			return notice;
		},
		loadOffers,
		setRows(next: readonly Node[]) {
			if (readonly) return;
			rows = next;
			notice = null;
			changed();
		},
		setOrder(next: readonly SortKey[]) {
			if (readonly) return;
			order = next;
			notice = null;
			changed();
		},
		clear() {
			if (readonly) return;
			rows = [];
			order = [];
			notice = null;
			unsupported = false;
			changed();
		},
		describe(text: string) {
			return Effect.suspend(() => {
				if (readonly || bolt.describe === undefined || text.trim() === '')
					return Effect.succeed(false);
				return bolt.describe(model, text.trim(), localFilterFields(model, catalog[model])).pipe(
					Effect.map((result) => {
						const parsed = parse(result);
						if (parsed === null) {
							notice = msg(
								bolt,
								'view.describeFailed',
								'Could not build a filter from that description'
							);
							return false;
						}
						rows = parsed.rows;
						if (result.orderBy !== undefined) order = parsed.order;
						notice = null;
						changed();
						return true;
					}),
					Effect.catch((error) =>
						Effect.sync(() => {
							notice = error.message;
							return false;
						})
					)
				);
			});
		}
	};
</script>

{#if unsupported}
	<p role="alert" class="text-destructive text-sm">{notice}</p>
	{#if !readonly}<button type="button" class="text-sm underline" onclick={() => view.clear()}
			>{msg(bolt, 'view.replaceSaved', 'Replace filter')}</button
		>{/if}
{:else}
	<FilterPanel {view} {catalog} {model} sortable={sortFields} {variables} {readonly} expanded />
{/if}
