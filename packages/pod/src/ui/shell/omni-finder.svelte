<script lang="ts">
	import Icon from '@iconify/svelte';
	import * as Command from '@norbital-ai/ui/command';
	import * as Dialog from '@norbital-ai/ui/dialog';
	import { getCollectionTableNavigationContext } from '@norbital-ai/ui/collection-table';
	import { IconWrapper } from '@norbital-ai/ui/icon-wrapper';
	import { useI18n } from '@norbital-ai/ui/i18n';
	import { Inline } from '@norbital-ai/ui/layout';
	import { humanize } from '@norbital-ai/std/string';
	import type { WorkspaceNavigationModel } from '@norbital-ai/ui/workspace-shell';
	import type { ManifestContext } from '@norbital-ai/platform-utils/manifest/context';
	import type { PodUiKeys } from '$lib/i18n/index.js';
	import { createMentionSources, type MentionRecordHit } from '../agent/mention-sources.js';

	const { t } = useI18n<PodUiKeys>();

	/**
	 * The omni finder (Cmd+/): one palette over every destination a workspace has.
	 *
	 * It shares the composer's "@" record engine — the same factory, the same label resolution,
	 * the same replica-first fan-out — so a record found here is the same record a mention would
	 * pin, and a search that matches in the palette matches in the mention menu. Apps and commands
	 * are indexed in memory; only records pay the search fan-out, debounced exactly like the
	 * mention menu so one burst of typing stays a handful of queries.
	 *
	 * Record hits render as their sources resolve rather than waiting for the slowest collection
	 * of the fan-out, so the palette fills instead of spinning.
	 */
	let {
		open = $bindable(false),
		manifestContext,
		navigationModel,
		agentAvailable,
		onNavigate,
		onAskAgent
	}: {
		open?: boolean;
		manifestContext: ManifestContext;
		navigationModel: WorkspaceNavigationModel;
		/** The workspace agent is present; the "New conversation" command is shown only then. */
		agentAvailable: boolean;
		onNavigate: (href: string) => void;
		/** Ask the agent: opens the sheet (or focuses the composer) without closing the palette. */
		onAskAgent: () => void;
	} = $props();

	const mentionSources = createMentionSources(() => manifestContext, { hitsPerSource: 8 });

	let query = $state('');
	let inputElement = $state<HTMLInputElement | null>(null);
	let recordHits = $state<readonly MentionRecordHit[]>([]);
	let recordsLoading = $state(false);
	/** The palette clears its state on close, so one instance holds one query's lifecycle. */
	let searchTimer: ReturnType<typeof setTimeout> | undefined;
	let searchVersion = 0;

	// ── Record search: the mention menu's debounce, at the palette's limits. The input handler
	// is the only writer — a callback pipeline, not an effect — and the version guard discards
	// responses that raced a newer query. Hits stream in per source as they resolve (the engine's
	// `onHits`), so the records group appears as soon as the fastest collection answers instead
	// of after the slowest one does; the final merged list replaces the streamed one.
	function onQueryInput(event: Event): void {
		query = (event.currentTarget as HTMLInputElement).value;
		clearTimeout(searchTimer);
		const active = query.trim();
		if (!active) {
			searchVersion++;
			recordHits = [];
			recordsLoading = false;
			return;
		}
		const version = ++searchVersion;
		recordsLoading = true;
		searchTimer = setTimeout(() => {
			void mentionSources
				.search(active, null, {
					onHits: (hits) => {
						if (version !== searchVersion) return;
						recordHits = [...recordHits, ...hits];
					}
				})
				.then((hits) => {
					if (version !== searchVersion) return;
					recordHits = hits;
					recordsLoading = false;
				})
				.catch(() => {
					if (version !== searchVersion) return;
					recordHits = [];
					recordsLoading = false;
				});
		}, 150);
	}

	function onOpenChange(next: boolean): void {
		if (next) return;
		// Closing aborts in-flight searches too: the version guard needs the next open to be a
		// fresh lifecycle, not a resume of the query that closed.
		searchVersion++;
		clearTimeout(searchTimer);
		query = '';
		recordHits = [];
		recordsLoading = false;
	}

	// ── Indexed sources ────────────────────────────────────────────────────────────────────────

	/** Every app in the sidebar tree, flattened with its depth for indentation. */
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
		const walk = (items: WorkspaceNavigationModel['applications'], depth: number): void => {
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
		};
		walk(navigationModel.applications, 0);
		return out;
	}

	function flattenedSystem(): { key: string; label: string; href: string }[] {
		const out: { key: string; label: string; href: string }[] = [];
		const walk = (items: WorkspaceNavigationModel['system'], depth: number): void => {
			for (const item of items) {
				out.push({ key: item.key, label: item.label, href: item.href });
				if (item.children?.length) walk(item.children, depth + 1);
			}
		};
		walk(navigationModel.system, 0);
		return out;
	}

	/** App label matches outrank description and path-segment matches, like any typeahead. */
	function matchScore(
		needle: string,
		label: string,
		description: string | null,
		keywords: string[]
	): number | null {
		const term = needle.toLowerCase();
		const target = label.toLowerCase();
		if (target.startsWith(term)) return 0;
		if (target.includes(term)) return 1;
		if (description?.toLowerCase().includes(term)) return 2;
		if (keywords.some((keyword) => keyword.toLowerCase().includes(term))) return 3;
		return null;
	}

	// ── Palette rows ───────────────────────────────────────────────────────────────────────────

	type OmniRow = {
		value: string;
		kind: 'group' | 'app' | 'record' | 'command' | 'loading' | 'empty';
		disabled?: boolean;
		label?: string;
		description?: string;
		icon?: string | null;
		thumbnail?: string | null;
		depth?: number;
		run?: () => void;
	};

	const rowValue = (kind: OmniRow['kind'], key: string): string => `${kind}:${key}`;

	const appRows = $derived.by((): OmniRow[] => {
		const needle = query.trim();
		return flattenedApps()
			.map((app): { row: OmniRow; score: number | null } => {
				const score = needle
					? matchScore(needle, app.label, app.description, [app.key, ...app.key.split('/')])
					: 0;
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
						run: () => {
							onNavigate(app.href);
							open = false;
						}
					}
				};
			})
			.filter((entry) => entry.score !== null)
			.sort((left, right) => left.score! - right.score!)
			.slice(0, 6)
			.map((entry) => entry.row);
	});

	/**
	 * How many record rows the palette shows at once. The fan-out returns up to `hitsPerSource`
	 * per collection, which would overflow a palette; the first arrivals — in source order —
	 * keep the list compact, and the pick is one record, not a browse.
	 */
	const RECORD_ROW_CAP = 12;

	const recordRows = $derived(
		recordHits.slice(0, RECORD_ROW_CAP).map((hit): OmniRow => ({
			value: rowValue('record', `${hit.collection}:${hit.recordId}`),
			kind: 'record',
			label: hit.label,
			// The tenant label the sidebar would use, not the raw snake_case collection name.
			description: humanize(hit.collection),
			run: () => {
				const navigation = getCollectionTableNavigationContext();
				if (!navigation) return;
				// The pod's own detail fallback keys records by collection name; a mounted
				// table for the same collection registers its richer surface under its own
				// view key, so the collection name is the one key that always resolves.
				navigation.open({
					collectionName: hit.collection,
					recordId: hit.recordId,
					routeKey: hit.collection
				});
				open = false;
			}
		}))
	);

	const commandRows = $derived.by((): OmniRow[] => {
		const needle = query.trim().toLowerCase();
		const matches = (label: string, keywords: string[]): boolean =>
			!needle ||
			label.toLowerCase().includes(needle) ||
			keywords.some((keyword) => keyword.toLowerCase().includes(needle));
		const rows: OmniRow[] = [];
		if (agentAvailable) {
			rows.push({
				value: rowValue('command', 'ask-agent'),
				kind: 'command',
				label: t('pod.shell.omniNewConversation'),
				description: t('pod.shell.omniNewConversationHint'),
				icon: 'product:agent',
				run: onAskAgent
			});
		}
		rows.push({
			value: rowValue('command', 'overview'),
			kind: 'command',
			label: t('pod.shell.omniOpenWorkspace'),
			icon: 'lucide:layout-dashboard',
			run: () => {
				onNavigate('/');
				open = false;
			}
		});
		for (const item of flattenedSystem()) {
			rows.push({
				value: rowValue('command', item.key),
				kind: 'command',
				label: item.label,
				icon: 'lucide:settings',
				run: () => {
					onNavigate(item.href);
					open = false;
				}
			});
		}
		return rows.filter((row) => matches(row.label ?? '', []));
	});

	const items = $derived.by((): Command.CommandItemData[] => {
		const out: OmniRow[] = [];
		const needle = query.trim();
		const group = (kind: 'apps' | 'records' | 'commands'): OmniRow => ({
			value: rowValue('group', kind),
			kind: 'group',
			disabled: true,
			label:
				kind === 'apps'
					? t('pod.shell.omniApps')
					: kind === 'records'
						? t('pod.shell.omniRecords')
						: t('pod.shell.omniCommands')
		});
		if (appRows.length > 0) {
			out.push(group('apps'));
			out.push(...appRows);
		}
		if (needle) {
			if (recordsLoading && recordRows.length === 0) {
				out.push(group('records'));
				out.push({ value: rowValue('loading', 'records'), kind: 'loading', disabled: true });
			} else if (recordRows.length > 0) {
				out.push(group('records'));
				out.push(...recordRows);
			}
		}
		if (commandRows.length > 0) {
			out.push(group('commands'));
			out.push(...commandRows);
		}
		if (needle && !recordsLoading && out.filter((row) => !row.disabled).length === 0) {
			out.push({
				value: rowValue('empty', 'none'),
				kind: 'empty',
				disabled: true,
				label: t('pod.shell.omniNoResults', { query: needle })
			});
		}
		return out;
	});

	function runValue(value: string | null): void {
		if (!value) return;
		const row = items.find((candidate) => candidate.value === value);
		if (row && typeof row.run === 'function') row.run();
	}
