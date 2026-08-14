/**
 * The workspace finder: one prefix language, one record fan-out, two surfaces (`@` and Cmd+/).
 *
 * `#` records, `!` plan, `/` apps, `>` commands. After `#`, the first token becomes a collection
 * scope when it uniquely matches a mentionable collection. Record search is opt-in: it runs only
 * after a collection is chosen, against that one collection — replica first, server fallback.
 *
 * `@` mentions workspace entities: records (including people and teams), collections, and apps.
 * System plumbing collections stay out of the fan-out; `user` and `team` are the allowlisted
 * exceptions.
 */
import { isSearchableCollectionField } from '@norbital-ai/platform-utils/collection';
import { resolveRecordDisplayLabel } from '@norbital-ai/platform-utils/manifest/context';
import type { ManifestCollectionEntry } from '@norbital-ai/platform-utils/manifest/types';
import type { ManifestContext } from '@norbital-ai/platform-utils/manifest/context';
import type { MentionRecordHit } from '$lib/shared/agent/mention.js';
import { post } from '$lib/ui/state/client.js';
import { localFindMany } from '$lib/ui/sync/client-sync.js';
import { clientSyncReady } from '$lib/ui/sync/replica.js';

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

/** Returns the trigger character for a command scope. */
// stupidity:allow Q4 -- named helper
export function commandPrefixChar(scope: CommandScope): string {
	return COMMAND_PREFIX[scope];
}

/** Splits a typed command into scope, optional collection, and remaining text. */
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

/** Narrows mentionable collection names by a typed token. */
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
	readonly href?: string;
	readonly description?: string | null;
};

/** Narrows workspace apps by key or label. */
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

/** True only when a record search has both a collection and a query. */
// stupidity:allow Q4 -- named helper
export function shouldSearchRecords(parsed: ParsedCommandQuery): boolean {
	return (
		parsed.scope === 'record' && parsed.collection !== null && parsed.text.trim().length > 0
	);
}

/** Stable key for “is this the same record search?” — never the raw trigger string. */
// stupidity:allow Q4 -- named helper
export function recordSearchIdentity(parsed: ParsedCommandQuery | null): string {
	if (!parsed || !shouldSearchRecords(parsed)) return '';
	return `${parsed.collection ?? ''}\0${parsed.text.trim()}`;
}

/** Pulls a unique collection token off a `#` query when one matches. */
// stupidity:allow Q3 -- named helper
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
export type { MentionRecordHit };

/** What the `@` menu renders: a prefix command, a collection, an app, or a record to insert. */
export type MentionMenuItem =
	| { readonly kind: 'record'; readonly hit: MentionRecordHit }
	| { readonly kind: 'scope'; readonly collection: string }
	| { readonly kind: 'collection'; readonly collection: string }
	| {
			readonly kind: 'app';
			readonly key: string;
			readonly label: string;
			readonly href?: string;
			readonly description?: string | null;
	  }
	| { readonly kind: 'command'; readonly command: MentionCommand };

/** Assembles the @ menu from the current prefix, collections, records, and apps. */
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
			return filterCollections(parsed.text, collections).map(
				(collection): MentionMenuItem => ({ kind: 'scope', collection })
			);
		}
		case 'app':
			return filterApps(parsed.text, apps).map((app): MentionMenuItem => ({
				kind: 'app',
				key: app.key,
				label: app.label,
				...(app.href ? { href: app.href } : {}),
				...(app.description != null ? { description: app.description } : {})
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
			const scopes = filterCollections(parsed.text, collections).map(
				(collection): MentionMenuItem => ({ kind: 'scope', collection })
			);
			const appMentions = filterApps(parsed.text, apps).map((app): MentionMenuItem => ({
				kind: 'app',
				key: app.key,
				label: app.label,
				...(app.href ? { href: app.href } : {}),
				...(app.description != null ? { description: app.description } : {})
			}));
			return [...scopes, ...appMentions];
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

/** True when a collection is allowed in the @ / # fan-out. */
export function isMentionableCollection(entry: ManifestCollectionEntry | null): boolean {
	if (!entry) return false;
	if (MENTIONABLE_SYSTEM_COLLECTIONS.has(entry.collection_name)) {
		return (
			(entry.fields ?? []).some((field) => isSearchableCollectionField(field)) ||
			(entry.fields ?? []).some(
				(field) =>
					!field.array && (field.kind === 'text' || field.kind === 'phone' || field.kind === 'enum')
			)
		);
	}
	return (
		entry.system !== true &&
		(entry.fields ?? []).some((field) => isSearchableCollectionField(field))
	);
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
	 * Search records in one collection. A missing scope or empty query searches nothing — the
	 * writer must pick a collection first. The bare-`@` / `#` state is the scope list.
	 */
	search(query: string, scope: string | null): Promise<readonly MentionRecordHit[]>;
};

/** Builds the collection, app, and record search surface for the mention menu. */
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
	// stupidity:allow Q3 -- named helper
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
				.filter(
					(collection) =>
						collection.system !== true &&
						(collection.fields ?? []).some((field) => isSearchableCollectionField(field))
				)
				.map((collection) => collection.collection_name)
				.sort();
			const remaining = Math.max(0, maxSources - allowlisted.length);
			return [...allowlisted, ...tenant.slice(0, remaining)];
		} catch {
			return [];
		}
	}

	/** Lists workspace apps labelled for the mention menu. */
	// stupidity:allow Q3 -- named helper
	function mentionableApps(): MentionAppHit[] {
		try {
			return getManifestContext()
				.getApps()
				.map((app) => ({
					key: app.name,
					label: app.label?.trim() || app.name,
					href: `/app/${app.name}`,
					description: app.description ?? null
				}))
				.sort((left, right) => left.label.localeCompare(right.label));
		} catch {
			return [];
		}
	}

	/** Builds the replica/server query for one collection search. */
	// stupidity:allow Q3 -- named helper
	function findManyQuery(collection: string, query: string): Record<string, unknown> {
		let entry: ManifestCollectionEntry | null = null;
		try {
			entry = getManifestContext().findCollection(collection);
		} catch {
			entry = null;
		}
		if (entry && (entry.fields ?? []).some((field) => isSearchableCollectionField(field))) {
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

	/** Loads matching rows from the replica first, then the server. */
	// stupidity:allow Q3 -- named helper
	async function rowsFor(collection: string, query: string): Promise<Record<string, unknown>[]> {
		const params = findManyQuery(collection, query);
		try {
			const sync = await clientSyncReady();
			if (sync) {
				const local = await localFindMany(sync, collection, params);
				if (local) return local.rows;
			}
		} catch { // stupidity:ignore -- replica miss falls through to the server
			// The server path below is the fallback for any local failure, not an error of record.
		}
		const page = await post<{ rows: Record<string, unknown>[] }>('collections/findMany', {
			collection,
			...params
		});
		return page.rows;
	}

	/** Labels one found row for the mention menu, or drops it without an id. */
	// stupidity:allow Q3 -- named helper
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
		} catch { // stupidity:ignore -- label miss keeps the id fallback
			// A label failure costs the pretty name, never the hit.
		}
		return { collection, recordId, label };
	}

	return {
		collections: mentionableCollections,
		apps: mentionableApps,
		/** Searches one chosen collection and returns labelled record hits. */
		async search(query, scope) {
			const trimmed = query.trim();
			if (!trimmed || !scope) return [];
			let names: string[];
			try {
				const entry = getManifestContext().findCollection(scope);
				names = isMentionableCollection(entry) ? [scope] : [];
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
