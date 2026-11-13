<!--
@component
Edits a saved native filter (`where` and `order_by`) of one model, apart from any table's viewer preferences and URL.
-->
<script module lang="ts">
	import type { Json } from '../client/contract.js';
	import type { FilterVariables } from './operators.js';

	/** A saved native filter, independent of a table's viewer preferences and URL. */
	export type FilterValue = { readonly where?: Json; readonly order_by?: Json };
	type FilterEditorProps = {
		/** The page context (`ctx`), passed whole. */
		ctx: UiContext;
		/** The model the filter reads. */
		model: string;
		/** The saved filter; a filter the editor cannot represent is shown as JSON with a Replace button. */
		value?: FilterValue;
		/** Shows the filter without editing it. Default false. */
		readonly?: boolean;
		/** The variables a condition may hold in place of a value, and their validation; default the requestor and clock variables. */
		variables?: FilterVariables;
		/** Each edit: the whole new filter (`where` and `order_by`, either omitted when empty). */
		on_change?(value: FilterValue): void;
	};
</script>

<script lang="ts">
	import type { UiContext } from '../client/contract.js';
	import { Effect } from 'effect';
	import { watch } from 'runed';
	import { bolt_of } from '../client/context.js';
	import { msg } from '../text/messages.js';
	import FilterPanel from './FilterPanel.svelte';
	import { fromWhere, rowsWhere } from './where.js';
	import { localFilterFields } from './local.js';
	import { orderKeys, orderOf, orderText, parseOrder, sortable, type SortKey } from './order.js';
	import { savedFilterCatalog, resolve, type Offer } from './catalog.js';
	import { operatorsFor } from './operators.js';
	import type { Node } from './node.js';

	let { ctx, model, value = {}, readonly = false, variables, on_change }: FilterEditorProps = $props();
	const bolt = $derived(bolt_of(ctx));
	const kinds = $derived(ctx.ui.kinds);
	const catalog = $derived(savedFilterCatalog(kinds.catalog ?? {}));
	const sortFields = $derived(sortable(catalog[model], true, catalog));
	let rows = $state<readonly Node[]>([]);
	let order = $state<readonly SortKey[]>([]);
	let notice = $state<string | null>(null);
	let unsupported = $state(false);
	let source = $state('');
	let sourceVariables: FilterVariables | undefined;
	let offers = $state<readonly Offer[]>([]);
	const offerSpec = $derived({ model, fields: localFilterFields(model, catalog[model]) });
	let loaded = $state.raw<typeof offerSpec | null>(null);
	let loading: typeof offerSpec | null = null;
	let generation = 0;
	const savedOffers = $derived.by(() => {
		const base = loaded === offerSpec ? offers : [];
		const extra: Offer[] = [];
		for (const [name, field] of Object.entries(kinds.catalog?.[model]?.fields ?? {})) {
			if (!field.hidden) continue;
			const resolved = resolve(catalog, model, name);
			if (resolved === null) continue;
			for (const operator of operatorsFor([], [], name, resolved))
				if (
					!base.some(
						(offer) =>
							offer.path.length === 1 &&
							offer.path[0]?.k === 'field' &&
							offer.path[0].name === name &&
							offer.op === operator.op
					)
				)
					extra.push({
						label: resolved.label,
						path: [{ k: 'field', name }],
						op: operator.op,
						opLabel: operator.label,
						kind: field.kind
					});
		}
		return [...base, ...extra];
	});

	function parse(next: FilterValue) {
		const parsed = fromWhere(catalog, model, next.where ?? {}, model, '', variables);
		const sorted = parseOrder(orderText(orderKeys(next.order_by)), sortFields);
		return parsed === null || sorted.dropped > 0 ? null : { rows: parsed, order: sorted.keys };
	}
	watch(
		() => [JSON.stringify([model, value, catalog[model]]), variables] as const,
		([key]) => {
			if (key === source && variables === sourceVariables) return;
			const parsed = parse(value);
			rows = parsed?.rows ?? [];
			order = parsed?.order ?? [];
			unsupported = parsed === null;
			notice =
				parsed === null
					? msg(bolt, 'view.unsupportedSaved'
						)
					: null;
			source = key;
			sourceVariables = variables;
		}
	);
	function changed() {
		const where = rowsWhere(catalog, model, rows, undefined, variables);
		const order_by = orderOf(order);
		const next: FilterValue = {
			...(where === null ? {} : { where }),
			...(order.length === 0 ? {} : { order_by })
		};
		source = JSON.stringify([model, next, catalog[model]]);
		sourceVariables = variables;
		on_change?.(next);
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
			return savedOffers;
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
							notice = msg(bolt, 'view.describeFailed'
							);
							return false;
						}
						rows = parsed.rows;
						if (result.order_by !== undefined) order = parsed.order;
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
	<pre
		class="bg-muted/30 mt-2 max-h-64 overflow-auto rounded-md border p-2 text-xs text-muted-foreground"
		data-saved-filter>{JSON.stringify(
			value.where ?? {},
			null,
			2
		)}{#if value.order_by !== undefined}{`\n${JSON.stringify(value.order_by, null, 2)}`}{/if}</pre>
	{#if !readonly}<button type="button" class="text-sm underline" onclick={() => view.clear()}
			>{msg(bolt, 'view.replaceSaved')}</button
		>{/if}
{:else}
	<FilterPanel {ctx} {view} {catalog} {model} sortable={sortFields} {variables} {readonly} expanded />
{/if}
