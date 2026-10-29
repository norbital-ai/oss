// The view popover's state for a `Table` or `Board` (rule 16b): filter rows and sort keys, read strictly from the URL
// (or `initialFilter`) once, kept in the URL, and lowered to the `where`/`orderBy` a read sends. A relative condition
// ("this month") stays relative in the rows and the URL; the read gets its literal at the page's day clock, so it rolls
// over at midnight in the workspace zone. The condition catalogue (`filter.options`) is the same one a description is
// offered; the builder renders it, never an operator table of its own.
import { Effect, Result } from 'effect';
import { untrack } from 'svelte';
import { useKinds, type ModelExposure } from '../kinds/context.js';
import type { Json, ViewBolt } from '../client/contract.js';
import {
	clauses,
	fromWhere,
	localFilterFields,
	orderKeys,
	orderOf,
	orderText,
	parseOrder,
	readViewUrl,
	rowsWhere,
	sortable,
	toWhere,
	writeViewUrl,
	type FilterClock,
	type Node,
	type Offer,
	type SortKey,
	type Where
} from './filter.js';
import { msg } from '../text/messages.js';

type Catalog = { readonly [model: string]: ModelExposure };
export type ViewState = ReturnType<typeof viewState>;

export function viewState(
	bolt: ViewBolt | undefined,
	o: {
		key: () => string;
		model: () => string;
		catalog: () => Catalog;
		initialFilter: () => Json | undefined;
		/** Controlled row views own their URL state and never apply this viewer's transforms. */
		enabled?: () => boolean;
	}
) {
	const params = () =>
		typeof location === 'undefined' ? new URLSearchParams() : new URL(location.href).searchParams;
	const words: Pick<ViewBolt, 't'> = bolt ?? { t: (key) => key };
	const DROPPED = () =>
		msg(words, 'view.dropped', 'A filter or sort from the link no longer applies and was removed');
	const day = $derived(o.enabled?.() === false ? undefined : bolt?.clock('day'));
	const zone = useKinds().zone ?? 'UTC';
	const clock = (): FilterClock => {
		if (day === undefined) throw new Error('A filtered view needs the shell clock.');
		return { today: day.today, now: day.now, zone };
	};

	/** `bolt.decode` per top-level clause (it keeps or drops each top-level key; an `and` list is one key), or null when the
	 * client has none (a local array, a test host): the typed rows then are the check. */
	function decode(c: string, q: { where?: Json; orderBy?: Json }) {
		if (bolt?.decode === undefined || c.startsWith('$')) return null;
		return Result.getOrElse(
			Result.try({
				try: () => bolt.decode?.(c, q) ?? null,
				catch: (cause) => ({ _tag: 'FilterDecodeFailed' as const, cause })
			}),
			() => null
		);
	}
	/** URL → rows and keys: each top-level clause and key decoded alone; the bad ones dropped with one notice. */
	function load() {
		if (o.enabled?.() === false) return { rows: [], order: [], touched: false, notice: null };
		const c = o.model(),
			cat = o.catalog(),
			url = readViewUrl(params(), o.key());
		const fromUrl = url.where !== undefined;
		let dropped = url.badJson ? 1 : 0;
		const rows: Node[] = [];
		for (const clause of clauses(url.where ?? o.initialFilter() ?? null)) {
			const n = fromWhere(cat, c, clause);
			const w = n === null ? null : rowsWhere(cat, c, n, clock());
			const d = w === null ? null : decode(c, { where: w });
			if (n !== null && (d === null || d.dropped.length === 0)) rows.push(...n);
			else if (fromUrl) dropped++;
		}
		let text = url.order ?? '';
		const d = text === '' ? null : decode(c, { orderBy: orderOf(parseOrder(text, null).keys) });
		if (d !== null) {
			dropped += d.dropped.length;
			text = orderText(orderKeys(d.orderBy));
		}
		const order = parseOrder(
			text,
			cat[c] === undefined ? null : sortable(cat[c], !c.startsWith('$'), cat)
		);
		return {
			rows,
			order: order.keys,
			touched: fromUrl,
			notice: dropped + order.dropped > 0 ? DROPPED() : null
		};
	}
	const first = untrack(load);
	let rows = $state<readonly Node[]>(first.rows);
	let order = $state<readonly SortKey[]>(first.order);
	let touched = $state(first.touched);
	let notice = $state<string | null>(first.notice);

	// the engine's catalogue, once per model: the builder's fields, operators and values
	let offers = $state<readonly Offer[]>([]);
	const offerSpec = $derived({
		model: o.model(),
		fields: localFilterFields(o.model(), o.catalog()[o.model()])
	});
	let loaded: typeof offerSpec | null = null,
		loading: typeof offerSpec | null = null,
		generation = 0;
	const offerKey = () => offerSpec;
	function loadOffers(): Effect.Effect<void> {
		return Effect.suspend(() => {
			const spec = offerSpec;
			if (bolt?.options === undefined || loaded === spec || loading === spec) return Effect.void;
			loading = spec;
			loaded = null;
			offers = [];
			const request = ++generation;
			return bolt.options(spec.model, spec.fields).pipe(
				Effect.tap((result) =>
					Effect.sync(() => {
						if (request === generation && spec === offerSpec) {
							offers = result.fields;
							loaded = spec;
						}
					})
				),
				Effect.catch(() =>
					Effect.sync(() => {
						if (request === generation) loaded = null;
					})
				),
				Effect.ensuring(
					Effect.sync(() => {
						if (request === generation) loading = null;
					})
				)
			);
		});
	}

	// what the read sends: the viewer's rows at the page's clock, each re-checked by `bolt.decode` when the client has it
	// (rule 11a)
	const lowered = $derived.by(() => {
		if (o.enabled?.() === false) return { where: undefined, dropped: 0 };
		const c = o.model(),
			at = clock(),
			parts: Where[] = [];
		let dropped = 0;
		for (const n of rows) {
			const w = toWhere(o.catalog(), c, n, at);
			if (w === null) continue;
			const d = decode(c, { where: w });
			if (d !== null && d.dropped.length > 0) dropped++;
			else parts.push(w);
		}
		return {
			where: parts.length === 0 ? undefined : parts.length === 1 ? parts[0]! : { and: parts },
			dropped
		};
	});
	$effect(() => {
		if (o.enabled?.() === false) return;
		const next = writeViewUrl(params(), o.key(), {
			where: rowsWhere(o.catalog(), o.model(), rows),
			touched,
			order
		});
		if (typeof location !== 'undefined')
			history.replaceState(
				history.state,
				'',
				`${location.pathname}${next.size > 0 ? `?${next}` : ''}${location.hash}`
			);
	});

	return {
		get rows() {
			return rows;
		},
		get order() {
			return order;
		},
		get offers() {
			return loaded === offerKey() ? offers : [];
		},
		get offersKey() {
			return offerKey();
		},
		loadOffers,
		get where(): Where | undefined {
			return lowered.where;
		},
		get notice() {
			return notice ?? (lowered.dropped > 0 ? DROPPED() : null);
		},
		setRows(next: readonly Node[]) {
			rows = next;
			touched = true;
			notice = null;
		},
		setOrder(next: readonly SortKey[]) {
			order = next;
		},
		clear() {
			rows = [];
			order = [];
			touched = true;
			notice = null;
		},
		/** Rule 16a: the description's `Where` and `OrderBy` replace the rows (and the sort, when it asks for one). */
		describe(text: string): Effect.Effect<boolean> {
			return Effect.suspend(() => {
				const fail = (why?: Error) => {
					notice =
						why !== undefined && why.message !== ''
							? why.message
							: msg(words, 'view.describeFailed', 'Could not build a filter from that description');
					return false;
				};
				if (bolt?.describe === undefined || text.trim() === '') return Effect.succeed(false);
				const model = o.model();
				return bolt.describe(model, text.trim(), localFilterFields(model, o.catalog()[model])).pipe(
					Effect.map((result) => {
						const parts = clauses(result.where).map((clause) =>
							fromWhere(o.catalog(), o.model(), clause)
						);
						const keys =
							result.orderBy === undefined
								? null
								: parseOrder(
										orderText(orderKeys(result.orderBy)),
										sortable(o.catalog()[o.model()], !o.model().startsWith('$'), o.catalog())
									);
						if (parts.some((part) => part === null) || (keys !== null && keys.dropped > 0))
							return fail();
						rows = parts.flatMap((part) => part ?? []);
						touched = true;
						notice = null;
						if (keys !== null) order = keys.keys;
						return true;
					}),
					Effect.catch((error) => Effect.succeed(fail(error)))
				);
			});
		}
	};
}
