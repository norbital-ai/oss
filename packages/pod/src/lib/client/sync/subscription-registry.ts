import type { PodSyncClient } from './pod-sync-client.js';
import type { CollectionSyncState } from './types.js';

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
 * A row count is the wrong unit for a storage budget: 25,000 rows of a four-column lookup table
 * and 25,000 rows of a wide document collection differ by orders of magnitude on disk, and the
 * browser's quota is measured in bytes. The budget is shared, so a large collection consumes the
 * allowance that would otherwise have made three small ones resident, which is the correct
 * trade — the small ones are the ones that pay off.
 *
 * Reaching it is not an error. A collection that does not fit is *windowed*: reads that provably
 * fall inside what is local are answered locally, and anything else is answered by the server,
 * which has the indexes for it.
 */
export const DEFAULT_RESIDENCY_BYTES = 1_073_741_824; // 1 GiB

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
	private catchUpQueue: Promise<void> = Promise.resolve();
	private restoring: Promise<void> | null = null;
	private readonly residencyBytes: number;

	private publishSubscriptions(): void {
		this.client.setSubscribedCollections(
			[...this.meta].flatMap(([collection, meta]) => (meta.ready ? [collection] : []))
		);
	}

	constructor(
		private readonly client: PodSyncClient,
		options?: { readonly residencyBytes?: number }
	) {
		this.residencyBytes = options?.residencyBytes ?? DEFAULT_RESIDENCY_BYTES;
		// The server's data was reset out from under us and the replica has been discarded. Forget
		// what we believed was local, or every collection would still report itself resident while
		// holding nothing.
		this.client.onReset?.(() => {
			this.meta.clear();
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

		let onFirstPage: () => void = () => {};
		const firstPage = new Promise<void>((resolve) => {
			onFirstPage = resolve;
		});

		const catchUp = this.catchUpQueue
			.then(() => this.runCatchUp(collection, () => onFirstPage()))
			.finally(() => {
				this.inFlight.delete(collection);
				onFirstPage();
			});
		this.catchUpQueue = catchUp.catch(() => undefined);
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

	private async runCatchUp(collection: string, onFirstPage: () => void): Promise<void> {
		let cursor: string | null = null;
		let rows = 0;
		let bytes = 0;
		let resident = false;
		let firstPage = true;
		// A catch-up may stop for three reasons, and only two of them mean the local rows can be
		// trusted as an answer. Reaching the end of the data, or the budget, is a real stopping
		// point. A server that offers a cursor and then sends nothing is not — see below.
		let trustworthy = false;
		const budget = Math.max(0, this.residencyBytes - this.bytesHeldExcluding(collection));

		// Freeze the global cursor while materializing this collection. If another subscribed
		// collection advanced the cursor during the snapshot, changes to this new collection could
		// be skipped forever. Replaying from the frozen cursor after the catch-up is idempotent and
		// also resolves delete-vs-later-page races without local tombstones.
		await this.client.stopStream();
		try {
			for (;;) {
				const page = await this.client.shapeSubscribe({
					collection,
					cursor,
					pageSize: firstPage ? FIRST_PAGE_SIZE : PAGE_SIZE
				});
				rows += page.rows.length;
				bytes += approximateBytes(page.rows);

				if (firstPage) {
					firstPage = false;
					onFirstPage();
				}
				if (!this.meta.get(collection)?.ready) {
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

				if (page.nextCursor === null) {
					resident = true;
					trustworthy = true;
					break;
				}
				// An empty page that still offers a cursor would spin forever, so stop — but do NOT
				// call the collection complete. It used to, and that is how a table renders "no
				// records" over data that exists: the server says "there is more" and sends none of
				// it, the replica records itself as fully synced and empty, and from then on it
				// answers every read locally with nothing. Leaving it untrusted sends reads to the
				// server, which is the only party that can say whether the collection is really empty.
				if (page.rows.length === 0) break;
				// Over the shared budget: this collection is windowed. Stop rather than keep pulling —
				// the rows already here still serve reads that fall inside them, and the server owns
				// everything past the edge.
				if (bytes >= budget) {
					trustworthy = true;
					break;
				}
				cursor = page.nextCursor;
			}
		} catch {
			// Leave the collection unregistered so the next read retries. Reads go to the server in
			// the meantime, so a failed catch-up costs latency, never correctness.
			if (!this.meta.get(collection)?.ready) this.meta.delete(collection);
			this.client.startStream();
			return;
		}

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
		this.client.startStream();
	}

	get size(): number {
		let count = 0;
		for (const entry of this.meta.values()) if (entry.ready) count += 1;
		return count;
	}
}
