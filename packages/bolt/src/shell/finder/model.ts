// Apps and pages match by title; record searches require an explicit model scope and a declared search index.
// Find and Norbius mentions share scopes, field hints, labels and record requests.
import { Cause, Effect, Fiber, FiberHandle } from 'effect';
import type { Json } from '../../decl/values.ts';
import type { Value } from '@norbital-ai/store/kind';
import type { CommandItem, KindsHost, ModelExposure } from '@norbital-ai/ui';
import { label_read } from '@norbital-ai/ui/read';
import { label as recordTitle } from '@norbital-ai/store/label';
import { based, type NavNode } from '../nav.ts';
import { handle_words } from '../i18n.ts';
import type { ManifestItem } from './manifest.ts';

export type FinderHit =
	| { kind: 'page'; key: string; label: string; context: string | null; href: string }
	| { kind: 'record'; key: string; label: string; context: string; model: string; id: string };
type Row = { readonly [field: string]: Value };
export type FinderAnswer = { readonly [root: string]: { readonly rows: readonly Row[] } };
type FinderError = Effect.Error<ReturnType<NonNullable<KindsHost['query']>>>;
/** One read request (`{ <model>: { search, limit } }`), answered per root. */
export type FinderRead = (request: {
	readonly [root: string]: { readonly [key: string]: Json };
}) => Effect.Effect<FinderAnswer, FinderError>;

const RECORDS_PER_MODEL = 8;
const has = (text: string, query: string) =>
	text.toLowerCase().includes(query.trim().toLowerCase());

/** The app pages whose title (or app title) holds `query`; every page when it is empty. */
export function pageHits(
	nav: readonly NavNode[],
	query: string,
	t: (key: string) => string
): Extract<FinderHit, { kind: 'page' }>[] {
	const out: Extract<FinderHit, { kind: 'page' }>[] = [];
	const walk = (n: NavNode, trail: string | null) => {
		if (n.kind === 'group') {
			for (const c of n.children) walk(c, t(n.title));
			return;
		}
		const app = t(n.title);
		for (const p of n.pages) {
			const label = n.pages.length === 1 ? app : t(p.title);
			const context = n.pages.length === 1 ? trail : app;
			if (has(label, query) || has(app, query))
				out.push({ kind: 'page', key: p.href, label, context, href: p.href });
		}
	};
	for (const n of nav) walk(n, null);
	return out;
}

/** The shared CEL identifier. */
export const labelOf = (row: Row, expression?: string) =>
	(typeof row['$label'] === 'string' && row['$label'].trim() !== ''
		? row['$label']
		: recordTitle(row, expression ?? [])) ?? 'Unnamed record';

/** Bolt's internal models, never a Find scope; people (`sys_user`) and approval requests are. */
const SYSTEM_MODELS = /^(sys_.*|requestor)$/;
/** The same model scopes and declared search hints serve Find and Norbius mentions. */
export function recordScopes(
	catalog: { readonly [model: string]: ModelExposure },
	t: (key: string) => string
) {
	return Object.entries(catalog)
		.map(([model, exposure]) => {
			const key = `models.${model}.label`,
				translated = t(key);
			const label =
				translated === key
					? model === 'sys_user'
						? t('Users')
						: model === 'approval_request'
							? t('Approval requests')
							: handle_words(model)
					: translated;
			const fields = [
				...new Set(
					(exposure.search ?? []).map((field) =>
						field === '$label'
							? t('Record label')
							: t(exposure.fields[field]?.label ?? handle_words(field))
					)
				)
			];
			const searchable = fields.length > 0 || exposure.semantic === true;
			const indexes = Object.entries(exposure.indexes ?? {}).map(
				([name, index]) => `${name}${index.description ? `: ${t(index.description)}` : ''}`
			);
			const description = [
				fields.length > 0
					? t('Search by {fields}.').replace('{fields}', fields.join(', '))
					: exposure.semantic === true
						? t('Search by meaning.')
						: indexes.length > 0
							? t('Text search is not enabled for this model.')
							: t('Search is not enabled for this model. No search index is declared.'),
				...(fields.length > 0 && exposure.semantic === true
					? [t('Use /semantic to search by meaning.')]
					: []),
				...(indexes.length > 0
					? [t('Custom indexes: {indexes}.').replace('{indexes}', indexes.join('; '))]
					: [])
			].join(' ');
			return { model, label, description, searchable };
		})
		.sort((a, b) => a.label.localeCompare(b.label));
}

export type SearchScope =
	| (ReturnType<typeof recordScopes>[number] & { kind: 'model'; command: string })
	| {
			kind: 'app';
			command: string;
			label: string;
			description: string;
			href: string;
			pages: FinderHit[];
	  }
	| (ManifestItem & { command: string; label: string });

export const scopeKind = (scope: SearchScope) =>
	({
		model: 'Model',
		app: 'App',
		automation: 'Automation',
		integration: 'Integration',
		connection: 'Connection',
		envoy: 'Envoy',
		mcp: 'MCP server',
		policy: 'Policy',
		team: 'Team',
		relationship: 'Relationship',
		field: 'Field type',
		skill: 'Skill',
		secret: 'Secret',
		kiosk: 'Kiosk',
		group: 'App group',
		workspace: 'Workspace',
		sync: 'Sync'
	})[scope.kind];
