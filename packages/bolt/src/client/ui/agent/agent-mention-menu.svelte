<script lang="ts">
	import { useI18n } from '@norbital-ai/ui/i18n';
	import { Stack } from '@norbital-ai/ui/layout';
	import type { BoltUiKeys } from './i18n.js';
	import {
		commandPrefixChar,
		type MentionCommand,
		type MentionMenuItem
	} from './mention-sources.js';
	import type { FinderEntity, FinderRow } from '../finder/finder-entity.js';
	import FinderPalette from '../finder/finder-palette.svelte';

	const { t } = useI18n<BoltUiKeys>();

	/** Icon for a prefix command in the mention menu. */
	function commandIcon(command: MentionCommand): string { // stupidity:allow Q3 -- named helper
		switch (command) {
			case 'record':
				return 'lucide:search';
			case 'plan':
				return 'lucide:list-todo';
			case 'app':
				return 'lucide:layout-grid';
			default: {
				const _exhaustive: never = command;
				return _exhaustive;
			}
		}
	}

	/** i18n key for a prefix command's menu label. */
	function commandLabelKey( // stupidity:allow Q3 -- named helper
		command: MentionCommand
	): 'bolt.agent.prefixSearch' | 'bolt.agent.prefixPlan' | 'bolt.agent.prefixApps' {
		switch (command) {
			case 'record':
				return 'bolt.agent.prefixSearch';
			case 'plan':
				return 'bolt.agent.prefixPlan';
			case 'app':
				return 'bolt.agent.prefixApps';
			default: {
				const _exhaustive: never = command;
				return _exhaustive;
			}
		}
	}

	/** Maps a mention menu item onto a finder row. */
	function toRow(item: MentionMenuItem): FinderRow { // stupidity:allow Q3 -- named helper
		switch (item.kind) {
			case 'record':
				return {
					value: `record:${item.hit.collection}:${item.hit.recordId}`,
					kind: 'record',
					label: item.hit.label,
					description: item.hit.collection,
					entity: {
						kind: 'record',
						collection: item.hit.collection,
						recordId: item.hit.recordId,
						label: item.hit.label
					}
				};
			case 'scope':
				return {
					value: `scope:${item.collection}`,
					kind: 'scope',
					label: t('bolt.agent.searchCollection', { collection: item.collection }),
					description: commandPrefixChar('record'),
					entity: { kind: 'scope', collection: item.collection }
				};
			case 'collection':
				return {
					value: `collection:${item.collection}`,
					kind: 'command',
					label: item.collection,
					description: t('bolt.agent.collection'),
					icon: 'lucide:table',
					entity: { kind: 'collection', collection: item.collection }
				};
			case 'app':
				return {
					value: `app:${item.key}`,
					kind: 'app',
					label: item.label,
					description: t('bolt.agent.app'),
					icon: 'lucide:layout-grid',
					entity: {
						kind: 'app',
						key: item.key,
						label: item.label,
						href: item.href ?? `/app/${item.key}`,
						description: item.description ?? null
					}
				};
			case 'command':
				return {
					value: `command:${item.command}`,
					kind: 'command',
					label: t(commandLabelKey(item.command)),
					description: commandPrefixChar(item.command),
					icon: commandIcon(item.command),
					entity: { kind: 'prefix', scope: item.command }
				};
			default: {
				const _exhaustive: never = item;
				return _exhaustive;
			}
		}
	}

	let {
		items,
		highlightIndex,
		loading,
		query,
		scope,
		onselect,
		onhighlight,
		onclearscope
	}: {
		items: readonly MentionMenuItem[];
		highlightIndex: number;
		loading: boolean;
		query: string;
		scope: string | null;
		onselect: (index: number) => void;
		onhighlight: (index: number) => void;
		onclearscope: () => void;
	} = $props();

	const rows = $derived.by((): FinderRow[] => {
		const mapped = items.map(toRow);
		if (loading && mapped.length === 0) {
			return [{ value: 'loading:records', kind: 'loading', disabled: true }];
		}
		if (mapped.length === 0) {
			return [
				{
					value: 'empty:none',
					kind: 'empty',
					disabled: true,
					label:
						scope && !query.trim()
							? t('bolt.agent.typeToSearchScope', { scope })
							: t('bolt.agent.noRecordsMatch', { query: query.trim() })
				}
			];
		}
		return mapped;
	});

	/** Forwards a palette pick to the parent highlight/select callbacks. */
	function handlePick(entity: FinderEntity): void { // stupidity:allow Q3 -- template handler
		const index = rows.findIndex((row) => row.entity === entity || sameEntity(row.entity, entity));
		if (index >= 0) {
			onhighlight(index);
			onselect(index);
		}
	}

	/** True when two finder entities name the same workspace object. */
	function sameEntity(left: FinderEntity | undefined, right: FinderEntity): boolean { // stupidity:allow Q3 -- named helper
		if (!left || left.kind !== right.kind) return false;
		switch (left.kind) {
			case 'record':
				return (
					right.kind === 'record' &&
					left.collection === right.collection &&
					left.recordId === right.recordId
				);
			case 'scope':
				return right.kind === 'scope' && left.collection === right.collection;
			case 'collection':
				return right.kind === 'collection' && left.collection === right.collection;
			case 'app':
				return right.kind === 'app' && left.key === right.key;
			case 'prefix':
				return right.kind === 'prefix' && left.scope === right.scope;
			case 'plan':
			case 'ask-agent':
			case 'navigate':
				return false;
			default: {
				const _exhaustive: never = left;
				return _exhaustive;
			}
		}
	}

	const activeValue = $derived(rows[highlightIndex]?.value);
</script>

<Stack
	gap="sm"
	id="agent-mention-menu"
	role="presentation"
	data-testid="agent-mention-menu"
	class="absolute inset-x-0 bottom-full z-30"
	onmousedown={(event) => event.preventDefault()}
>
	<FinderPalette
		{query}
		items={rows}
		showInput={false}
		disableNavigation
		{activeValue}
		{scope}
		onPick={handlePick}
		onClearScope={onclearscope}
	/>
</Stack>
