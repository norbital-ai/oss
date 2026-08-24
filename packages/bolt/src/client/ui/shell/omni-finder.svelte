<script lang="ts">
	import * as Dialog from '@norbital-ai/ui/dialog';
	import { useI18n } from '@norbital-ai/ui/i18n';
	import { humanize } from '@norbital-ai/std/string';
	import type { WorkspaceNavigationModel } from '@norbital-ai/ui/workspace-shell';
	import type { AgentComposerSeed } from '#lib/client/ui/agent/composer-chrome.js';
	import {
		COMMAND_SCOPES,
		commandPrefixChar,
		createMentionSources,
		filterCollections,
		parseCommandQuery,
		recordSearchIdentity,
		shouldSearchRecords,
		type CommandScope,
		type MentionRecordHit
	} from '#lib/client/ui/agent/mention-sources.js';
	import { createDebouncedRecordSearch } from '#lib/client/ui/agent/debounced-record-search.js';
	import type { FinderEntity, FinderRow } from '#lib/client/ui/finder/finder-entity.js';
	import FinderPalette from '../finder/finder-palette.svelte';

	const { t } = useI18n();

	/**
	 * Cmd+/ host for the shared finder. Record search is a second step: pick a collection,
	 * then type. Picks are entities — this host navigates or opens the default detail sheet.
	 */
	let {
		open = $bindable(false),
		collections = [],
		navigationModel,
		agentAvailable = true,
		onNavigate,
		onAskAgent,
		onOpenRecord
	}: {
		open?: boolean;
		collections?: readonly string[];
		navigationModel: WorkspaceNavigationModel;
		agentAvailable?: boolean;
		onNavigate?: ((href: string) => void) | undefined;
		onAskAgent: (seed?: AgentComposerSeed) => void;
		onOpenRecord?: ((target: { collectionName: string; recordId: string }) => void) | undefined;
	} = $props();

	const mentionSources = createMentionSources({
		hitsPerSource: 8,
		getCollections: () => collections,
		getApps: () =>
			flattenedApps().map((app) => ({
				key: app.key,
				label: app.label,
				href: app.href,
				description: app.description
			}))
	});

	const PREFIX_LABEL_KEYS: Record<
		CommandScope,
		| 'bolt.shell.omniPrefixSearch'
		| 'bolt.shell.omniPrefixPlan'
		| 'bolt.shell.omniPrefixApps'
		| 'bolt.shell.omniPrefixCommands'
	> = {
		record: 'bolt.shell.omniPrefixSearch',
		plan: 'bolt.shell.omniPrefixPlan',
		app: 'bolt.shell.omniPrefixApps',
		command: 'bolt.shell.omniPrefixCommands'
	};

	/**
	 * What each prefix actually does. "Search records" and a bare `#` leave the reader to guess that
	 * the collection comes first and the search second — the row has the width to just say so.
	 */
	const PREFIX_HINT_KEYS: Record<
		CommandScope,
		| 'bolt.shell.omniPrefixSearchHint'
		| 'bolt.shell.omniPrefixPlanHint'
		| 'bolt.shell.omniPrefixAppsHint'
		| 'bolt.shell.omniPrefixCommandsHint'
	> = {
		record: 'bolt.shell.omniPrefixSearchHint',
		plan: 'bolt.shell.omniPrefixPlanHint',
		app: 'bolt.shell.omniPrefixAppsHint',
		command: 'bolt.shell.omniPrefixCommandsHint'
	};

	let query = $state('');
	let inputElement = $state<HTMLInputElement | null>(null);
	let recordHits = $state<readonly MentionRecordHit[]>([]);
	let recordsLoading = $state(false);

	const recordSearch = createDebouncedRecordSearch({
		search: (text, collection) => mentionSources.search(text, collection),
		onLoading: (loading) => {
			recordsLoading = loading;
		},
		onResults: (hits) => {
			recordHits = hits;
		}
	});

	const parsed = $derived(parseCommandQuery(query, mentionSources.collections()));

	/** Replace the finder query, kick record search, and optionally restore input focus. */
	function commitQuery(next: string, focus = false): void {
		query = next;
		const nextParsed = parseCommandQuery(next, mentionSources.collections());
		recordSearch.schedule(
			recordSearchIdentity(nextParsed),
			nextParsed,
			shouldSearchRecords(nextParsed)
		);
		if (focus) queueMicrotask(() => inputElement?.focus());
	}

	/** Clear query and record-search state when the finder dialog closes. */
	function onOpenChange(next: boolean): void {
		if (next) return;
		recordSearch.invalidate();
		query = '';
		recordHits = [];
		recordsLoading = false;
	}

	/** Walk the navigation tree into a depth-tagged list of launchable apps. */
	function flattenedApps(): {
		key: string;
		label: string;
		href: string;
		icon: string | null;
		thumbnail: string | null;
		description: string | null;
		depth: number;
	}[] {
		const out: ReturnType<typeof flattenedApps> = [];
		/** Recursively collect an app and its descendants at increasing depth. */
		function walk(items: WorkspaceNavigationModel['applications'], depth: number): void {
			for (const item of items) {
				out.push({
					key: item.key,
					label: item.label,
					href: item.href,
					icon: item.icon ?? null,
					// `'x' in item` is a presence test, not a type: it leaves the value as `{}`. Reading it
					// and checking the type is what actually narrows to a string.
					thumbnail: typeof item.thumbnail === 'string' ? item.thumbnail : null,
					description: typeof item.description === 'string' ? item.description : null,
					depth
				});
				if (item.children?.length) walk(item.children, depth + 1);
			}
		}
		walk(navigationModel.applications, 0);
		return out;
	}

	/** Compose a stable list key from a finder row kind and identity. */
	function rowValue(kind: FinderRow['kind'], key: string): string {
		return `${kind}:${key}`;
	}

	/** One entry of the flattened navigation tree. */
	type FlattenedApp = ReturnType<typeof flattenedApps>[number];

	/**
	 * How well one app answers the needle — lower is better — or `null` when it does not answer it.
	 *
	 * The bands are deliberate and ordered: a label prefix beats a label substring, that beats a
	 * description hit, and a fragment of the route key is the last resort.
	 */
	function appScore(app: FlattenedApp, needle: string): number | null {
		if (!needle) return 0;
		const term = needle.toLowerCase();
		const target = app.label.toLowerCase();
		if (target.startsWith(term)) return 0;
		if (target.includes(term)) return 1;
		if (app.description?.toLowerCase().includes(term) === true) return 2;
		const keywords = [app.key, ...app.key.split('/')];
		if (keywords.some((keyword) => keyword.toLowerCase().includes(term))) return 3;
		return null;
	}

	/** One app as the finder row that launches it. */
	function appFinderRow(app: FlattenedApp): FinderRow {
		return {
			value: rowValue('app', app.key),
			kind: 'app',
			label: app.label,
			description: app.description ?? undefined,
			icon: app.icon,
			thumbnail: app.thumbnail,
			depth: app.depth,
			entity: {
				kind: 'app',
				key: app.key,
				label: app.label,
				href: app.href,
				description: app.description
			}
		};
	}

	const APP_ROW_CAP = 6;

	const appRows = $derived.by((): FinderRow[] => {
		const scope = parsed.scope;
		if (scope !== null && scope !== 'app') return [];
		const needle = parsed.text.trim();
		// Scored and kept in one pass, then ordered and cut. The chain this replaces walked the whole
		// app tree five times to answer with at most six rows.
		const scored: { row: FinderRow; score: number }[] = [];
		for (const app of flattenedApps()) {
			const score = appScore(app, needle);
			if (score === null) continue;
			scored.push({ score, row: appFinderRow(app) });
		}
		scored.sort((left, right) => left.score - right.score);
		return scored.slice(0, APP_ROW_CAP).map((entry) => entry.row);
	});

	const RECORD_ROW_CAP = 12;

	const recordRows = $derived(
		recordHits.slice(0, RECORD_ROW_CAP).map((hit): FinderRow => ({
			value: rowValue('record', `${hit.collection}:${hit.recordId}`),
			kind: 'record',
			label: hit.label,
			description: humanize(hit.collection),
			entity: {
				kind: 'record',
				collection: hit.collection,
				recordId: hit.recordId,
				label: hit.label
			}
		}))
	);

	const collectionScopeRows = $derived.by((): FinderRow[] => {
		if (parsed.scope !== 'record' || parsed.collection) return [];
		return filterCollections(parsed.text, mentionSources.collections()).map(
			(collection): FinderRow => ({
				value: rowValue('scope', collection),
				kind: 'scope',
				label: t('bolt.agent.searchCollection', { collection }),
				description: t('bolt.agent.typeToSearchScope', { scope: humanize(collection) }),
				hint: commandPrefixChar('record'),
				entity: { kind: 'scope', collection }
			})
		);
	});

	const commandRows = $derived.by((): FinderRow[] => {
		const scope = parsed.scope;
		if (scope === 'plan') {
			return [
				{
					value: rowValue('command', 'plan'),
					kind: 'command',
					label: parsed.text
						? t('bolt.shell.omniPlanWithQuery', { query: parsed.text })
						: t('bolt.shell.omniPrefixPlan'),
					icon: 'product:agent',
					entity: { kind: 'plan', query: parsed.text }
				}
			];
		}
		if (scope !== null && scope !== 'command') return [];

		const needle = parsed.text.trim().toLowerCase();
		const rows: FinderRow[] = [];

		if (scope === null && !query.trim()) {
			for (const prefixScope of COMMAND_SCOPES) {
				rows.push({
					value: rowValue('command', `prefix-${prefixScope}`),
					kind: 'command',
					label: t(PREFIX_LABEL_KEYS[prefixScope]),
					description: t(PREFIX_HINT_KEYS[prefixScope]),
					hint: commandPrefixChar(prefixScope),
					entity: { kind: 'prefix', scope: prefixScope }
				});
			}
		}

		if (agentAvailable && scope === null) {
			if (parsed.text.trim()) {
				rows.push({
					value: rowValue('command', 'ask-agent'),
					kind: 'command',
					label: t('bolt.shell.omniAskWithQuery', { query: parsed.text }),
					description: t('bolt.shell.omniNewConversationHint'),
					icon: 'product:agent',
					entity: { kind: 'ask-agent', query: parsed.text }
				});
			} else {
				rows.push({
					value: rowValue('command', 'ask-agent'),
					kind: 'command',
					label: t('bolt.shell.omniNewConversation'),
					description: t('bolt.shell.omniNewConversationHint'),
					icon: 'product:agent',
					entity: { kind: 'ask-agent', query: '' }
				});
			}
		}

		rows.push({
			value: rowValue('command', 'overview'),
			kind: 'command',
			label: t('bolt.shell.omniOpenWorkspace'),
			description: t('bolt.shell.omniOpenWorkspaceHint'),
			icon: 'lucide:layout-dashboard',
			entity: { kind: 'navigate', href: '/' }
		});
		const systemStack = navigationModel.system.slice().reverse();
		while (systemStack.length > 0) {
			const item = systemStack.pop();
			if (!item) continue;
			rows.push({
				value: rowValue('command', item.key),
				kind: 'command',
				label: item.label,
				// The navigation model already carries the authored blurb; the finder was dropping it and
				// leaving the settings rows as bare nouns.
				description: item.description ?? undefined,
				icon: item.icon ?? 'lucide:settings',
				entity: { kind: 'navigate', href: item.href }
			});
			if (item.children !== undefined) {
				// Pushed in reverse so `pop()` yields them back in authored order.
				for (const child of [...item.children].reverse()) systemStack.push(child);
			}
		}
		return rows.filter(
			(row) =>
				row.entity?.kind === 'prefix' || !needle || (row.label ?? '').toLowerCase().includes(needle)
		);
	});

	/** Disabled section header row for the finder palette. */
	function group(kind: 'apps' | 'records' | 'commands'): FinderRow {
		return {
			value: rowValue('group', kind),
			kind: 'group',
			disabled: true,
			label:
				kind === 'apps'
					? t('bolt.shell.omniApps')
					: kind === 'records'
						? t('bolt.shell.omniRecords')
						: t('bolt.shell.omniCommands')
		};
	}

	/** A section's header and its rows, or nothing at all when the section has none. */
	function section(kind: 'apps' | 'commands', rows: readonly FinderRow[]): FinderRow[] {
		return rows.length === 0 ? [] : [group(kind), ...rows];
	}

	/**
	 * The rows the record scope contributes, header included.
	 *
	 * Three mutually exclusive tails behind one header: the search that has not answered yet, the
	 * chosen collection that has nothing to search for yet, and the hits themselves.
	 */
	function recordSection(searchText: string): FinderRow[] {
		const scopes = collectionScopeRows;
		const shown =
			Boolean(parsed.collection) || scopes.length > 0 || recordRows.length > 0 || recordsLoading;
		if (!shown) return [];
		const header = [group('records'), ...scopes];
		if (recordsLoading && recordRows.length === 0 && searchText)
			return [
				...header,
				{ value: rowValue('loading', 'records'), kind: 'loading', disabled: true }
			];
		if (parsed.collection && !searchText)
			return [
				...header,
				{
					value: rowValue('empty', 'type'),
					kind: 'empty',
					disabled: true,
					label: t('bolt.agent.typeToSearchScope', { scope: parsed.collection })
				}
			];
		return [...header, ...recordRows];
	}

	const items = $derived.by((): FinderRow[] => {
		const out: FinderRow[] = [];
		const scope = parsed.scope;
		const searchText = parsed.text.trim();

		switch (scope) {
			case 'record':
				out.push(...recordSection(searchText));
				break;
			case 'app':
				out.push(...section('apps', appRows));
				break;
			case 'command':
			case 'plan':
				out.push(...section('commands', commandRows));
				break;
			case null:
				out.push(...section('apps', appRows), ...section('commands', commandRows));
				break;
			default: {
				const _exhaustive: never = scope;
				return _exhaustive;
			}
		}

		if (searchText && !recordsLoading && out.filter((row) => !row.disabled).length === 0) {
			out.push({
				value: rowValue('empty', 'none'),
				kind: 'empty',
				disabled: true,
				label: t('bolt.shell.omniNoResults', { query: searchText })
			});
		}
		return out;
	});

	/** Dispatch a finder pick to navigation, record open, scope, or the agent. */
	function handlePick(entity: FinderEntity): void {
		switch (entity.kind) {
			case 'app':
			case 'navigate':
				onNavigate?.(entity.href);
				open = false;
				return;
			case 'record':
				onOpenRecord?.({ collectionName: entity.collection, recordId: entity.recordId });
				open = false;
				return;
			case 'scope':
				commitQuery(`#${entity.collection} `, true);
				return;
			case 'prefix':
				commitQuery(commandPrefixChar(entity.scope), true);
				return;
			case 'plan':
				onAskAgent(entity.query ? { message: entity.query, planMode: true } : { planMode: true });
				open = false;
				return;
			case 'ask-agent':
				onAskAgent(entity.query ? { message: entity.query } : undefined);
				open = false;
				return;
			case 'collection':
				commitQuery(`#${entity.collection} `, true);
				return;
			default: {
				const _exhaustive: never = entity;
				return _exhaustive;
			}
		}
	}
</script>

<Dialog.Root bind:open {onOpenChange}>
	<Dialog.Content
		class="w-[min(46rem,calc(100vw-2rem))] gap-0 overflow-hidden p-0 shadow-2xl [&>button]:hidden"
		onOpenAutoFocus={(event) => {
			event.preventDefault();
			queueMicrotask(() => inputElement?.focus());
		}}
	>
		<FinderPalette
			bind:query
			bind:inputElement
			{items}
			scope={parsed.collection}
			parsedScope={parsed.scope}
			placeholder={t('bolt.shell.omniPlaceholder')}
			ariaLabel={t('bolt.shell.omniTitle')}
			onPick={handlePick}
			onQueryInput={(next) => commitQuery(next)}
			onClearScope={() => commitQuery('#', true)}
		/>
	</Dialog.Content>
</Dialog.Root>