export const scopeIcon = (scope: SearchScope) =>
	scope.kind === 'model'
		? 'lucide:database'
		: scope.kind === 'app'
			? 'lucide:layout-grid'
			: scope.kind === 'automation' || scope.kind === 'sync'
				? 'lucide:workflow'
				: 'lucide:box';
export const canDrill = (scope: SearchScope) =>
	scope.kind === 'app' || (scope.kind === 'model' && scope.searchable);
export const scopeHref = (scope: SearchScope) =>
	scope.kind === 'model' ? `/?find=${encodeURIComponent(scope.command)}` : scope.href;

/** One command catalogue for Find, slash commands and @ mentions. App/model collisions stay explicit. */
export function searchScopes(
	nav: readonly NavNode[],
	catalog: { readonly [model: string]: ModelExposure },
	t: (key: string) => string,
	entries: readonly ManifestItem[] = []
): SearchScope[] {
	const apps = (nodes: readonly NavNode[]): SearchScope[] =>
		nodes.flatMap((node) =>
			node.kind === 'group'
				? apps(node.children)
				: [
						{
							kind: 'app' as const,
							command: Object.hasOwn(catalog, node.name) ? `app:${node.name}` : node.name,
							label: t(node.title),
							description: t(node.description),
							href: node.href,
							pages: node.pages.map((page) => ({
								kind: 'page' as const,
								key: page.href,
								label: t(page.title),
								context: t(node.title),
								href: page.href
							}))
						}
					]
		);
	return [
		...apps(nav),
		...recordScopes(catalog, t)
			.filter((scope) => scope.model === 'sys_user' || !SYSTEM_MODELS.test(scope.model))
			.map((scope) => ({ ...scope, kind: 'model' as const, command: scope.model })),
		...entries.map((entry) => ({
			...entry,
			label: t(handle_words(entry.name)),
			command: `${entry.kind}:${entry.name}`,
			description: t(entry.description)
		}))
	];
}

/** `/scope query` is shared everywhere; the space separates a whole scope name from its query. */
export function scopeQuery(scopes: readonly SearchScope[], input: string) {
	if (!input.startsWith('/')) return { explicit: false, scope: undefined, query: input };
	const text = input.slice(1);
	const match = /^(\S+)\s([\s\S]*)$/.exec(text);
	const command = match?.[1], query = match?.[2];
	if (command !== undefined && query !== undefined) {
		const scope = scopes.find((scope) => scope.command.toLowerCase() === command.toLowerCase());
		if (scope) return { explicit: true, scope, query };
	}
	return { explicit: true, scope: undefined, query: text };
}

export const scopeSuggestions = (scopes: readonly SearchScope[], query: string) => {
	const words = handle_words(query.trim().toLowerCase()).split(/\s+/);
	return scopes.filter((scope) =>
		words.every((word) =>
			has(`${handle_words(scope.command)} ${scope.label} ${scope.description}`, word)
		)
	);
};

export const scopedPages = (scope: Extract<SearchScope, { kind: 'app' }>, query: string) =>
	scope.pages.filter((page) => has(page.label, query));

export const pageSuggestions = (
	nav: readonly NavNode[],
	scopes: readonly SearchScope[],
	query: string,
	t: (key: string) => string
) =>
	query.trim() === ''
		? []
		: pageHits(nav, query, t).filter(
				(page) =>
					has(page.label, query) &&
					!scopes.some((scope) => scope.kind === 'app' && scope.label === page.label)
			);

/** Both pickers use the same name-first results; descriptions help discovery without outranking names. */
export function manifestMatches(
	nav: readonly NavNode[],
	scopes: readonly SearchScope[],
	query: string,
	t: (key: string) => string
) {
	const normalized = handle_words(query.trim().toLowerCase());
	const rank = (label: string, command = '') => {
		const names = [label, command].map((name) => handle_words(name.toLowerCase()));
		return names.some((name) => name === normalized)
			? 0
			: names.some((name) => name.startsWith(normalized))
				? 1
				: normalized.split(/\s+/).every((word) => names.some((name) => name.includes(word)))
					? 2
					: 3;
	};
	const matches = [
		...scopeSuggestions(scopes, query).map((scope) => ({
			kind: 'scope' as const,
			key: `scope:${scope.kind}:${scope.command}`,
			scope
		})),
		...pageSuggestions(nav, scopes, query, t)
	];
	const score = (hit: (typeof matches)[number]) =>
		hit.kind === 'scope' ? rank(hit.scope.label, hit.scope.command) : rank(hit.label);
	return matches.sort((a, b) => score(a) - score(b)).slice(0, 40);
}

