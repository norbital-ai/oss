import type { PodSyncClient } from './pod-sync-client.js';
import type { CollectionSyncState } from './types.js';

const PAGE_SIZE = 1000;

/**
 * How many rows a collection may hold before it stops being *resident* (fully local) and becomes
 * *windowed*.
 *
 * The budget is small on purpose. A collection that fits is fully local within a few round-trips;
 * one that doesn't is abandoned immediately rather than speculatively pulling tens of thousands of
 * rows. Speculative pulling is not just slow — a window materialised under one sort order is
 * useless for a different one, so most of those rows would be dead weight. Windowed collections
 * instead accumulate their working set from the queries the app actually makes
 * (`absorbServerRows`), which converges on what this user touches.
 *
 * Note this counts *policy-scoped* rows. A million-row table is often a few thousand rows for any
 * one user, and those users get the fully-local experience with no special handling.
 */
export const DEFAULT_RESIDENCY_CAP = 25_000;

type CollectionMeta = {
	/** Rows are local and safe to read. */
	ready: boolean;
	/** Every policy-visible row is local — counts, search and end-of-data are answerable offline. */
	resident: boolean;
	rows: number;
};

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
	private restoring: Promise<void> | null = null;
	private readonly residencyCap: number;

	constructor(
		private readonly client: PodSyncClient,
		options?: { readonly residencyCap?: number }
	) {
		this.residencyCap = options?.residencyCap ?? DEFAULT_RESIDENCY_CAP;
		// The server's data was reset out from under us and the replica has been discarded. Forget
		// what we believed was local, or every collection would still report itself resident while
		// holding nothing.
		this.client.onReset?.(() => {
			this.meta.clear();
			this.restoring = null;
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
					this.meta.set(collection, { ready: true, resident: state.resident, rows: state.rows });
				}
			});
		return this.restoring;
	}

	has(collection: string): boolean {
		return this.meta.get(collection)?.ready ?? false;
	}

	/** True when every policy-visible row of the collection is local. */
	isResident(collection: string): boolean {
		return this.meta.get(collection)?.resident ?? false;
	}

	/**
	 * Ensure a collection is local. Resolves as soon as the first page has landed — the caller
	 * reads immediately while any remaining pages fill in behind it.
	 */
	async register(collection: string): Promise<void> {
		return this.catchUp(collection, false);
	}

	/**
	 * Re-read every collection this identity has touched after a policy decision changes what the
	 * identity may see. Outbox diffs describe rows that changed; they cannot describe an unchanged
	 * child row that merely became visible because its parent was approved. A fresh shape supplies
	 * those rows without discarding the still-valid local working set.
	 */
	async refreshAll(): Promise<void> {
		await Promise.all([...this.meta.keys()].map((collection) => this.catchUp(collection, true)));
	}

	private async catchUp(collection: string, force: boolean): Promise<void> {
		if (!force && this.meta.get(collection)?.ready) return;
		const existing = this.inFlight.get(collection);
		if (existing) return existing;

		let onFirstPage: () => void = () => {};
		const firstPage = new Promise<void>((resolve) => {
			onFirstPage = resolve;
		});

		const catchUp = this.runCatchUp(collection, () => onFirstPage()).finally(() => {
			this.inFlight.delete(collection);
			onFirstPage();
		});
		this.inFlight.set(collection, firstPage);
		void catchUp.catch(() => undefined);
		return firstPage;
	}

	private async runCatchUp(collection: string, onFirstPage: () => void): Promise<void> {
		let cursor: string | null = null;
		let rows = 0;
		let resident = false;
		let firstPage = true;

		try {
			for (;;) {
				const page = await this.client.shapeSubscribe({ collection, cursor, pageSize: PAGE_SIZE });
				rows += page.rows.length;

				if (firstPage) {
					firstPage = false;
					onFirstPage();
				}
				if (!this.meta.get(collection)?.ready) {
					this.meta.set(collection, { ready: true, resident: false, rows });
					// Tell the UI the replica just warmed up; otherwise the rows sit in PGlite unread
					// until some unrelated change happens to invalidate the query.
					this.client.notifyCollection(collection);
					// Stream from the moment there is anything to keep live. Waiting for the whole
					// catch-up would leave a large collection stale for its entire download.
					this.client.startStream();
				}

				if (page.nextCursor === null) {
					resident = true;
					break;
				}
				// An empty page that still offers a cursor would spin forever. Treat it as the end
				// of the data rather than trusting the cursor — the stream keeps us correct either
				// way, and a hung catch-up loop would take the whole tab with it.
				if (page.rows.length === 0) {
					resident = true;
					break;
				}
				// Over budget: this collection is windowed. Stop rather than keep pulling.
				if (rows >= this.residencyCap) break;
				cursor = page.nextCursor;
			}
		} catch {
			// Leave the collection unregistered so the next read retries. Reads go to the server in
			// the meantime, so a failed catch-up costs latency, never correctness.
			if (!this.meta.get(collection)?.ready) this.meta.delete(collection);
			this.client.startStream();
			return;
		}

		this.meta.set(collection, { ready: true, resident, rows });
		await this.client.recordSyncState(collection, resident, rows).catch(() => undefined);
		this.client.notifyCollection(collection);
		this.client.startStream();
	}

	get size(): number {
		let count = 0;
		for (const entry of this.meta.values()) if (entry.ready) count += 1;
		return count;
	}
}
