import type { PodSyncClient } from './pod-sync-client.js';
import type { CollectionSyncState, ShapeResponse } from './types.js';

/**
 * Rows per catch-up request, at the server's ceiling (`MAX_SHAPE_PAGE_SIZE`).
 *
 * This is a bulk download, not a page of UI, and each request is a full browser → Core → microVM →
 * Postgres round trip. At the old 1,000 a 20k-row collection cost 21 serialized round trips before
 * it was resident; the payload was never the expensive part, the trips were.
 */
const PAGE_SIZE = 5000;

/**
 * Rows in the *first* catch-up page.
 *
 * A read waits for this page and no further, so this — not PAGE_SIZE — is the unit the loading
 * spinner measures. Sized to a screen's worth of rows rather than a bulk transfer: at the full
 * 5,000 a table showing 100 attendance rows sat behind tens of thousands the screen was never
 * going to display, and the user watched a loader for work they had not asked for.
 *
 * Every page after it uses PAGE_SIZE and runs in the background, invisibly. The query already has
 * rows by then, so re-running it against the fuller replica swaps data in without ever returning
 * to a loading state — `loading` means "nothing to show", and by then there is something.
 */
const FIRST_PAGE_SIZE = 250;

/**
 * How many bytes of collection data this replica may hold, across every collection.
 *
 * A collection that fits is fully local within a few round trips; one that does not is *windowed*
 * — the replica keeps the working set the app actually asks for (`absorbServerRows`) rather than
 * speculatively pulling rows that a different sort order would make useless anyway.
 *
 * Note this measures *policy-scoped* data. A million-row table is often a few thousand rows for
 * any one user, and those users get the fully-local experience with no special handling.
 *
 * Reaching it is not an error. A collection that does not fit is *windowed*: reads that provably
 * fall inside what is local are answered locally, and anything else is answered by the server,
 * which has the indexes for it.
 */
export const DEFAULT_RESIDENCY_BYTES = 1_073_741_824; // 1 GiB

/**
 * How many rows a single collection may hold before it is windowed regardless of byte size.
 *
 * Bytes are the right unit for a storage budget, but they are the wrong unit for the *download*
 * cost: a 23,000-row table of narrow rows is a few MB and "fits" the 1 GiB budget, yet pulling it
 * means five-plus serialized browser → Core → microVM → Postgres round trips before the replica
 * can answer. A page that filters to one company's month needs tens of rows, not the whole table.
 *
 * The row cap is what makes the windowed tier engage for collections like that: the catch-up
 * stops at the cap, the collection reports itself windowed, reads that cannot be proven local fall
 * to the server (which has the indexes and the scoped `where`), and `absorbServerRows` folds every
 * server answer back into the replica — so the window converges on exactly the rows the user
 * actually walks, and repeat visits are local. A collection that genuinely ends before the cap is
 * still resident: full local counts, search, sorts and offline.
 */
export const DEFAULT_MAX_RESIDENT_ROWS = 5_000;

type CollectionMeta = {
	/** Rows are local and safe to read. */
	ready: boolean;
	/** The saved cursor has crossed the server head observed for this document. */
	fresh: boolean;
	/**
	 * A catch-up has run to completion at least once on this device.
	 *
	 * Distinct from `ready`, which is set on the FIRST page so reads can start immediately. The
	 * difference is what separates "no rows yet" from "no rows": mid-catch-up a collection can
	 * legitimately answer with nothing, and treating that as the answer renders an empty table for
	 * data that is still arriving.
	 */
	synced: boolean;
	/** Every policy-visible row is local — counts, search and end-of-data are answerable offline. */
	resident: boolean;
	rows: number;
	/** Approximate encoded size of what was downloaded, for the shared residency budget. */
	bytes: number;
};

/**
 * Encoded size of a page, as the wire measured it.
 *
 * `JSON.stringify` over the rows is what the server actually sent, so it needs no per-column
 * guessing and tracks reality as schemas change. It is an approximation of on-disk size, and
 * deliberately so: the budget exists to stop a replica growing without bound, and being within a
 * factor of the true figure is enough for that.
 */