/** Search only an explicitly selected model; an undeclared index never falls back to label filtering. */
export const searchRecords = Effect.fn('Finder.searchRecords')(function* (
	catalog: { readonly [model: string]: ModelExposure },
	read: FinderRead,
	model: string | null,
	query: string,
	t: (key: string) => string
) {
	const scope = recordScopes(catalog, t).find((scope) => scope.model === model);
	if (model === null || scope === undefined || !scope.searchable || query.trim() === '') return [];
	const exposure = catalog[model];
	if (exposure === undefined) return [];
	const semantic = /^\/semantic(?:\s|$)/.test(query.trim());
	if (semantic && exposure.semantic !== true) return [];
	const text =
		(exposure.search?.length ?? 0) === 0 && !semantic ? `/semantic ${query.trim()}` : query.trim();
	if (text === '/semantic') return [];
	const options = { search: text, limit: RECORDS_PER_MODEL, output: exposure.output ?? 'default' };
	const answer = yield* read(
		exposure.record_label !== undefined ? label_read(catalog, model, options) : { [model]: options }
	);
	return (answer[model]?.rows ?? []).flatMap((row): FinderHit[] =>
		typeof row['id'] === 'string'
			? [
					{
						kind: 'record',
						key: `${model}/${row['id']}`,
						label: labelOf(row, exposure.record_label),
						context: scope.label,
						model,
						id: row['id']
					}
				]
			: []
	);
});

/** An interrupted older search never replaces a newer query or scope. */
export const recordFinder = (
	catalog: { readonly [model: string]: ModelExposure },
	read: FinderRead,
	t: (key: string) => string
) =>
	Effect.gen(function* () {
		const handle = yield* FiberHandle.make<FinderHit[], FinderError>();
		return {
			search: (model: string | null, query: string) =>
				Effect.gen(function* () {
					const fiber = yield* FiberHandle.run(
						handle,
						searchRecords(catalog, read, model, query, t)
					);
					const result = yield* Fiber.await(fiber);
					if (result._tag === 'Success') return result.value;
					if (Cause.hasInterrupts(result.cause)) return null;
					return yield* Effect.failCause(result.cause);
				})
		};
	});

/** Both editor triggers use the same scopes, parser, search requests and result insertion. */
export const recordMentions = Effect.fn('Finder.recordMentions')(function* (
	catalog: { readonly [model: string]: ModelExposure },
	read: FinderRead,
	query: string,
	t: (key: string) => string,
	{
		nav = [],
		prefix = '@',
		entries = []
	}: { nav?: readonly NavNode[]; prefix?: '@' | '/'; entries?: readonly ManifestItem[] } = {}
): Effect.fn.Return<CommandItem[], FinderError> {
	const scopes = searchScopes(nav, catalog, t, entries);
	const explicit = prefix === '/' || query.startsWith('/');
	const parsed = scopeQuery(scopes, explicit ? `/${query.replace(/^\//, '')}` : query);
	const link = (label: string, href: string) =>
		`[@${label.replace(/[\\[\]]/g, '\\$&')}](${href.startsWith('/') ? based(href) : href}) `;
	if (parsed.scope === undefined)
		return manifestMatches(nav, scopes, parsed.query, t).map((hit): CommandItem => {
			if (hit.kind === 'page')
				return {
					id: hit.key,
					label: hit.label,
					description: `${t('Page')} · ${hit.context ?? ''}`,
					icon: 'lucide:panel-top',
					insert: link(hit.label, hit.href)
				};
			const scope = hit.scope;
			return {
				id: scope.kind === 'model' ? scope.model : `app:${scope.command}`,
				label: scope.label,
				description: `${t(scopeKind(scope))}${scope.description ? ` · ${scope.description}` : ''}`,
				icon: scopeIcon(scope),
				insert: link(scope.label, scopeHref(scope)),
				...(canDrill(scope)
					? {
							drill: {
								insert: `/${scope.command} `,
								label: t(scope.kind === 'app' ? 'Browse pages' : 'Search records')
							}
						}
					: {})
			};
		});
	const scope = parsed.scope;
	if (scope.kind !== 'model' && scope.kind !== 'app')
		return [
			{
				id: scope.command,
				label: scope.label,
				description: t(scopeKind(scope)),
				insert: link(scope.label, scope.href)
			}
		];
	const hits =
		scope.kind === 'app'
			? scopedPages(scope, parsed.query)
			: yield* searchRecords(catalog, read, scope.model, parsed.query, t);
	return [
		{
			id: 'scope',
			label: scope.label,
			description: `${t(scopeKind(scope))}${scope.description ? ` · ${scope.description}` : ''}`,
			icon: scope.kind === 'model' ? 'lucide:database' : 'lucide:layout-grid',
			insert: '/',
			keep: true,
			back: true
		},
		...hits.map((hit): CommandItem => ({
			id: hit.key,
			label: hit.label,
			depth: 1,
			insert: link(hit.label, hit.kind === 'record' ? `${hit.model}/${hit.id}` : hit.href)
		})),
		...(hits.length === 0 &&
		parsed.query.trim() !== '' &&
		(scope.kind === 'app' || scope.searchable)
			? [{ id: 'empty', label: t('Nothing found.'), disabled: true }]
			: [])
	];
});