</script>

<Dialog.Root bind:open {onOpenChange}>
	<Dialog.Content
		class="w-[min(36rem,calc(100vw-2rem))] gap-0 overflow-hidden p-0 shadow-2xl [&>button]:hidden"
		onOpenAutoFocus={(event) => {
			// The palette input, not the dialog shell, takes the caret on open; the default would
			// focus the content container and swallow the first keystroke.
			event.preventDefault();
			queueMicrotask(() => inputElement?.focus());
		}}
	>
		<Command.Root
			{items}
			shouldFilter={false}
			onValueChange={runValue}
			onIndicatorKeydown={(event, { indicatorValue }) => {
				if (event.key !== 'Enter') return false;
				event.preventDefault();
				runValue(indicatorValue);
				return true;
			}}
		>
			<Command.Input
				bind:ref={inputElement}
				value={query}
				oninput={onQueryInput}
				placeholder={t('pod.shell.omniPlaceholder')}
				aria-label={t('pod.shell.omniTitle')}
				class="h-9 text-sm"
			>
				{#snippet prefix()}
					<Icon icon="lucide:search" class="size-3.5 shrink-0 text-muted-foreground" />
				{/snippet}
			</Command.Input>
			<Command.List itemHeight={34} gap={0} class="max-h-[min(60vh,22rem)]">
				{#snippet itemSnippet({ item, isIndicator })}
					{@const row = item as OmniRow}
					{@const highlighted = isIndicator && row.kind !== 'group' && row.kind !== 'empty'}
					<Inline
						fill
						gap={row.kind === 'group' ? 'xs' : 'sm'}
						justify={row.kind === 'empty' ? 'center' : 'start'}
						class={`${
							row.kind === 'group'
								? 'px-3 text-micro font-normal uppercase tracking-wide text-muted-foreground sm:text-tiny'
								: 'px-3'
						} ${highlighted ? 'bg-accent text-accent-foreground' : ''} ${
							row.kind === 'app' && row.depth === 1 ? 'pl-7' : ''
						}`}
					>
						{#if row.kind === 'group'}
							<span>{row.label}</span>
						{:else if row.kind === 'loading'}
							<Icon
								icon="lucide:loader-circle"
								class="size-3 shrink-0 animate-spin text-muted-foreground"
							/>
							<span class="text-xs text-muted-foreground"
								>{t('pod.shell.omniSearchingRecords')}</span
							>
						{:else if row.kind === 'empty'}
							<span class="truncate text-xs text-muted-foreground">{row.label}</span>
						{:else}
							{#if row.thumbnail}
								<span class="size-4 shrink-0 overflow-hidden rounded-sm">
									<img
										src={row.thumbnail}
										alt=""
										class="size-full object-cover"
										loading="lazy"
										decoding="async"
									/>
								</span>
							{:else if row.icon}
								<IconWrapper name={row.icon} class="size-3.5 shrink-0 text-muted-foreground" />
							{:else}
								<Icon
									icon={row.kind === 'record' ? 'lucide:file-text' : 'lucide:circle'}
									class="size-3.5 shrink-0 text-muted-foreground"
								/>
							{/if}
							<span
								class="min-w-0 flex-1 truncate text-xs font-normal text-foreground sm:text-micro"
								>{row.label}</span
							>
							{#if row.description}
								<span class="max-w-40 shrink-0 truncate text-micro text-muted-foreground"
									>{row.description}</span
								>
							{/if}
						{/if}
					</Inline>
				{/snippet}
			</Command.List>
		</Command.Root>
	</Dialog.Content>
</Dialog.Root>
