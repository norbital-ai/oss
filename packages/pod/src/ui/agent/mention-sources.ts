/**
 * The workspace finder: one prefix language, one record fan-out, two surfaces (`@` and Cmd+/).
 *
 * `#` records, `!` plan, `/` apps, `>` commands. After `#`, the first token becomes a collection
 * scope when it uniquely matches a mentionable collection. Record search fans out to those
 * collections — replica first, server fallback — and failures stay per-source.
 *
 * `@` mentions workspace entities: records (including people and teams), collections, and apps.
 * System plumbing collections stay out of the fan-out; `user` and `team` are the allowlisted
 * exceptions.
 */
import { post } from '$lib/ui/state/client.js';
import { clientSyncReady } from '$lib/ui/sync/replica.js';
import { localFindMany } from '$lib/ui/sync/client-sync.js';
import { isSearchableCollectionField } from '@norbital-ai/platform-utils/collection';
import { resolveRecordDisplayLabel } from '@norbital-ai/platform-utils/manifest/context';
import type { ManifestCollectionEntry } from '@norbital-ai/platform-utils/manifest/types';
import type { ManifestContext } from '@norbital-ai/platform-utils/manifest/context';

export const COMMAND_PREFIX = {
	record: '#',
	plan: '!',
	app: '/',
	command: '>'
} as const;

export type CommandScope = keyof typeof COMMAND_PREFIX;
export type MentionCommand = Extract<CommandScope, 'record' | 'plan' | 'app'>;

/** System collections a person can `@` — people and teams, not platform plumbing. */
export const MENTIONABLE_SYSTEM_COLLECTIONS: ReadonlySet<string> = new Set(['user', 'team']);

export type ParsedCommandQuery = {
	readonly scope: CommandScope | null;
	readonly collection: string | null;
	readonly text: string;
	readonly raw: string;
};

const PREFIX_BY_CHAR: Readonly<Record<string, CommandScope>> = {
	[COMMAND_PREFIX.record]: 'record',
	[COMMAND_PREFIX.plan]: 'plan',
	[COMMAND_PREFIX.app]: 'app',
	[COMMAND_PREFIX.command]: 'command'
};

export function commandPrefixChar(scope: CommandScope): string {
	return COMMAND_PREFIX[scope];
}

export function parseCommandQuery(
	raw: string,
	collections: readonly string[] = []
): ParsedCommandQuery {
	const scope = PREFIX_BY_CHAR[raw[0] ?? ''];
	if (!scope) return { scope: null, collection: null, text: raw, raw };
	const rest = raw.slice(1);
	if (scope === 'record') {
		const matched = matchCollectionToken(rest, collections);
		return { scope, collection: matched.collection, text: matched.text, raw };
	}
	return { scope, collection: null, text: rest.trimStart(), raw };
}

export function filterCollections(
	token: string,
	collections: readonly string[]
): readonly string[] {
	const needle = token.trim().toLowerCase();
	if (!needle) return collections;
	return collections.filter((collection) => collection.toLowerCase().includes(needle));
}

export type MentionAppHit = {
	readonly key: string;
	readonly label: string;
};

export function filterApps(
	token: string,
	apps: readonly MentionAppHit[]
): readonly MentionAppHit[] {
	const needle = token.trim().toLowerCase();
	if (!needle) return apps;
	return apps.filter(
		(app) => app.key.toLowerCase().includes(needle) || app.label.toLowerCase().includes(needle)
	);
}

export function shouldSearchRecords(parsed: ParsedCommandQuery): boolean {
	return parsed.text.trim().length > 0 && (parsed.scope === 'record' || parsed.scope === null);
}

/** Stable key for “is this the same record search?” — never the raw trigger string. */
export function recordSearchIdentity(parsed: ParsedCommandQuery | null): string {
	if (!parsed || !shouldSearchRecords(parsed)) return '';
	return `${parsed.collection ?? ''}\0${parsed.text.trim()}`;
}

