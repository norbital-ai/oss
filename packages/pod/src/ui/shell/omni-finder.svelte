<script lang="ts">
	import * as Dialog from '@norbital-ai/ui/dialog';
	import { useI18n } from '@norbital-ai/ui/i18n';
	import { humanize } from '@norbital-ai/std/string';
	import type { WorkspaceNavigationModel } from '@norbital-ai/ui/workspace-shell';
	import type { ManifestContext } from '@norbital-ai/platform-utils/manifest/context';
	import type { PodUiKeys } from '$lib/i18n/index.js';
	import type { AgentComposerSeed } from '../agent/composer-chrome.js';
	import {
		COMMAND_PREFIX,
		commandPrefixChar,
		createMentionSources,
		filterCollections,
		parseCommandQuery,
		recordSearchIdentity,
		shouldSearchRecords,
		type CommandScope,
		type MentionRecordHit
	} from '../agent/mention-sources.js';
	import { createDebouncedRecordSearch } from '../agent/debounced-record-search.js';
	import type { FinderEntity, FinderRow } from '../finder/finder-entity.js';
	import FinderPalette from '../finder/finder-palette.svelte';

	const { t } = useI18n<PodUiKeys>();

	/**
	 * Cmd+/ host for the shared finder. Record search is a second step: pick a collection,
	 * then type. Picks are entities — this host navigates or opens the default detail sheet.
	 */
	let {
		open = $bindable(false),
		manifestContext,
		navigationModel,
		agentAvailable,
		onNavigate,
		onAskAgent,
		onOpenRecord
	}: {
		open?: boolean;
		manifestContext: ManifestContext;
		navigationModel: WorkspaceNavigationModel;
		agentAvailable: boolean;
		onNavigate: (href: string) => void;
		onAskAgent: (seed?: AgentComposerSeed) => void;
		onOpenRecord: (target: { collectionName: string; recordId: string }) => void;
	} = $props();

	const mentionSources = createMentionSources(() => manifestContext, { hitsPerSource: 8 });

	const PREFIX_LABEL_KEYS: Record<
		CommandScope,
		| 'pod.shell.omniPrefixSearch'
		| 'pod.shell.omniPrefixPlan'
		| 'pod.shell.omniPrefixApps'
		| 'pod.shell.omniPrefixCommands'
	> = {
		record: 'pod.shell.omniPrefixSearch',
		plan: 'pod.shell.omniPrefixPlan',
		app: 'pod.shell.omniPrefixApps',
		command: 'pod.shell.omniPrefixCommands'
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
		recordSearch.schedule(recordSearchIdentity(parsed), parsed, shouldSearchRecords(parsed));
		if (focus) queueMicrotask(() => inputElement?.focus());
	}

	/** Clear query and record-search state when the finder dialog closes. */
	function onOpenChange(next: boolean): void { // stupidity:allow Q3 -- template handler
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
				const app = manifestContext.findApp(item.key);
				out.push({
					key: item.key,
					label: item.label,
					href: item.href,
					icon: item.icon ?? null,
					thumbnail: app?.thumbnail ?? null,
					description: app?.description ?? null,
					depth
				});
				if (item.children?.length) walk(item.children, depth + 1);
			}
		}
		walk(navigationModel.applications, 0);
		return out;
	}

	/** Compose a stable list key from a finder row kind and identity. */
	function rowValue(kind: FinderRow['kind'], key: string): string { // stupidity:allow Q4 -- shared row key
		return `${kind}:${key}`;
	}

	const appRows = $derived.by((): FinderRow[] => {
		const scope = parsed.scope;
		if (scope !== null && scope !== 'app') return [];
		const needle = parsed.text.trim();
		return flattenedApps()
			.map((app): { row: FinderRow; score: number | null } => {
				let score: number | null = 0;
				if (needle) {
					const term = needle.toLowerCase();
					const target = app.label.toLowerCase();
					const keywords = [app.key, ...app.key.split('/')];
					if (target.startsWith(term)) score = 0;
					else if (target.includes(term)) score = 1;
					else if (app.description?.toLowerCase().includes(term)) score = 2;
					else if (
						keywords.some((keyword) => keyword.toLowerCase().includes(needle.toLowerCase()))
					)
						score = 3;
					else score = null;
				}
				return {
					score,
					row: {
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
					}
				};
			})
			.filter((entry) => entry.score !== null)
			.sort((left, right) => left.score! - right.score!)
			.slice(0, 6)
			.map((entry) => entry.row);
	});

	const RECORD_ROW_CAP = 12;

	const recordRows = $derived(
		recordHits.slice(0, RECORD_ROW_CAP).map(
			(hit): FinderRow => ({
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
			})
		)
	);

	const collectionScopeRows = $derived.by((): FinderRow[] => {
		if (parsed.scope !== 'record' || parsed.collection) return [];
		return filterCollections(parsed.text, mentionSources.collections()).map(
			(collection): FinderRow => ({
				value: rowValue('scope', collection),
				kind: 'scope',
				label: t('pod.agent.searchCollection', { collection }),
				description: commandPrefixChar('record'),
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
						? t('pod.shell.omniPlanWithQuery', { query: parsed.text })
						: t('pod.shell.omniPrefixPlan'),
					icon: 'product:agent',
					entity: { kind: 'plan', query: parsed.text }
				}
			];
		}
		if (scope !== null && scope !== 'command') return [];

		const needle = parsed.text.trim().toLowerCase();
		const rows: FinderRow[] = [];

		if (scope === null && !query.trim()) {
			for (const prefixScope of Object.keys(COMMAND_PREFIX) as CommandScope[]) {
				rows.push({
					value: rowValue('command', `prefix-${prefixScope}`),
					kind: 'command',
					label: t(PREFIX_LABEL_KEYS[prefixScope]),
					description: commandPrefixChar(prefixScope),
					entity: { kind: 'prefix', scope: prefixScope }
				});
			}
		}

		if (agentAvailable && scope === null) {
			if (parsed.text.trim()) {
				rows.push({
					value: rowValue('command', 'ask-agent'),
					kind: 'command',
					label: t('pod.shell.omniAskWithQuery', { query: parsed.text }),
					description: t('pod.shell.omniNewConversationHint'),
					icon: 'product:agent',
					entity: { kind: 'ask-agent', query: parsed.text }
				});
			} else {
				rows.push({
					value: rowValue('command', 'ask-agent'),
					kind: 'command',
					label: t('pod.shell.omniNewConversation'),
					description: t('pod.shell.omniNewConversationHint'),
					icon: 'product:agent',
					entity: { kind: 'ask-agent', query: '' }
				});
			}
		}

		rows.push({
			value: rowValue('command', 'overview'),
			kind: 'command',
			label: t('pod.shell.omniOpenWorkspace'),
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
				icon: 'lucide:settings',
				entity: { kind: 'navigate', href: item.href }
			});
			if (item.children?.length) {
				for (let index = item.children.length - 1; index >= 0; index -= 1) {
					const child = item.children[index];
					if (child) systemStack.push(child);
				}
			}
		}
		return rows.filter(
			(row) =>
				row.entity?.kind === 'prefix' ||
				!needle ||
				(row.label ?? '').toLowerCase().includes(needle)
		);
	});

	const items = $derived.by((): FinderRow[] => {
		const out: FinderRow[] = [];
		const scope = parsed.scope;
		const searchText = parsed.text.trim();
		/** Disabled section header row for the finder palette. */
		function group(kind: 'apps' | 'records' | 'commands'): FinderRow {
			return {
				value: rowValue('group', kind),
				kind: 'group',
				disabled: true,
				label:
					kind === 'apps'
						? t('pod.shell.omniApps')
						: kind === 'records'
							? t('pod.shell.omniRecords')
							: t('pod.shell.omniCommands')
			};
		}

		switch (scope) {
			case 'record': {
				const scopes = collectionScopeRows;
				const showRecordsGroup =
					Boolean(parsed.collection) ||
					scopes.length > 0 ||
					recordRows.length > 0 ||
					recordsLoading;
				if (showRecordsGroup) {
					out.push(group('records'));
					out.push(...scopes);
					if (recordsLoading && recordRows.length === 0 && searchText) {
						out.push({ value: rowValue('loading', 'records'), kind: 'loading', disabled: true });
					} else if (parsed.collection && !searchText) {
						out.push({
							value: rowValue('empty', 'type'),
							kind: 'empty',
							disabled: true,
							label: t('pod.agent.typeToSearchScope', { scope: parsed.collection })
						});
					} else {
						out.push(...recordRows);
					}
				}
				break;
			}
			case 'app': {
				if (appRows.length > 0) {
					out.push(group('apps'));
					out.push(...appRows);
				}
				break;
			}
			case 'command':
			case 'plan': {
				if (commandRows.length > 0) {
					out.push(group('commands'));
					out.push(...commandRows);
				}
				break;
			}
			case null: {
				if (appRows.length > 0) {
					out.push(group('apps'));
					out.push(...appRows);
				}
				if (commandRows.length > 0) {
					out.push(group('commands'));
					out.push(...commandRows);
				}
				break;
			}
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
				label: t('pod.shell.omniNoResults', { query: searchText })
			});
		}
		return out;
	});

	/** Dispatch a finder pick to navigation, record open, scope, or the agent. */
	function handlePick(entity: FinderEntity): void { // stupidity:allow Q3 -- template handler
		switch (entity.kind) {
			case 'app':
			case 'navigate':
				onNavigate(entity.href);
				open = false;
				return;
			case 'record':
				onOpenRecord({ collectionName: entity.collection, recordId: entity.recordId });
				open = false;
				return;
			case 'scope':
				commitQuery(`#${entity.collection} `, true);
				return;
			case 'prefix':
				commitQuery(commandPrefixChar(entity.scope), true);
				return;
			case 'plan':
				onAskAgent({ message: entity.query || undefined, planMode: true });
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
		class="w-[min(36rem,calc(100vw-2rem))] gap-0 overflow-hidden p-0 shadow-2xl [&>button]:hidden"
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
			placeholder={t('pod.shell.omniPlaceholder')}
			ariaLabel={t('pod.shell.omniTitle')}
			onPick={handlePick}
			onQueryInput={(next) => commitQuery(next)}
			onClearScope={() => commitQuery('#', true)}
		/>
	</Dialog.Content>
</Dialog.Root>
