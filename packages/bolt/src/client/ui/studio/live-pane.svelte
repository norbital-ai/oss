<script lang="ts">
	import Icon from '@iconify/svelte';
	import { Button } from '@norbital-ai/ui/button';
	import { useI18n } from '@norbital-ai/ui/i18n';
	import { Cluster, Inline, Scroll, Stack } from '@norbital-ai/ui/layout';
	import { Tabs, type TabConfig } from '@norbital-ai/ui/tabs';
	import BundleLogs from './bundle-logs.svelte';
	import ManifestPane from './manifest-pane.svelte';
	import type { AuthoringLiveState } from '#lib/client/ui/studio/authoring-live.js';
	import {
		type EnvironmentVariable,
		type LiveReleaseRow,
		type ManifestDestination,
		type ManifestSection,
		type WorkspaceManifest
	} from '#lib/client/ui/studio/studio-state.js';

	let {
		releases = [],
		selectedReleaseId,
		busy = false,
		canRestore = false,
		manifest,
		loading = false,
		sections = [],
		envoys = [],
		selectedManifest = 'collections',
		environment = [],
		environmentError,
		liveLogs = [],
		onrestore,
		onopenSource,
		onopenDestination,
		canOpenDestination,
		onretry
	}: {
		releases?: ReadonlyArray<LiveReleaseRow>;
		selectedReleaseId?: string | undefined;
		busy?: boolean;
		canRestore?: boolean;
		manifest?: WorkspaceManifest | undefined;
		loading?: boolean;
		sections?: ReadonlyArray<ManifestSection>;
		envoys?: WorkspaceManifest['envoys'];
		selectedManifest?: string;
		environment?: ReadonlyArray<EnvironmentVariable>;
		environmentError?: string | undefined;
		liveLogs?: AuthoringLiveState['logs'];
		onrestore?: (() => void) | undefined;
		onopenSource?: ((path: string) => void) | undefined;
		onopenDestination?: ((destination: ManifestDestination) => void) | undefined;
		canOpenDestination?: ((destination: ManifestDestination) => boolean) | undefined;
		onretry?: (() => void) | undefined;
	} = $props();
	const { t } = useI18n();

	const selected = $derived(
		releases.find((release) => release.releaseId === selectedReleaseId) ?? releases[0]
	);
	let liveView = $state<'manifest' | 'logs'>('manifest');
	const liveTabs = $derived(
		[
			{ name: 'manifest', label: t('bolt.studio.manifest'), content: '' },
			{ name: 'logs', label: t('bolt.studio.changes.logs'), content: '' }
		] satisfies TabConfig[]
	);
</script>

{#if selected === undefined}
	<Stack gap="sm" fill align="center" justify="center" class="px-6 text-center">
		<Icon icon="lucide:history" class="size-9 text-muted-foreground/30" />
		<p class="text-sm font-medium text-foreground">{t('bolt.studio.noReleases')}</p>
	</Stack>
{:else}
	<Stack gap="none" fill class="min-h-0">
		<Stack gap="sm" shrink={false} class="border-b border-border/60 px-4 py-3 sm:px-6">
			<Inline align="start" gap="sm" class="flex-wrap">
				<Stack gap="xs" grow class="min-w-0">
					<Cluster gap="xs">
						<h2 class="truncate font-mono text-sm font-semibold text-foreground">
							{selected.releaseId}
						</h2>
						{#if selected.current}
							<span class="rounded-full border border-border/70 bg-muted px-2 py-0.5 text-micro">
								{t('bolt.studio.currentRelease')}
							</span>
						{/if}
					</Cluster>
					{#if selected.artifactId !== undefined}
						<p class="font-mono text-micro text-muted-foreground">
							{t('bolt.studio.compiledArtifact', { artifactId: selected.artifactId })}
						</p>
					{/if}
				</Stack>
				<Button
					type="button"
					size="sm"
					variant="outline"
					disabled={!canRestore || busy || !selected.current}
					disabledMessage={t('bolt.studio.restoreReason')}
					onclick={() => onrestore?.()}
				>
					<Icon icon="lucide:history" class="size-3.5" />
					{t('bolt.studio.restore')}
				</Button>
			</Inline>
			<Tabs
				value={liveView}
				onValueChange={(next) => {
					if (next === 'manifest' || next === 'logs') liveView = next;
				}}
				showContent={false}
				animate={false}
				variant="underline"
				listClass="mx-0"
				config={liveTabs}
			/>
		</Stack>
		{#if liveView === 'manifest'}
			<ManifestPane
				{manifest}
				{loading}
				{sections}
				{envoys}
				selected={selectedManifest}
				{environment}
				{environmentError}
				{onopenSource}
				{onopenDestination}
				{canOpenDestination}
				{onretry}
			/>
		{:else}
			<Scroll name={t('bolt.studio.changes.logs')} grow class="p-4 sm:p-6">
				<BundleLogs build={selected.build} deploy={selected.deploy} {liveLogs} />
			</Scroll>
		{/if}
	</Stack>
{/if}