function matchCollectionToken(
	rest: string,
	collections: readonly string[]
): { collection: string | null; text: string } {
	if (rest.length === 0) return { collection: null, text: '' };
	if (rest[0] && /\s/.test(rest[0])) return { collection: null, text: rest.trimStart() };
	const space = rest.search(/\s/);
	const token = space === -1 ? rest : rest.slice(0, space);
	const after = space === -1 ? '' : rest.slice(space).trimStart();
	const lower = token.toLowerCase();
	const exact = collections.find((collection) => collection.toLowerCase() === lower);
	if (exact) return { collection: exact, text: after };
	const prefixed = collections.filter((collection) => collection.toLowerCase().startsWith(lower));
	if (prefixed.length === 1) return { collection: prefixed[0] ?? null, text: after };
	return { collection: null, text: rest };
}

/** One record the menu can offer, already labelled for display. */
export type MentionRecordHit = {
	readonly collection: string;
	readonly recordId: string;
	readonly label: string;
};

/** What the `@` menu renders: a prefix command, a collection, an app, or a record to insert. */
export type MentionMenuItem =
	| { readonly kind: 'record'; readonly hit: MentionRecordHit }
	| { readonly kind: 'scope'; readonly collection: string }
	| { readonly kind: 'collection'; readonly collection: string }
	| { readonly kind: 'app'; readonly key: string; readonly label: string }
	| { readonly kind: 'command'; readonly command: MentionCommand };

export function buildMentionMenuEntries(
	parsed: ParsedCommandQuery,
	collections: readonly string[],
	records: readonly MentionMenuItem[],
	apps: readonly MentionAppHit[] = []
): readonly MentionMenuItem[] {
	switch (parsed.scope) {
		case 'plan':
			return [{ kind: 'command', command: 'plan' }];
		case 'record': {
			if (parsed.collection) return records;
			const scopes = filterCollections(parsed.text, collections).map(
				(collection): MentionMenuItem => ({ kind: 'scope', collection })
			);
			return parsed.text.trim() ? [...scopes, ...records] : scopes;
		}
		case 'app':
			return filterApps(parsed.text, apps).map((app): MentionMenuItem => ({
				kind: 'app',
				key: app.key,
				label: app.label
			}));
		case 'command':
			return [];
		case null: {
			if (!parsed.text.trim()) {
				return [
					{ kind: 'command', command: 'record' },
					{ kind: 'command', command: 'plan' },
					{ kind: 'command', command: 'app' },
					...collections.map((collection): MentionMenuItem => ({ kind: 'scope', collection }))
				];
			}
			const collectionMentions = filterCollections(parsed.text, collections).map(
				(collection): MentionMenuItem => ({ kind: 'collection', collection })
			);
			const appMentions = filterApps(parsed.text, apps).map((app): MentionMenuItem => ({
				kind: 'app',
				key: app.key,
				label: app.label
			}));
			return [...records, ...collectionMentions, ...appMentions];
		}
		default: {
			const _exhaustive: never = parsed.scope;
			return _exhaustive;
		}
	}
}

/**
 * How many collections one keystroke burst may search. Tenant schemas are small, but the cap keeps
 * the fan-out bounded no matter how large one grows; which collections make the cut is
 * alphabetical, which is arbitrary but at least deterministic.
 *
 * Only collections with at least one searchable (indexed) field are candidates at all — a
 * collection of pure numbers, dates, JSON or relations has nothing a search can match, and
 * searching it returns either nothing or, server-side, rows the query never filtered.
 *
 * `user` and `team` are included even when their text fields were not opted into the trigram
 * index: mentioning a person is the point of `@`, and those rows are matched with an `ilike`
 * fallback rather than dropped from the menu.
 */
const MAX_SOURCES = 12;

/** Rows per source per query. The menu shows a short list, so the wire carries one. */
const HITS_PER_SOURCE = 4;

function isSearchableCollection(entry: ManifestCollectionEntry | null): boolean {
	return (entry?.fields ?? []).some((field) => isSearchableCollectionField(field));
}

function hasTextFields(entry: ManifestCollectionEntry | null): boolean {
	return (entry?.fields ?? []).some(
		(field) =>
			!field.array && (field.kind === 'text' || field.kind === 'phone' || field.kind === 'enum')
	);
}

export function isMentionableCollection(entry: ManifestCollectionEntry | null): boolean {
	if (!entry) return false;
	if (MENTIONABLE_SYSTEM_COLLECTIONS.has(entry.collection_name)) {
		return isSearchableCollection(entry) || hasTextFields(entry);
	}
	return entry.system !== true && isSearchableCollection(entry);
}

