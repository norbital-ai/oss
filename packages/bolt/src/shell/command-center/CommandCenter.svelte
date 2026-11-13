<!--
	The workspace's command center: what happens across it, one tab each (a deep link `/command-center/<tab>`). Bundle,
	Telemetry and Logs are the host's inspection (`studio_inspect`, a Studio host's, read once for all three): the
	bundle analyzer (artifact digest, client bytes, package pins, bundle files and cache), resource telemetry and the
	runtime log. Logs reads the log itself
	(`logs`), scoped to one release's serving window (the serving release by default) and optionally a run; its opt-in
	Auto-refresh re-reads only that. Audit is the audit trail,
	Automations every run, Inference the automations' inference transcripts (opened read-only in Norbius), People the
	members and invitations. `tabs` is what this viewer gets (`command_center_tabs`); rollbacks are Studio's, not here.
-->
<script lang="ts">
	import { date_time } from '../i18n.ts';
	import {
		Badge,
		Icon,
		Table,
		Tabs,
		WorkspaceOperations,
		EmptyState,
		release_window,
		type WorkspaceOperationsData,
		type WorkspaceRange,
		type WorkspaceScope,
		type WorkspaceView,
		type UiContext
	} from '@norbital-ai/ui';
	import { fork, observe, observe_once } from '@norbital-ai/ui/effect';
	import { AppHeader, Stack } from '@norbital-ai/ui/layout';
	import { MediaQuery } from 'svelte/reactivity';
	import { watch } from 'runed';
	import type { AgentConversation } from '../../protocol/wire.ts';
	import { ConversationsReadAnswer, type ShellApi } from '../api-types.ts';
	import type { ShellBolt } from '../runtime.ts';
	import type { CommandCenterTab, ShellBoot } from '../nav.ts';
	import Audit from '../audit/Audit.svelte';
	import AutoRefresh from '../AutoRefresh.svelte';
	import Runs from '../runs/Runs.svelte';
	import People from '../people/People.svelte';
	import type { SystemUiIntent } from '../../protocol/system-ui.ts';
	import banner from '../assets/banners/command-center.jpg';

	let {
		ctx,
		api,
		bolt,
		t,
		tabs,
		tab,
		on_tab,
		admin,
		startable,
		run = null,
		on_run,
		on_conversation,
		configuration = null,
		automation = null,
		on_automation_close = () => {}
	}: {
		ctx: UiContext;
		api: ShellApi;
		bolt: ShellBolt;
		t: (key: string) => string;
		tabs: readonly CommandCenterTab[];
		tab: CommandCenterTab | undefined;
		on_tab: (tab: CommandCenterTab) => void;
		admin: boolean;
		startable: NonNullable<ShellBoot['startable']>;
		run?: string | null;
		on_run: (id: string | null) => void;
		/** Opens an inference transcript in Norbius; `null` without Norbius. */
		on_conversation: ((id: string) => void) | null;
		configuration?: SystemUiIntent | null;
		automation?: string | null;
		on_automation_close?: () => void;
	} = $props();
	const narrow = new MediaQuery('max-width: 47.999rem');
	const active = $derived(
		tab !== undefined && tabs.includes(tab) ? tab : (tabs[0] ?? 'automations')
	);
	const VIEWS: { readonly [k in CommandCenterTab]?: WorkspaceView } = {
		bundle: 'bundle',
		telemetry: 'telemetry',
		logs: 'logs'
	};
	const view = $derived(VIEWS[active]);

	// one inspection serves Bundle, Telemetry and Logs: switching between them is a local render
	let range = $state<WorkspaceRange>('7d');
	let runFilter = $state<string | null>(null),
		// the release Logs reads (its publication instant): the serving one until chosen, `null` every release
		release = $state<string | null | undefined>();
	const inspecting = $derived(view !== undefined);
	const inspection = observe_once(() => (inspecting ? api.studio_inspect({ range }) : null));
	// a new scope reads while the last answer stays on screen
	let shown = $state<WorkspaceOperationsData | null>(null);
	watch(
		() => inspection.current,
		(next) => {
			if (next !== undefined) shown = next;
		}
	);
	// Logs reads the log itself, scoped to the chosen release's serving window and run: Auto-refresh re-reads only this
	const releases = $derived(shown?.studio?.releases ?? []);
	const releaseAt = $derived(
		release === undefined ? (releases.find((r) => r.current)?.at ?? null) : release
	);
	const logs = observe_once(() =>
		view === 'logs' && shown !== null
			? api.logs({
					...release_window(releases, releaseAt),
					...(runFilter === null ? {} : { run: runFilter })
				})
			: null
	);
	const data = $derived(
		shown === null
			? null
			: view === 'logs'
				? {
						...shown,
						logs: logs.current ?? shown.logs,
						filters: { ...shown.filters, run: runFilter ?? '' },
						errors:
							logs.error === undefined
								? shown.errors
								: {
										access: null,
										studio: null,
										bundles: null,
										cache: null,
										build: null,
										...shown.errors,
										logs: logs.error.message
									}
					}
				: shown
	);
	function scope(next: WorkspaceScope): void {
		if (next.range !== undefined) range = next.range;
		if (next.run !== undefined) runFilter = next.run;
	}

	// every AI transcript the viewer may read: their own in-app conversations, envoy threads and automation inference
	const conversations = observe(() =>
		active === 'inference'
			? bolt.observe({ read: { m: 'conversations', a: [] } }, ConversationsReadAnswer)
			: null
	);
	const AI_ICONS = {
		web: 'lucide:monitor',
		envoy: 'lucide:send',
		infer: 'lucide:workflow'
	} as const;
	const categoryOf = (c: AgentConversation): keyof typeof AI_ICONS =>
		c.run != null ? 'infer' : c.envoy !== null ? 'envoy' : 'web';
	const transcripts = $derived(
		(conversations.current?.rows ?? []).map((c) => ({
			id: c.id,
			category: categoryOf(c),
			title: c.title ?? t('Conversation'),
			// an envoy thread: its envoy, instance and kind; an automation's: its run
			source: c.run ?? [c.envoy, c.integration, c.kind].filter((part) => part !== null).join(' · '),
			status: t(c.status === 'running' ? 'Running' : c.status === 'stopped' ? 'Stopped' : 'Idle'),
			at: date_time(c.at, bolt.locale)
		}))
	);
	const TITLES: { readonly [k in CommandCenterTab]: string } = {
		bundle: 'Bundle',
		telemetry: 'Telemetry',
		logs: 'Logs',
		audit: 'Audit',
		automations: 'Queue',
		inference: 'AI',
		people: 'People'
	};
	const ICONS: { readonly [k in CommandCenterTab]: string } = {
		bundle: 'lucide:package',
		telemetry: 'lucide:activity',
		logs: 'lucide:scroll-text',
		audit: 'concept:access',
		automations: 'concept:automations',
		inference: 'lucide:sparkles',
		people: 'lucide:users'
	};
