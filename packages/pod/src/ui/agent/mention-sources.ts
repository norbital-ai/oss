/**
 * Where the composer's "@" menu gets its records.
 *
 * One source per mentionable collection, fanned out flat: a query searches every source at once
 * and the results merge into one grouped list. The local replica answers first — a typeahead
 * query is a string match over rows the device already holds — and only a read the replica cannot
 * serve (a windowed collection, no replica yet) costs a round trip. Every source is capped and
 * failures stay per-source, so one broken collection degrades the menu by one group, never all of
 * it.
 */
import { post } from '$lib/ui/state/client.js';
import { clientSyncReady } from '$lib/ui/sync/replica.js';
import { localFindMany } from '$lib/ui/sync/client-sync.js';
import { isSearchableCollectionField } from '@norbital-ai/platform-utils/collection';
import { resolveRecordDisplayLabel } from '@norbital-ai/platform-utils/manifest/context';
import type { ManifestCollectionEntry } from '@norbital-ai/platform-utils/manifest/types';
import type { ManifestContext } from '@norbital-ai/platform-utils/manifest/context';

/** One record the menu can offer, already labelled for display. */
export type MentionRecordHit = {
	readonly collection: string;
	readonly recordId: string;
	readonly label: string;
};

/** What the menu renders: a record to insert, or a collection to narrow the search to. */
export type MentionMenuItem =
	| { readonly kind: 'record'; readonly hit: MentionRecordHit }
	| { readonly kind: 'scope'; readonly collection: string };

/**
 * How many collections one keystroke burst may search. Tenant schemas are small, but the cap keeps
 * the fan-out bounded no matter how large one grows; which collections make the cut is
 * alphabetical, which is arbitrary but at least deterministic.
 *
 * Only collections with at least one searchable (indexed) field are candidates at all — a
 * collection of pure numbers, dates, JSON or relations has nothing a search can match, and
 * searching it returns either nothing or, server-side, rows the query never filtered.
 */
const MAX_SOURCES = 12;

/** Rows per source per query. The menu shows a short list, so the wire carries one. */
const HITS_PER_SOURCE = 4;

/** How the composer's "@" menu sizes its search, unless a caller opts into different limits. */
export type MentionSourcesOptions = {
	/** Cap on collections searched per burst, first N alphabetically. */
	readonly maxSources?: number;
	/** Cap on rows returned per collection per query. */
	readonly hitsPerSource?: number;
};

export type MentionSearchOptions = {
	readonly signal?: AbortSignal;
	/**
	 * Called with each source's hits as that source resolves, before the merged answer. A palette
	 * that renders progressively stops waiting on the slowest collection of the fan-out; the
	 * mention menu ignores it and renders only the final merged list.
	 */
	readonly onHits?: (hits: readonly MentionRecordHit[]) => void;
};

export type MentionSources = {
	/** The collections a bare `@` can narrow to, in menu order. */
	collections(): readonly string[];
	/**
	 * Search records. A scope names one collection; without one every mentionable collection is
	 * searched. An empty query searches nothing — the bare-`@` state is the scope list, not a
	 * full-table dump.
	 */
	search(
		query: string,
		scope: string | null,
		options?: MentionSearchOptions
	): Promise<readonly MentionRecordHit[]>;
};

export function createMentionSources(
	getManifestContext: () => ManifestContext,
	options: MentionSourcesOptions = {}
): MentionSources {
	const maxSources = options.maxSources ?? MAX_SOURCES;
	const hitsPerSource = options.hitsPerSource ?? HITS_PER_SOURCE;

	/**
	 * A collection can only be searched when it has at least one searchable field — the same
	 * text/phone/enum fields the server indexes and the normal collection search matches on. A
	 * collection without one has nothing to match against, so it is not part of the fan-out at
	 * all: the server would otherwise return its rows unfiltered (its search clause compiles to
	 * nothing) and every local query would be a scan over a predicate that can never hold.
	 */
	function isSearchableCollection(entry: ManifestCollectionEntry | null): boolean {
		return (entry?.fields ?? []).some((field) => isSearchableCollectionField(field));
	}

	function mentionableCollections(): string[] {
		try {
			return getManifestContext()
				.getCollections()
				.filter(
					(collection) =>
						collection.system !== true && isSearchableCollection(collection)
				)
				.map((collection) => collection.collection_name)
				.sort()
				.slice(0, maxSources);
		} catch {
			return [];
		}
	}

	async function rowsFor(
		collection: string,
		query: string,
		signal: AbortSignal | undefined
	): Promise<Record<string, unknown>[]> {
		try {
			const sync = await clientSyncReady();
			if (sync) {
				const local = await localFindMany(sync, collection, {
					search: query,
					limit: hitsPerSource
				});
				if (local) return local.rows;
			}
		} catch {
			// The server path below is the fallback for any local failure, not an error of record.
		}
		const page = await post<{ rows: Record<string, unknown>[] }>(
			'collections/findMany',
			{ collection, search: query, limit: hitsPerSource },
			signal
		);
		return page.rows;
	}

	function toHit(collection: string, row: Record<string, unknown>): MentionRecordHit | null {
		const recordId = row.norbital_id;
		if (typeof recordId !== 'string') return null;
		let label = `ID: ${recordId}`;
		try {
			const manifestContext = getManifestContext();
			label = resolveRecordDisplayLabel(
				manifestContext.findCollection(collection),
				row,
				manifestContext.columnsFor(collection)
			).text;
		} catch {
			// A label failure costs the pretty name, never the hit.
		}
		return { collection, recordId, label };
	}

	return {
		collections: mentionableCollections,
		async search(query, scope, searchOptions) {
			const trimmed = query.trim();
			if (!trimmed) return [];
			let names: string[];
			try {
				names = scope
					? isSearchableCollection(getManifestContext().findCollection(scope))
						? [scope]
						: []
					: mentionableCollections();
			} catch {
				return [];
			}
			const settled = await Promise.allSettled(
				names.map(async (collection) => {
					const rows = await rowsFor(collection, trimmed, searchOptions?.signal);
					const hits = rows
						.map((row) => toHit(collection, row))
						.filter((hit): hit is MentionRecordHit => hit !== null);
					searchOptions?.onHits?.(hits);
					return hits;
				})
			);
			return settled.flatMap((result) => (result.status === 'fulfilled' ? result.value : []));
		}
	};
}