/** How the composer's "@" menu sizes its search, unless a caller opts into different limits. */
export type MentionSourcesOptions = {
	/** Cap on collections searched per burst, first N alphabetically. */
	readonly maxSources?: number;
	/** Cap on rows returned per collection per query. */
	readonly hitsPerSource?: number;
};

export type MentionSources = {
	/** The collections a bare `@` can narrow to, in menu order. */
	collections(): readonly string[];
	/** Apps from the workspace manifest, labelled for the menu. */
	apps(): readonly MentionAppHit[];
	/**
	 * Search records. A scope names one collection; without one every mentionable collection is
	 * searched. An empty query searches nothing — the bare-`@` state is the scope list, not a
	 * full-table dump.
	 */
	search(query: string, scope: string | null): Promise<readonly MentionRecordHit[]>;
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
	 *
	 * Allowlisted system collections (`user`, `team`) are the exception: they are mentionable
	 * even when the compiled field list has no `search: true`, and those queries use an `ilike`
	 * fallback over their text fields.
	 */
	function mentionableCollections(): string[] {
		try {
			const entries = getManifestContext().getCollections();
			const allowlisted = entries
				.filter(
					(collection) =>
						MENTIONABLE_SYSTEM_COLLECTIONS.has(collection.collection_name) &&
						isMentionableCollection(collection)
				)
				.map((collection) => collection.collection_name)
				.sort();
			const tenant = entries
				.filter((collection) => collection.system !== true && isSearchableCollection(collection))
				.map((collection) => collection.collection_name)
				.sort();
			const remaining = Math.max(0, maxSources - allowlisted.length);
			return [...allowlisted, ...tenant.slice(0, remaining)];
		} catch {
			return [];
		}
	}

	function mentionableApps(): MentionAppHit[] {
		try {
			return getManifestContext()
				.getApps()
				.map((app) => ({
					key: app.name,
					label: app.label?.trim() || app.name
				}))
				.sort((left, right) => left.label.localeCompare(right.label));
		} catch {
			return [];
		}
	}

	function findManyQuery(collection: string, query: string): Record<string, unknown> {
		let entry: ManifestCollectionEntry | null = null;
		try {
			entry = getManifestContext().findCollection(collection);
		} catch {
			entry = null;
		}
		if (entry && isSearchableCollection(entry)) {
			return { search: query, limit: hitsPerSource };
		}
		const textFields = (entry?.fields ?? []).filter(
			(field) =>
				!field.array && (field.kind === 'text' || field.kind === 'phone' || field.kind === 'enum')
		);
		if (textFields.length === 0) {
			return { search: query, limit: hitsPerSource };
		}
		const pattern = `%${query.replace(/([\\%_])/g, '\\$1')}%`;
		return {
			where: {
				OR: textFields.map((field) => ({ [field.name]: { ilike: pattern } }))
			},
			limit: hitsPerSource
		};
	}

	async function rowsFor(collection: string, query: string): Promise<Record<string, unknown>[]> {
		const params = findManyQuery(collection, query);
		try {
			const sync = await clientSyncReady();
			if (sync) {
				const local = await localFindMany(sync, collection, params);
				if (local) return local.rows;
			}
		} catch {
			// The server path below is the fallback for any local failure, not an error of record.
		}
		const page = await post<{ rows: Record<string, unknown>[] }>('collections/findMany', {
			collection,
			...params
		});
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
		apps: mentionableApps,
		async search(query, scope) {
			const trimmed = query.trim();
			if (!trimmed) return [];
			let names: string[];
			try {
				if (scope) {
					const entry = getManifestContext().findCollection(scope);
					names = isMentionableCollection(entry) ? [scope] : [];
				} else {
					names = mentionableCollections();
				}
			} catch {
				return [];
			}
			const settled = await Promise.allSettled(
				names.map(async (collection) => {
					const rows = await rowsFor(collection, trimmed);
					return rows
						.map((row) => toHit(collection, row))
						.filter((hit): hit is MentionRecordHit => hit !== null);
				})
			);
			return settled.flatMap((result) => (result.status === 'fulfilled' ? result.value : []));
		}
	};
}
