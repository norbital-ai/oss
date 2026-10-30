<!--
	The workspace's command center: what happens across it, one tab each (a deep link `/command-center/<tab>`). Activity,
	Resources and Logs are the host's inspection (`studioInspect`, a Studio host's, read once for all three): the build and
	release timeline (the serving version marked in it), resource use and the runtime log. Logs reads the log itself
	(`logs`), scoped to one release's serving window (the serving release by default) and optionally a run; its opt-in
	Auto-refresh re-reads only that. Audit is the audit trail,
	Automations every run, Inference the automations' inference transcripts (opened read-only in Norbius), People the
	members and invitations. `tabs` is what this viewer gets (`commandCenterTabs`); rollbacks are Studio's, not here.
-->
<script lang="ts">
	import {
		Table,
		Tabs,
		WorkspaceOperations,
		EmptyState,
		releaseWindow,
		type WorkspaceOperationsData,
		type WorkspaceRange,
		type WorkspaceScope,
		type WorkspaceView
	} from '@norbital-ai/ui';
	import { fork, observe, observeOnce } from '@norbital-ai/ui/effect';
	import { AppHeader, Stack } from '@norbital-ai/ui/layout';
	import { MediaQuery } from 'svelte/reactivity';
	import { watch } from 'runed';
	import type { AgentConversation } from '../../protocol/wire.ts';
	import type { ShellApi } from '../api-types.ts';
	import type { ShellBolt } from '../runtime.ts';
	import { based, type CommandCenterTab, type ShellBoot } from '../nav.ts';
	import Audit from '../audit/Audit.svelte';
	import AutoRefresh from '../AutoRefresh.svelte';
	import Runs from '../runs/Runs.svelte';
	import People from '../people/People.svelte';
	import banner from '../assets/banners/command-center.jpg';

	let {
		api,
		bolt,
		t,
		tabs,
		tab,
		onTab,
		admin,
		startable,
		run = null,
		onRun,
		onConversation
	}: {
		api: ShellApi;
		bolt: ShellBolt;
		t: (key: string) => string;
		tabs: readonly CommandCenterTab[];
		tab: CommandCenterTab | undefined;
		onTab: (tab: CommandCenterTab) => void;
		admin: boolean;
		startable: NonNullable<ShellBoot['startable']>;
		run?: string | null;
		onRun: (id: string | null) => void;
		/** Opens an inference transcript in Norbius; `null` without Norbius. */
		onConversation: ((id: string) => void) | null;
	} = $props();
	const narrow = new MediaQuery('max-width: 47.999rem');
	const active = $derived(
		tab !== undefined && tabs.includes(tab) ? tab : (tabs[0] ?? 'automations')
	);
	const VIEWS: { readonly [k in CommandCenterTab]?: WorkspaceView } = {
		activity: 'activity',
		resources: 'resources',
		logs: 'logs'
	};
	const view = $derived(VIEWS[active]);

	// one inspection serves Activity, Resources and Logs: switching between them is a local render
	let range = $state<WorkspaceRange>('7d');
	let build = $state<string | null>(null),
		runFilter = $state<string | null>(null),
		// the release Logs reads (its publication instant): the serving one until chosen, `null` every release
		release = $state<string | null | undefined>();
	const inspecting = $derived(view !== undefined);
	const inspection = observeOnce(() => (inspecting ? api.studioInspect({ range, build }) : null));
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
	const logs = observeOnce(() =>
		view === 'logs' && shown !== null
			? api.logs({
					...releaseWindow(releases, releaseAt),
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
		if (next.build !== undefined) build = next.build;
		if (next.run !== undefined) runFilter = next.run;
	}

	// the automations' inference transcripts: the conversations a run recorded
	const conversations = observe(() =>
		active === 'inference'
			? bolt.observe<{ rows: AgentConversation[] }>({ read: { m: 'conversations', a: [] } })
			: null
	);
	const transcripts = $derived(
		(conversations.current?.rows ?? [])
			.filter((c) => c.run != null)
			.map((c) => ({
				id: c.id,
				title: c.title ?? t('Conversation'),
				run: c.run ?? '',
				status: t(c.status === 'running' ? 'Running' : c.status === 'stopped' ? 'Stopped' : 'Idle'),
				at: new Date(c.at).toLocaleString(bolt.locale)
			}))
	);
	const TITLES: { readonly [k in CommandCenterTab]: string } = {
		activity: 'Activity',
		resources: 'Resources',
		logs: 'Logs',
		audit: 'Audit',
		automations: 'Automations',
		inference: 'Inference',
		people: 'People'
	};
	const ICONS: { readonly [k in CommandCenterTab]: string } = {
		activity: 'lucide:history',
		resources: 'lucide:activity',
		logs: 'lucide:scroll-text',
		audit: 'lucide:shield-check',
		automations: 'lucide:refresh-cw',
		inference: 'lucide:sparkles',
		people: 'lucide:users'
	};
</script>

{#snippet operations()}
	{#if inspection.error !== undefined}<p role="alert" class="text-xs text-destructive">
			{inspection.error.message}
		</p>{/if}
	{#if view !== undefined && data !== null}
		<WorkspaceOperations
			{data}
			scopeKey={based('')}
			{range}
			{view}
			views={[view]}
			busy={inspection.loading || (view === 'logs' && logs.loading)}
			onChange={scope}
			bind:release
			{t}
		>
			{#snippet actions()}<AutoRefresh {t} onRefresh={() => fork(logs.refetch())} />{/snippet}
		</WorkspaceOperations>
	{:else if inspection.error === undefined}
		<p class="text-meta" role="status">{t('Loading…')}</p>
	{/if}
{/snippet}
{#snippet inference()}
	{#if conversations.error !== undefined}<p role="alert" class="text-xs text-destructive">
			{conversations.error.message}
		</p>{/if}
	<Table
		of={transcripts}
		key="inference"
		onOpen={(row) => onConversation?.(row.id)}
		toolbar={{ export: true }}
		columns={[
			{ field: 'title', label: t('Conversation') },
			{ field: 'run', label: t('Run') },
			{ field: 'status', label: t('Status') },
			{ field: 'at', label: t('Last active') }
		]}
	>
		{#snippet empty()}
			<EmptyState variant="inset" icon="history" title={t('No inference calls yet.')} />
		{/snippet}
	</Table>
{/snippet}
{#snippet body()}
	<!-- the operations views fill the panel (their own regions scroll); the others grow and the panel scrolls -->
	<div
		class={[
			'flex min-w-0 flex-col gap-3 px-4 pb-6 sm:px-6',
			view !== undefined && 'h-full min-h-0'
		]}
	>
		{#if active === 'audit'}
			<Audit {api} {t} locale={bolt.locale} {admin} />
		{:else if active === 'automations'}
			<Runs {api} {bolt} {t} {startable} {run} {onRun} />
		{:else if active === 'inference'}
			{@render inference()}
		{:else if active === 'people'}
			<People {api} {t} locale={bolt.locale} />
		{:else}
			{@render operations()}
		{/if}
	</div>
{/snippet}

<Stack gap="none" size="fill" class="bg-background">
	<AppHeader
		src={banner}
		icon="lucide:radar"
		title={t('Command center')}
		description={t('Builds, logs, audit, runs and people across the workspace.')}
		compact={narrow.current}
	/>
	<Tabs
		value={active}
		level={1}
		onValueChange={(next) => {
			const picked = tabs.find((x) => x === next);
			if (picked !== undefined) onTab(picked);
		}}
		class="mt-4 min-h-0 flex-1 gap-3 [&>div:first-child]:px-4 sm:[&>div:first-child]:px-6"
		tabs={tabs.map((name) => ({ name, title: t(TITLES[name]), icon: ICONS[name], body }))}
	/>
</Stack>