function approximateBytes(rows: readonly Record<string, unknown>[]): number {
	if (rows.length === 0) return 0;
	try {
		return JSON.stringify(rows).length;
	} catch {
		return 0;
	}
}

/**
 * A catch-up may stop for three reasons, and only two of them mean the local rows can be
 * trusted as an answer. Reaching the end of the data, or the budget, is a real stopping
 * point. A server that offers a cursor and then sends nothing is not — see below.
 */
function catchUpStop(
	page: ShapeResponse,
	rows: number,
	bytes: number,
	budget: number,
	maxResidentRows: number
): { readonly done: boolean; readonly resident: boolean; readonly trustworthy: boolean } {
	if (page.nextCursor === null) {
		return { done: true, resident: true, trustworthy: true };
	}
	// An empty page that still offers a cursor would spin forever, so stop — but do NOT
	// call the collection complete. It used to, and that is how a table renders "no
	// records" over data that exists: the server says "there is more" and sends none of
	// it, the replica records itself as fully synced and empty, and from then on it
	// answers every read locally with nothing. Leaving it untrusted sends reads to the
	// server, which is the only party that can say whether the collection is really empty.
	if (page.rows.length === 0) {
		return { done: true, resident: false, trustworthy: false };
	}
	// Over the shared byte budget: this collection is windowed. Stop rather than keep
	// pulling — the rows already here still serve reads that fall inside them, and the
	// server owns everything past the edge.
	if (bytes >= budget) {
		return { done: true, resident: false, trustworthy: true };
	}
	// Past the row cap: windowed the same way. A wide table of narrow rows can be a few
	// MB yet cost a round trip per page to download, so bytes alone never windows a
	// table like a 20k-row roster. Reads that cannot be proven local go to the server,
	// whose scoped `where` answers them in one trip.
	if (rows >= maxResidentRows) {
		return { done: true, resident: false, trustworthy: true };
	}
	return { done: false, resident: false, trustworthy: false };
}

/**
 * Tracks which collections this replica holds, and whether it holds all of them.
 *
 * The sync unit is the collection, not the query shape (README §3.1): one catch-up per collection
 * means filters, sorts, pagination and counts over a resident collection are pure local SQL, so
 * changing a sort costs nothing and never produces a cold state with no data to render.
 *
 * State is loaded from `_pod_sync_state` at boot, so a reload finds its collections already warm
 * and answers the first paint locally instead of re-downloading everything.
 */
export class SubscriptionRegistry {
	private readonly meta = new Map<string, CollectionMeta>();
	private readonly inFlight = new Map<string, Promise<void>>();
	/** Collections demanded by a mounted read but not yet through their serialized snapshot. */
	private readonly demanded = new Set<string>();
	/**
	 * Remaining pages after a collection's first page is already readable.
	 *
	 * First-page work is not chained here: a newly demanded collection must not sit behind
	 * another collection's leftover pages. Remainder snapshots still serialize so only one
	 * catch-up freezes the live cursor at a time.
	 */
	private remainderQueue: Promise<void> = Promise.resolve();
	private restoring: Promise<void> | null = null;
	private readonly residencyBytes: number;
	private readonly maxResidentRows: number;

	private publishSubscriptions(): void {
		this.client.setSubscribedCollections(
			new Set([
				...this.demanded,
				...[...this.meta].flatMap(([collection, meta]) => (meta.ready ? [collection] : []))
			])
		);
	}

	constructor(
		private readonly client: PodSyncClient,
		options?: { readonly residencyBytes?: number; readonly maxResidentRows?: number }
	) {
		this.residencyBytes = options?.residencyBytes ?? DEFAULT_RESIDENCY_BYTES;
		this.maxResidentRows = options?.maxResidentRows ?? DEFAULT_MAX_RESIDENT_ROWS;
		// The server's data was reset out from under us and the replica has been discarded. Forget
		// what we believed was local, or every collection would still report itself resident while
		// holding nothing.
		this.client.onReset?.(() => {
			this.meta.clear();
			this.demanded.clear();
			this.restoring = null;
			this.publishSubscriptions();
		});
	}