</script>

{#snippet operations()}
	{#if inspection.error !== undefined}<p role="alert" class="text-xs text-destructive">
			{inspection.error.message}
		</p>{/if}
	{#if view !== undefined && data !== null}
		<WorkspaceOperations {ctx}
			{data}
			{range}
			{view}
			views={[view]}
			busy={inspection.loading || (view === 'logs' && logs.loading)}
			on_change={scope}
			bind:release
			{t}
		>
			{#snippet actions()}<AutoRefresh {t} on_refresh={() => fork(logs.refetch())} />{/snippet}
		</WorkspaceOperations>
	{:else if inspection.error === undefined}
		<p class="text-meta" role="status">{t('Loading…')}</p>
	{/if}
{/snippet}
{#snippet aiCategory({ row }: { row: (typeof transcripts)[number]; value: unknown })}
	<Badge
		variant={row.category === 'web' ? 'brand' : 'outline'}
		class="gap-1"
		data-ai-category={row.category}
		><Icon name={AI_ICONS[row.category]} class="size-3" />{row.category}</Badge
	>
{/snippet}
{#snippet inference()}
	{#if conversations.error !== undefined}<p role="alert" class="text-xs text-destructive">
			{conversations.error.message}
		</p>{/if}
	<Table {ctx}
		of={transcripts}
		key="inference"
		on_open={(row) => on_conversation?.(row.id)}
		toolbar={{ export: true }}
		columns={[
			{ field: 'category', label: t('Category'), cell: aiCategory },
			{ field: 'title', label: t('Conversation') },
			{ field: 'source', label: t('Source') },
			{ field: 'status', label: t('Status') },
			{ field: 'at', label: t('Last active') }
		]}
	>
		{#snippet empty()}
			<EmptyState variant="inset" icon="history" title={t('No AI transcripts yet.')} />
		{/snippet}
	</Table>
{/snippet}
{#snippet body()}
	<!-- the operations views fill the panel (their own regions scroll); the others grow and the panel scrolls -->
	<div
		class={[
			'flex min-w-0 flex-col gap-3 pb-6',
			view !== undefined && 'h-full min-h-0'
		]}
	>
		{#if active === 'audit'}
			<Audit {ctx} {api} {t} locale={bolt.locale} catalog={bolt.catalog} {admin} />
		{:else if active === 'automations'}
			<Runs {ctx}
				{api}
				{bolt}
				{t}
				{startable}
				{run}
				{on_run}
				initial_automation={automation}
				{on_automation_close}
			/>
		{:else if active === 'inference'}
			{@render inference()}
		{:else if active === 'people'}
			<People {ctx} {api} {t} locale={bolt.locale} {configuration} />
		{:else}
			{@render operations()}
		{/if}
	</div>
{/snippet}

<Stack gap="none" size="fill" class="bg-background">
	<!-- a phone's top bar already names the page -->
	{#if !narrow.current}
		<AppHeader
			src={banner}
			icon="lucide:radar"
			title={t('Command center')}
			description={t('Bundles, telemetry, logs, audit, runs and people across the workspace.')}
		/>
	{/if}
	<Tabs
		value={active}
		level={1}
		on_value_change={(next) => {
			const picked = tabs.find((x) => x === next);
			if (picked !== undefined) on_tab(picked);
		}}
		class="mt-4 min-h-0 flex-1 gap-3"
		tabs={tabs.map((name) => ({ name, title: t(TITLES[name]), icon: ICONS[name], body }))}
	/>
</Stack>
