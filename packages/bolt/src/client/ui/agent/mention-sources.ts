/**
 * The workspace finder: one prefix language, one record fan-out, two surfaces (`@` and Cmd+/).
 *
 * Bolt ships a minimal mention source adapter; hosts wire search through their transport later.
 */
import { Effect, Result, Schema } from 'effect';
import type { WorkspaceClient } from '#lib/client/ui/studio/workspace-client.js';
export {
	consumeTrigger,
	findMentionTrigger,
	insertMention,
	mentionDeletion,
	reconcileAfterEdit,
	rewriteTriggerQuery,
	serializeMentions
} from './composer-mentions.js';
export type { ComposerMention, MentionTrigger } from './composer-mentions.js';

export const COMMAND_SCOPES = ['record', 'plan', 'app', 'command'] as const;
export type CommandScope = (typeof COMMAND_SCOPES)[number];

const COMMAND_PREFIX: Readonly<Record<CommandScope, string>> = {
	record: '#',
	plan: '!',
	app: '/',
	command: '>'
};
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

type MentionAppHit = {
	readonly key: string;
	readonly label: string;
	readonly href?: string | undefined;
	readonly description?: string | null | undefined;
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
function filterApps(token: string, apps: readonly MentionAppHit[]): readonly MentionAppHit[] {
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

/** One app as the menu row that mentions it. */
const appMenuItem = (app: MentionAppHit): MentionMenuItem => ({
	kind: 'app',
	key: app.key,
	label: app.label,
	...(app.href ? { href: app.href } : {}),
	...(app.description != null ? { description: app.description } : {})
});

/** One collection as the scope row that narrows the menu to it. */
const scopeMenuItem = (collection: string): MentionMenuItem => ({ kind: 'scope', collection });

/** Assembles the @ menu from the current prefix, collections, records, and apps. */
function buildMentionMenuEntries(
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
			return filterCollections(parsed.text, collections).map(scopeMenuItem);
		}
		case 'app':
			return filterApps(parsed.text, apps).map(appMenuItem);
		case 'command':
			return [];
		case null: {
			if (!parsed.text.trim()) {
				return [
					{ kind: 'command', command: 'record' },
					{ kind: 'command', command: 'plan' },
					{ kind: 'command', command: 'app' },
					...collections.map(scopeMenuItem)
				];
			}
			return [
				...filterCollections(parsed.text, collections).map(scopeMenuItem),
				...filterApps(parsed.text, apps).map(appMenuItem)
			];
		}
		default:
			// `scope` is `null` when the text carries no command prefix — there is nothing to mention
			// yet. It was written as an exhaustiveness check, which cannot hold because `null` is a
			// real member of the union rather than a case someone forgot.
			return [];
	}
}

type MentionSources = {
	collections(): readonly string[];
	apps(): readonly MentionAppHit[];
	search(query: string, scope: string | null): Effect.Effect<readonly MentionRecordHit[]>;
};

type MentionSourcesOptions = {
	readonly hitsPerSource?: number;
	readonly getCollections?: () => readonly string[];
	readonly getApps?: () => readonly MentionAppHit[];
	readonly findRecords?: WorkspaceClient['records']['findMany'];
};

/**
 * The slice of a searchable row the mention menu reads, decoded once at the command boundary.
 *
 * The candidates are nullable because an authored collection routinely has `name: null` for an
 * auto-created row — the decode must not drop a record just because its display field is empty; the
 * label fallback exists for exactly that row.
 */
const MentionRecordRow = Schema.Struct({
	id: Schema.optionalKey(Schema.NullishOr(Schema.String)),
	name: Schema.optionalKey(Schema.NullishOr(Schema.String)),
	title: Schema.optionalKey(Schema.NullishOr(Schema.String)),
	label: Schema.optionalKey(Schema.NullishOr(Schema.String)),
	email: Schema.optionalKey(Schema.NullishOr(Schema.String))
});

function readRecordLabel(
	collection: string,
	row: Schema.Schema.Type<typeof MentionRecordRow>
): string {
	const candidates = ['name', 'title', 'label', 'email'] as const;
	for (const key of candidates) {
		const value = row[key];
		if (typeof value === 'string' && value.trim()) return value.trim();
	}
	const id = row.id;
	if (typeof id === 'string' && id.length > 0) return id;
	return collection;
}

/** Builds the collection, app, and record search surface for the mention menu. */
export function createMentionSources(options: MentionSourcesOptions = {}): MentionSources {
	const hitsPerSource = options.hitsPerSource ?? 8;
	// The decoder is a pure function of nothing — built once for every record rather than per row.
	const decodeMentionRow = Schema.decodeUnknownResult(MentionRecordRow);
	return {
		collections() {
			const getCollections = options.getCollections;
			if (getCollections === undefined) return [];
			return Effect.runSync(
				Effect.try(() =>
					[...getCollections()].sort((left, right) => left.localeCompare(right))
				).pipe(Effect.catch(() => Effect.succeed<readonly string[]>([])))
			);
		},
		apps() {
			const getApps = options.getApps;
			if (getApps === undefined) return [];
			return Effect.runSync(
				Effect.try(() =>
					[...getApps()].sort((left, right) => left.label.localeCompare(right.label))
				).pipe(Effect.catch(() => Effect.succeed<readonly MentionAppHit[]>([])))
			);
		},
		search(query, collection) {
			if (!collection || query.trim().length === 0) return Effect.succeed([]);
			const findRecords = options.findRecords;
			if (findRecords === undefined) return Effect.succeed([]);
			const text = query.trim();
			return Effect.tryPromise(() =>
				findRecords(collection, {
					search: { mode: 'lexical', term: text },
					limit: hitsPerSource
				})
			).pipe(
				Effect.map((rows) =>
					rows.flatMap((entry): readonly MentionRecordHit[] => {
						const row = Result.getOrElse(decodeMentionRow(entry), () => undefined);
						if (row === undefined) return [];
						const recordId = row.id ?? '';
						if (!recordId) return [];
						return [
							{
								collection,
								recordId,
								label: readRecordLabel(collection, row)
							}
						];
					})
				),
				Effect.catch(() => Effect.succeed<readonly MentionRecordHit[]>([]))
			);
		}
	};
}