	/** Adopt the state persisted by earlier sessions. Idempotent and safe to await repeatedly. */
	restore(): Promise<void> {
		this.restoring ??= this.client
			.loadSyncState()
			.catch(() => new Map<string, CollectionSyncState>())
			.then((persisted) => {
				for (const [collection, state] of persisted) {
					if (this.meta.has(collection)) continue;
					// `_pod_sync_state` is only written when a catch-up completes, so anything restored
					// from it has genuinely synced at least once.
					this.meta.set(collection, {
						ready: true,
						fresh: false,
						synced: true,
						resident: state.resident,
						rows: state.rows,
						bytes: state.bytes
					});
				}
				this.publishSubscriptions();
			});
		return this.restoring;
	}

	has(collection: string): boolean {
		return this.meta.get(collection)?.ready ?? false;
	}

	/**
	 * Whether an empty local answer for this collection can be trusted as the answer.
	 *
	 * Until a catch-up has completed once, it cannot: the rows may simply not have arrived. Callers
	 * fall back to the server rather than render an empty state over data that is still in flight.
	 */
	hasSynced(collection: string): boolean {
		return this.meta.get(collection)?.synced ?? false;
	}

	/** True when every policy-visible row of the collection is local. */
	isResident(collection: string): boolean {
		const entry = this.meta.get(collection);
		return Boolean(entry?.fresh && entry.resident);
	}

	/**
	 * Whether this replica stored the collection as fully local.
	 *
	 * Unlike `isResident`, this does not wait for the live cursor to cross the document head.
	 * Restored resident collections may answer visible reads from the held rows while freshness
	 * catches up on the stream.
	 */
	isHeldResident(collection: string): boolean {
		return this.meta.get(collection)?.resident ?? false;
	}

	/** A restored row is not safe until the live cursor catches the head seen at document boot. */
	isFresh(collection: string): boolean {
		return this.meta.get(collection)?.fresh ?? false;
	}

	/** Promote restored state after the ordered feed crosses the bootstrap head. */
	markRestoredFresh(): void {
		for (const [collection, entry] of this.meta) {
			if (entry.fresh) continue;
			this.meta.set(collection, { ...entry, fresh: true });
			this.client.notifyCollection(collection);
		}
	}

	/**
	 * Ensure a collection is local. Resolves as soon as the first page has landed — the caller
	 * reads immediately while any remaining pages fill in behind it.
	 */
	async register(collection: string): Promise<void> {
		return this.catchUp(collection);
	}

	private async catchUp(collection: string): Promise<void> {
		if (this.meta.get(collection)?.ready) return;
		const existing = this.inFlight.get(collection);
		if (existing) return existing;
		// Register live interest before this collection waits behind another snapshot. Otherwise an
		// agent session created during that wait can land before its feed interest exists and remain
		// invisible until a reload. The frozen-cursor catch-up below still supplies continuity.
		this.demanded.add(collection);
		this.publishSubscriptions();

		let onFirstPage: () => void = () => {};
		const firstPage = new Promise<void>((resolve) => {
			onFirstPage = resolve;
		});

		const catchUp = this.runCatchUp(collection, () => onFirstPage()).finally(() => {
			this.inFlight.delete(collection);
			this.demanded.delete(collection);
			this.publishSubscriptions();
			onFirstPage();
		});
		this.inFlight.set(collection, firstPage);
		void catchUp.catch(() => undefined);
		return firstPage;
	}

	/** Bytes already committed to other collections, which this one has to fit alongside. */
	private bytesHeldExcluding(collection: string): number {
		let total = 0;
		for (const [name, entry] of this.meta) {
			if (name !== collection) total += entry.bytes;
		}
		return total;
	}

