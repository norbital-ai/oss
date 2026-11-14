// The view popover's state for a `Table` or `Board`: filter rows and sort keys, read strictly from the URL
// (or `initial_filter`) once, kept in the URL, and lowered to the `where`/`order_by` a read sends. A relative condition
// ("this month") stays relative in the rows and the URL; the read gets its literal at the page's day clock, so it rolls
// over at midnight in the workspace zone. The condition catalogue (`filter.options`) is the same one a description is
// offered; the builder renders it, never an operator table of its own.
import { Effect, Schema } from 'effect';
import { untrack } from 'svelte';
import { watch } from 'runed';
import type { Json, UiContext, ViewBolt } from '../client/contract.js';
import { optional_bolt_of } from '../client/context.js';
import { clauses, fromWhere, rowsWhere, toWhere } from './where.js';
import { complete, type FilterClock, type Node } from './node.js';
import { localFilterFields } from './local.js';
import { orderKeys, orderOf, orderText, parseOrder, sortable, type SortKey } from './order.js';
import type { Catalog, Offer } from './catalog.js';
import type { Where } from '@norbital-ai/store/kind';
import { msg } from '../text/messages.js';
import { currentSearchParams, replaceSearchParams } from '../utilities/url.js';

// ── URL state (`?<key>.where=`, `?<key>.order=`) ──
type ViewUrl = { where: Json | undefined; order: string | undefined; badJson: boolean };

export function readViewUrl(params: URLSearchParams, key: string): ViewUrl {
	const raw = params.get(`${key}.where`),
		order = params.get(`${key}.order`) ?? undefined;
	if (raw === null) return { where: undefined, order, badJson: false };
	const result = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Json))(raw);
	return result._tag === 'Success'
		? { where: result.success, order, badJson: false }
		: { where: undefined, order, badJson: true };
}

/** `where` is written once the viewer has touched the rows (an empty `{}` records a cleared `initial_filter`). */
function writeViewUrl(
	params: URLSearchParams,
	key: string,
	s: { where: Where | null; touched: boolean; order: readonly SortKey[] }
): URLSearchParams {
	const out = new URLSearchParams(params);
	if (s.touched) out.set(`${key}.where`, JSON.stringify(s.where ?? {}));
	else out.delete(`${key}.where`);
	if (s.order.length > 0) out.set(`${key}.order`, orderText(s.order));
	else out.delete(`${key}.order`);
	return out;
}

export type ViewState = ReturnType<typeof viewState>;

export function viewState(
	ctx: () => UiContext,
	o: {
		key: () => string;
		model: () => string;
		catalog: () => Catalog;
		initial_filter: () => Json | undefined;
		/** Controlled row views own their URL state and never apply this viewer's transforms. */
		enabled?: () => boolean;
	}
) {
	const bolt = optional_bolt_of(ctx());
	const words: Pick<ViewBolt, 't'> = bolt ?? { t: (key) => key };
	const DROPPED = () =>
		msg(words, 'view.dropped');
	const day = $derived(o.enabled?.() === false ? undefined : bolt?.clock('day'));
	const zone = ctx().ui.kinds.zone ?? 'UTC';
	const clock = (): FilterClock => {
		if (day === undefined) throw new Error('A filtered view needs the shell clock.');
		return { today: day.today, now: day.now, zone };
	};

	/** `bolt.decode` per top-level clause (it keeps or drops each top-level key; an `and` list is one key), or null when the
	 * client has none (a local array, a test host): the typed rows then are the check. A decoder that fails drops the
	 * clause instead of letting an unchecked predicate reach the read. */
	function decode(
		c: string,
		q: { where?: Json; order_by?: Json }
	): {
		readonly order_by?: Json;
		readonly dropped: readonly { path: string; message: string }[];
	} | null {
		if (bolt?.decode === undefined || c.startsWith('$')) return null;
		try {
			return bolt.decode(c, q) ?? null;
		} catch (cause) {
			return {
				dropped: [
					{
						path: '',
						message: cause instanceof Error ? cause.message : 'The filter could not be decoded.'
					}
				]
			};
		}
	}
	/** URL → rows and keys: each top-level clause and key decoded alone; the bad ones dropped with one notice. */
	function load() {
		if (o.enabled?.() === false) return { rows: [], order: [], touched: false, notice: null };
		const c = o.model(),
			cat = o.catalog(),
			url = readViewUrl(currentSearchParams(), o.key());
		const fromUrl = url.where !== undefined;
		let dropped = url.badJson ? 1 : 0;
		const rows: Node[] = [];
		for (const clause of clauses(url.where ?? o.initial_filter() ?? null)) {
			const n = fromWhere(cat, c, clause);
			const w = n === null ? null : rowsWhere(cat, c, n, clock());
			const d = w === null ? null : decode(c, { where: w });
			if (n !== null && (d === null || d.dropped.length === 0)) rows.push(...n);
			else if (fromUrl) dropped++;
		}
		let text = url.order ?? '';
		const d = text === '' ? null : decode(c, { order_by: orderOf(parseOrder(text, null).keys) });
		if (d !== null) {
			dropped += d.dropped.length;
			text = orderText(orderKeys(d.order_by));
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
	let loaded = $state.raw<typeof offerSpec | null>(null);
	let loading: typeof offerSpec | null = null,
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
	//
	const lowered = $derived.by(() => {
		// no filter reads no clock
		if (o.enabled?.() === false || rows.length === 0) return { where: undefined, dropped: 0 };
		const c = o.model(),
			at = clock(),
			parts: Where[] = [];
		let dropped = 0;
		for (const n of rows) {
			const w = toWhere(o.catalog(), c, n, at);
			if (w === null) {
				if (complete(n)) dropped++;
				continue;
			}
			const d = decode(c, { where: w });
			if (d !== null && d.dropped.length > 0) dropped++;
			else parts.push(w);
		}
		const first = parts[0];
		return {
			where: first === undefined ? undefined : parts.length === 1 ? first : { and: parts },
			dropped
		};
	});
	watch(() => {
		if (o.enabled?.() === false) return null;
		return writeViewUrl(currentSearchParams(), o.key(), {
			where: rowsWhere(o.catalog(), o.model(), rows),
			touched,
			order
		});
	}, (next) => {
		if (next !== null) replaceSearchParams(next);
	});

	return {
		get clock() {
			return clock();
		},
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
							: msg(words, 'view.describeFailed');
					return false;
				};
				if (bolt?.describe === undefined || text.trim() === '') return Effect.succeed(false);
				const model = o.model();
				return bolt.describe(model, text.trim(), localFilterFields(model, o.catalog()[model])).pipe(
					Effect.map((result) => {
						const parts = clauses(result.where ?? {}).map((clause) =>
							fromWhere(o.catalog(), o.model(), clause)
						);
						const keys =
							result.order_by === undefined
								? null
								: parseOrder(
										orderText(orderKeys(result.order_by)),
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
