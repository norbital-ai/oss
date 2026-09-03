<script lang="ts">
	import { useI18n } from '@norbital-ai/ui/i18n';
	import { Grid, Scroll, Stack } from '@norbital-ai/ui/layout';
	import {
		authoringLogTone,
		type AuthoringLiveState
	} from '#lib/client/ui/studio/authoring-live.js';
	import type { WorkbenchBuildReceipt } from '#lib/client/ui/studio/studio-state.js';

	let {
		build,
		deploy = [],
		liveLogs = []
	}: {
		build?: WorkbenchBuildReceipt | undefined;
		deploy?: ReadonlyArray<{
			readonly at: string;
			readonly level: string;
			readonly line: string;
		}>;
		liveLogs?: AuthoringLiveState['logs'];
	} = $props();
	const { t } = useI18n();

	const duration = $derived.by(() => {
		if (build === undefined) return undefined;
		const milliseconds = Date.parse(build.completedAt) - Date.parse(build.startedAt);
		return Number.isFinite(milliseconds) && milliseconds >= 0
			? t('bolt.studio.durationSeconds', {
					count: (milliseconds / 1000).toFixed(milliseconds < 10_000 ? 1 : 0)
				})
			: undefined;
	});

	const buildOutcomeLabel = (outcome: WorkbenchBuildReceipt['outcome']): string => {
		switch (outcome) {
			case 'succeeded':
				return t('bolt.studio.buildOutcome.succeeded');
			case 'failed':
				return t('bolt.studio.buildOutcome.failed');
			case 'migration_required':
				return t('bolt.studio.buildOutcome.migrationRequired');
			default: {
				const unhandled: never = outcome;
				throw new Error(`Unhandled build outcome: ${String(unhandled)}`);
			}
		}
	};

	const buildPhaseLabel = (phase: WorkbenchBuildReceipt['phase']): string => {
		switch (phase) {
			case 'prepare':
				return t('bolt.studio.phase.prepare');
			case 'checks':
				return t('bolt.studio.phase.checks');
			case 'publish':
				return t('bolt.studio.phase.publish');
			case 'provision':
				return t('bolt.studio.phase.provision');
			case 'complete':
				return t('bolt.studio.phase.complete');
			default: {
				const unhandled: never = phase;
				throw new Error(`Unhandled build phase: ${String(unhandled)}`);
			}
		}
	};

	const cacheLabel = (cache: WorkbenchBuildReceipt['cache']): string => {
		switch (cache) {
			case 'hit':
				return t('bolt.studio.cache.hit');
			case 'miss':
				return t('bolt.studio.cache.miss');
			case 'not_reached':
				return t('bolt.studio.cache.notReached');
			default: {
				const unhandled: never = cache;
				throw new Error(`Unhandled cache state: ${String(unhandled)}`);
			}
		}
	};

	const logToneClass = (level: string): string => {
		const tone = authoringLogTone(level);
		switch (tone) {
			case 'danger':
				return 'text-destructive';
			case 'warning':
				return 'text-amber-800 dark:text-amber-300';
			case 'info':
				return 'text-muted-foreground';
			case 'default':
				return 'text-foreground';
			default: {
				const unhandled: never = tone;
				throw new Error(`Unhandled authoring log tone: ${String(unhandled)}`);
			}
		}
	};
</script>

<Stack gap="lg" data-testid="studio-bundle-logs">
	<Stack as="section" gap="sm">
		<h3 class="text-overline">{t('bolt.studio.buildDetails')}</h3>
		{#if build === undefined}
			<p class="text-meta">{t('bolt.studio.noBuildLog')}</p>
		{:else}
			<Stack gap="sm" class="rounded-md bg-muted/35 p-3">
				<p class="text-xs text-foreground">
					{t('bolt.studio.previewOutcome', { outcome: buildOutcomeLabel(build.outcome) })}
				</p>
				<p class="text-micro text-muted-foreground">{build.summary}</p>
				<Grid as="dl" gap="xs" tracks="auto 1fr" class="text-micro">
					<dt class="text-muted-foreground">{t('bolt.studio.phase')}</dt>
					<dd>{buildPhaseLabel(build.phase)}</dd>
					<dt class="text-muted-foreground">{t('bolt.studio.commit')}</dt>
					<dd class="break-all font-mono">{build.commit}</dd>
					<dt class="text-muted-foreground">{t('bolt.studio.cache')}</dt>
					<dd>{cacheLabel(build.cache)}</dd>
					{#if duration !== undefined}
						<dt class="text-muted-foreground">{t('bolt.studio.duration')}</dt>
						<dd>{duration}</dd>
					{/if}
				</Grid>
				{#if build.stdout !== undefined}
					<Scroll name="Build stdout" class="max-h-64">
						<pre
							class="whitespace-pre-wrap break-all rounded-md bg-background p-2 font-mono text-micro text-foreground">{build.stdout}</pre>
					</Scroll>
				{/if}
				{#if build.stderr !== undefined}
					<Scroll name="Build stderr" class="max-h-64">
						<pre
							class="whitespace-pre-wrap break-all rounded-md bg-background p-2 font-mono text-micro text-destructive">{build.stderr}</pre>
					</Scroll>
				{/if}
			</Stack>
		{/if}
	</Stack>

	<Stack as="section" gap="sm">
		<h3 class="text-overline">{t('bolt.studio.runtimeDetails')}</h3>
		{#if deploy.length === 0 && liveLogs.length === 0}
			<p class="text-meta">{t('bolt.studio.noDeployLog')}</p>
		{:else}
			<Scroll name="Deploy log" class="max-h-64">
				<ul class="rounded-md bg-muted/35 p-3 font-mono text-micro text-foreground">
					{#each deploy as line, index (`${line.at}:${index}`)}
						<li class={`whitespace-pre-wrap break-all ${logToneClass(line.level)}`}
							>{line.at} {line.level} {line.line}</li
						>
					{/each}
					{#each liveLogs as entry (entry.at + entry.line)}
						<li class={`whitespace-pre-wrap break-all ${logToneClass(entry.level)}`}
							>{entry.line}</li
						>
					{/each}
				</ul>
			</Scroll>
		{/if}
	</Stack>
</Stack>
