<!--
	The workspace's command center: host-agnostic operations shipped with every Bolt workspace (untethered or tethered),
	one tab each (a deep link `/command-center/<tab>`). Logs reads Bolt's own `Logs` port directly; Audit is the audit
	trail; Queue lists every automation run; AI lists workspace conversations, readable envoy threads and automation
	transcripts; People manages members and invitations. Host-supplied authoring, improvements, activity, telemetry and
	bundle analysis belong to Workspace Studio, never here.
-->
<script lang="ts">
	import { date_time } from '../i18n.ts';
	import {
		Badge,
		Combobox,
		EmptyState,
		Icon,
		LogView,
		Table,
		TableSkeleton,
		Tabs,
		type UiContext
	} from '@norbital-ai/ui';
	import { fork, observe, observe_once } from '@norbital-ai/ui/effect';
	import { AppHeader, Stack } from '@norbital-ai/ui/layout';
	import { MediaQuery } from 'svelte/reactivity';
	import type { AgentConversation } from '../../protocol/wire.ts';
	import { ConversationsReadAnswer, type ShellApi } from '../api-types.ts';
	import type { ShellBolt } from '../runtime.ts';
	import type { CommandCenterTab, ShellBoot } from '../nav.ts';
	import Audit from '../audit/Audit.svelte';
	import AutoRefresh from '../AutoRefresh.svelte';
	import Runs from '../runs/Runs.svelte';
	import People from '../people/People.svelte';
	import Alerts from './Alerts.svelte';
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
		startable: ShellBoot['startable'];
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

	// Runtime logs read Bolt's own `/__bolt/shell/logs` endpoint directly — works identically untethered or tethered.
	let runFilter = $state<string | null>(null);
	let runSearch = $state('');
	const logs = observe_once(() =>
		active === 'logs'
			? api.logs(runFilter === null ? {} : { run: runFilter })
			: null
	);
	const logRows = $derived(logs.current ?? []);
	const runOptions = $derived.by(() => {
		const ids = new Set(logRows.flatMap((row) => (row.run === null ? [] : [row.run])));
		if (runFilter) ids.add(runFilter);
		const asked = runSearch.trim().slice(0, 200);
		if (asked) ids.add(asked);
		return [
			{ value: '', label: t('All runs') },
			...Array.from(ids, (id) => ({ value: id, label: id, keywords: id }))
		];
	});
	const logLines = $derived(
		[...logRows].reverse().map((row) => ({
			id: row.id,
			at: row.at,
			level: row.severity,
			message: `${row.event} ${JSON.stringify(row.attributes)}`,
			source: row.run === null ? null : `run ${row.run}`
		}))
	);

	// Workspace administration is separate from the member's own Norbius selector.
	const conversations = observe(() =>
		active === 'inference'
			? bolt.observe(
					{ read: { m: 'conversations', a: [{ scope: 'workspace' }] } },
					ConversationsReadAnswer
				)
			: null
	);
	const AI_ICONS = {
		web: 'lucide:monitor',
		envoy: 'lucide:send',
		infer: 'lucide:workflow',
		// a system agent's task: no person attends it
		system: 'lucide:bot'
	} as const;
	const categoryOf = (c: AgentConversation): keyof typeof AI_ICONS =>
		c.run != null ? 'infer' : c.kind === 'task' ? 'system' : c.envoy !== null ? 'envoy' : 'web';
	const transcripts = $derived(
		(conversations.current?.rows ?? []).map((c) => ({
			id: c.id,
			category: categoryOf(c),
			title: c.title ?? t('Conversation'),
			// an envoy thread: its envoy, instance and kind; an automation's: its run
			source:
				c.run ??
				c.peer ??
				[c.envoy, c.integration, c.kind].filter((part) => part !== null).join(' · '),
			status: t(
				c.archived
					? 'Archived'
					: c.status === 'running'
						? 'Running'
						: c.status === 'stopped'
							? 'Stopped'
							: 'Idle'
			),
			at: date_time(c.at, bolt.locale)
		}))
	);
	const TITLES: { readonly [k in CommandCenterTab]: string } = {
		logs: 'Logs',
		audit: 'Audit',
		automations: 'Queue',
		inference: 'AI',
		people: 'People',
		alerts: 'Alerts'
	};
	const ICONS: { readonly [k in CommandCenterTab]: string } = {
		logs: 'lucide:scroll-text',
		audit: 'concept:access',
		automations: 'concept:automations',
		inference: 'lucide:sparkles',
		people: 'lucide:users',
		alerts: 'lucide:bell-ring'
	};
</script>

{#snippet logsView()}
	<div class="flex h-full min-h-0 flex-1 flex-col gap-3">
		{#if logs.error !== undefined}<p role="alert" class="text-xs text-destructive">
				{logs.error.message}
			</p>{/if}
		{#if logs.loading && logs.current === undefined}
			<TableSkeleton />
		{:else}
			<LogView {ctx} rows={logLines} follow={false}>
				{#snippet controls()}
					<h2 class="px-1 text-sm font-semibold">{t('Logs')}</h2>
					<Combobox
						class="w-64"
						aria-label={t('Automation run')}
						searchable
						value={runFilter ?? ''}
						options={runOptions}
						on_search={(query) => {
							runSearch = query;
						}}
						on_change={(next) => next !== null && (runFilter = next || null)}
					/>
				{/snippet}
				{#snippet trailing()}
					<AutoRefresh {t} on_refresh={() => fork(logs.refetch())} />
				{/snippet}
				{#snippet empty()}
					<EmptyState
						variant="inset"
						size="fill"
						icon="history"
						title={t('No log lines')}
						hint={t('Automation runs, assistant turns and envoy messages write here.')}
					/>
				{/snippet}
			</LogView>
		{/if}
	</div>
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
	<div class="flex h-full min-h-0 min-w-0 flex-1 flex-col gap-3 pb-4">
		{#if active === 'logs'}
			{@render logsView()}
		{:else if active === 'audit'}
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
		{:else if active === 'alerts'}
			<Alerts {api} {t} locale={bolt.locale} />
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
			description={t('Logs, audit, runs, AI transcripts, people and alerts across the workspace.')}
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