	private markReady(collection: string, rows: number, bytes: number): void {
		if (this.meta.get(collection)?.ready) return;
		this.meta.set(collection, {
			ready: true,
			fresh: true,
			synced: false,
			resident: false,
			rows,
			bytes
		});
		this.publishSubscriptions();
		// Tell the UI the replica just warmed up; otherwise the rows sit in PGlite unread
		// until some unrelated change happens to invalidate the query.
		this.client.notifyCollection(collection);
	}

	private async finishCatchUp(
		collection: string,
		rows: number,
		bytes: number,
		resident: boolean,
		trustworthy: boolean
	): Promise<void> {
		this.meta.set(collection, {
			ready: true,
			fresh: true,
			synced: trustworthy,
			resident,
			rows,
			bytes
		});
		this.publishSubscriptions();
		// Only a trustworthy stop is persisted. Recording an untrustworthy one would make the next
		// reload restore it as synced and re-introduce the empty-table-over-real-data state.
		if (trustworthy) {
			await this.client.recordSyncState(collection, resident, rows, bytes).catch(() => undefined);
		}
		this.client.notifyCollection(collection);
	}

	private async runCatchUp(collection: string, onFirstPage: () => void): Promise<void> {
		const budget = Math.max(0, this.residencyBytes - this.bytesHeldExcluding(collection));
		let rows = 0;
		let bytes = 0;

		try {
			// Keep the live stream up through the first page so waitForSequence / queryLocal are
			// not parked behind a multi-page snapshot. Remaining pages freeze the cursor below.
			const page = await this.client.shapeSubscribe({
				collection,
				cursor: null,
				pageSize: FIRST_PAGE_SIZE
			});
			rows += page.rows.length;
			bytes += approximateBytes(page.rows);
			this.markReady(collection, rows, bytes);
			onFirstPage();

			const stop = catchUpStop(page, rows, bytes, budget, this.maxResidentRows);
			if (stop.done) {
				await this.finishCatchUp(collection, rows, bytes, stop.resident, stop.trustworthy);
				return;
			}

			const nextCursor = page.nextCursor;
			if (nextCursor === null) return;
			this.remainderQueue = this.remainderQueue
				.then(() => this.runRemainder(collection, nextCursor, rows, bytes, budget))
				.catch(() => undefined);
		} catch {
			// Leave the collection unregistered so the next read retries. Reads go to the server in
			// the meantime, so a failed catch-up costs latency, never correctness.
			if (!this.meta.get(collection)?.ready) this.meta.delete(collection);
		}
	}

	private async runRemainder(
		collection: string,
		cursor: string,
		rows: number,
		bytes: number,
		budget: number
	): Promise<void> {
		// Freeze the global cursor while materializing the rest of this collection. If another
		// subscribed collection advanced the cursor during the snapshot, changes to this collection
		// could be skipped forever. Replaying from the frozen cursor after the catch-up is
		// idempotent and also resolves delete-vs-later-page races without local tombstones.
		await this.client.stopStream();
		try {
			let next = cursor;
			for (;;) {
				const page = await this.client.shapeSubscribe({
					collection,
					cursor: next,
					pageSize: PAGE_SIZE
				});
				rows += page.rows.length;
				bytes += approximateBytes(page.rows);

				const stop = catchUpStop(page, rows, bytes, budget, this.maxResidentRows);
				if (stop.done) {
					await this.finishCatchUp(collection, rows, bytes, stop.resident, stop.trustworthy);
					return;
				}
				if (page.nextCursor === null) return;
				next = page.nextCursor;
			}
		} catch {
			if (!this.meta.get(collection)?.ready) this.meta.delete(collection);
		} finally {
			this.client.startStream();
		}
	}

	get size(): number {
		let count = 0;
		for (const entry of this.meta.values()) if (entry.ready) count += 1;
		return count;
	}
}
