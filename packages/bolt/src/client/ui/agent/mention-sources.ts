/**
 * The workspace finder: one prefix language, one record fan-out, two surfaces (`@` and Cmd+/).
 *
 * Bolt ships a minimal mention source adapter; hosts wire search through their transport later.
 */
import { rowsFrom } from '../../runtime.js';
import { getAgentRuntime } from './client.svelte.js';

export const COMMAND_PREFIX = {
	record: '#',
	plan: '!',
	app: '/',
	command: '>'
} as const;

export type CommandScope = keyof typeof COMMAND_PREFIX;
export type MentionCommand = Extract<CommandScope, 'record' | 'plan' | 'app'>;

const PREFIX_BY_CHAR: Readonly<Record<string, CommandScope>> = {
	[COMMAND_PREFIX.record]: 'record',
	[COMMAND_PREFIX.plan]: 'plan',
	[COMMAND_PREFIX.app]: 'app',
	[COMMAND_PREFIX.command]: 'command'
};

export type MentionRecordHit = {
	readonly collection: string;
	readonly recordId: string;
	readonly label: string;
};

export type MentionAppHit = {
	readonly key: string;
	readonly label: string;
	readonly href?: string;
	readonly description?: string | null;
};

/** Returns the trigger character for a command scope. */
export function commandPrefixChar(scope: CommandScope): string {
	return COMMAND_PREFIX[scope];
}

/** Splits a typed command into scope, optional collection, and remaining text. */
export function parseCommandQuery(raw: string, collections: readonly string[] = []) {
	const scope = PREFIX_BY_CHAR[raw[0] ?? ''];
	if (!scope) return { scope: null, collection: null, text: raw, raw };
	const rest = raw.slice(1);
	if (scope === 'record') {
		const matched = matchCollectionToken(rest, collections);
		return { scope, collection: matched.collection, text: matched.text, raw };
	}
	return { scope, collection: null, text: rest.trimStart(), raw };
}

export type ParsedCommandQuery = ReturnType<typeof parseCommandQuery>;

/** Narrows mentionable collection names by a typed token. */
export function filterCollections(
	token: string,
	collections: readonly string[]
): readonly string[] {
	const needle = token.trim().toLowerCase();
	if (!needle) return collections;
	return collections.filter((collection) => collection.toLowerCase().includes(needle));
}

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
export function shouldSearchRecords(parsed: ParsedCommandQuery): boolean {
	return parsed.scope === 'record' && parsed.collection !== null && parsed.text.trim().length > 0;
}

/** Stable key for “is this the same record search?” — never the raw trigger string. */
export function recordSearchIdentity(parsed: ParsedCommandQuery | null): string {
	if (!parsed || !shouldSearchRecords(parsed)) return '';
	return `${parsed.collection ?? ''}\0${parsed.text.trim()}`;
}

/** Pulls a unique collection token off a `#` query when one matches. */
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
			return filterCollections(parsed.text, collections).map((collection): MentionMenuItem => ({
				kind: 'scope',
				collection
			}));
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
		default:
			// `scope` is `null` when the text carries no command prefix — there is nothing to mention
			// yet. It was written as an exhaustiveness check, which cannot hold because `null` is a
			// real member of the union rather than a case someone forgot.
			return [];
	}
}

export type MentionSources = {
	collections(): readonly string[];
	apps(): readonly MentionAppHit[];
	search(query: string, scope: string | null): Promise<readonly MentionRecordHit[]>;
};

export type MentionSourcesOptions = {
	readonly hitsPerSource?: number;
	readonly getCollections?: () => readonly string[];
	readonly getApps?: () => readonly MentionAppHit[];
};

function readRecordLabel(collection: string, row: Record<string, unknown>): string {
	const candidates = ['name', 'title', 'label', 'email'];
	for (const key of candidates) {
		const value = row[key];
		if (typeof value === 'string' && value.trim()) return value.trim();
	}
	const id = row.norbital_id ?? row.id;
	if (typeof id === 'string' && id.length > 0) return id;
	return collection;
}

/** Builds the collection, app, and record search surface for the mention menu. */
export function createMentionSources(options: MentionSourcesOptions = {}): MentionSources {
	const hitsPerSource = options.hitsPerSource ?? 8;
	return {
		collections() {
			if (!options.getCollections) return [];
			try {
				return [...options.getCollections()].sort((left, right) => left.localeCompare(right));
			} catch {
				return [];
			}
		},
		apps() {
			if (!options.getApps) return [];
			try {
				return [...options.getApps()].sort((left, right) => left.label.localeCompare(right.label));
			} catch {
				return [];
			}
		},
		async search(query, collection) {
			if (!collection || query.trim().length === 0) return [];
			const runtime = getAgentRuntime();
			if (!runtime) return [];
			try {
				const rows = await runtime.transport.command('collections.findMany', {
					subject: runtime.subject,
					collection,
					search: query.trim(),
					limit: hitsPerSource
				});
				return (rowsFrom(rows) ?? []).flatMap((entry): readonly MentionRecordHit[] => {
					if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return [];
					const record = entry as Record<string, unknown>;
					const recordId =
						(typeof record.norbital_id === 'string' && record.norbital_id) ||
						(typeof record.id === 'string' && record.id) ||
						'';
					if (!recordId) return [];
					return [
						{
							collection,
							recordId,
							label: readRecordLabel(collection, record)
						}
					];
				});
			} catch {
				return [];
			}
		}
	};
}

export { decodeMessageText } from './message-text.js';
