<!-- The same build, preview and publication history in Studio and the operator's tenant view. -->
<script lang="ts" module>
	import type { ReleaseBuild, ReleaseChange, ReleaseEnvironment, ReleaseVersion } from './model.js';

	export type ReleaseTimelineProps = {
		builds: readonly ReleaseBuild[];
		releases: readonly ReleaseVersion[];
		environments?: readonly ReleaseEnvironment[] | undefined;
		changes?: readonly ReleaseChange[] | undefined;
		selected?: string | null | undefined;
		onSelect?: ((commit: string) => void) | undefined;
		onBuild?: ((commit: string) => void) | undefined;
		onRestore?: ((commit: string) => void) | undefined;
		busy?: boolean;
		t?: ((key: string) => string) | undefined;
		class?: string | undefined;
	};
</script>

<script lang="ts">
	import Button from '../primitives/button/button.svelte';
	import Icon from '../primitives/icon/icon-wrapper.svelte';
	import { cn } from '../primitives/utils.js';
	import { rollbackReason, timelineEntries } from './model.js';

	let {
		builds,
		releases,
		environments = [],
		changes = [],
		selected = null,
		onSelect,
		onBuild,
		onRestore,
		busy = false,
		t = (key) => key,
		class: className
	}: ReleaseTimelineProps = $props();
	const entries = $derived(timelineEntries(builds, releases, changes));
	const when = (at: string) => new Date(at).toLocaleString();
</script>

<div class={cn('grid min-w-0 gap-3 text-xs', className)} data-release-timeline>
	{#if environments.length > 0}
		<div class="flex flex-wrap gap-1.5" aria-label={t('Environment releases')}>
			{#each environments as environment (environment.name)}
				<span
					class="inline-flex min-w-0 items-center gap-1.5 rounded-md border border-border px-2 py-1 text-micro text-muted-foreground"
					title={environment.release || t('Unrouted')}
				>
					<Icon
						name={environment.name === 'live' ? 'lucide:radio-tower' : 'lucide:flask-conical'}
						class="size-3"
					/>
					<span class="font-medium text-foreground">{environment.name}</span>
					<span>{t(environment.release === '' ? 'Unrouted' : 'Serving')}</span>
				</span>
			{/each}
		</div>
	{/if}
	<ol
		class="relative grid min-w-0 before:absolute before:inset-y-3 before:left-1.5 before:w-px before:bg-border"
		aria-label={t('Build and release timeline')}
	>
		{#each entries as entry (entry.commit)}
			{@const current = entry.publications.find((release) => release.current)}
			{@const version = current ?? entry.publications[0]}
			{@const reason = version === undefined ? null : rollbackReason(version)}
			<li class="relative min-w-0 pl-5" data-commit={entry.commit}>
				<span
					aria-hidden="true"
					class={cn(
						'absolute top-4 left-0.5 size-2 rounded-full ring-2 ring-background',
						entry.build?.status === 'failed'
							? 'bg-destructive'
							: current
								? 'bg-foreground'
								: 'bg-muted-foreground/50'
					)}
				></span>
				<div
					class={cn(
						'grid min-w-0 gap-2 rounded-md px-2 py-3',
						selected === entry.commit && 'bg-muted/60'
					)}
				>
					<div class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
						<button
							type="button"
							class="min-w-0 flex-1 text-left font-medium text-foreground hover:underline disabled:cursor-default disabled:no-underline"
							disabled={busy ||
								onSelect === undefined ||
								(entry.build === null && entry.publications.length === 0)}
							aria-current={selected === entry.commit ? 'true' : undefined}
							onclick={() => onSelect?.(entry.commit)}
							title={entry.commit}
						>
							{entry.message}
						</button>
						{#if current}<span
								class="rounded bg-foreground px-1.5 py-0.5 text-micro text-background"
								>{t('Live')}</span
							>
						{/if}
						{#if entry.build && (!current || entry.build.status === 'failed')}<span
								class={cn(
									'rounded bg-muted px-1.5 py-0.5 text-micro',
									entry.build.status === 'failed' ? 'text-destructive' : 'text-muted-foreground'
								)}>{t(entry.build.status === 'failed' ? 'Failed' : 'Built')}</span
							>{/if}
					</div>
					<div class="flex flex-wrap gap-x-2 gap-y-1 text-micro text-muted-foreground">
						<code title={entry.commit}>{entry.commit.slice(0, 12)}</code>
						{#if entry.at}<time datetime={entry.at}>{when(entry.at)}</time>{/if}
						{#if entry.build}<span
								>{entry.build.lines}
								{t('log lines')} · {entry.build.diagnostics}
								{t('diagnostics')}</span
							>{/if}
					</div>
					{#each entry.changes as change (change.id)}
						<p class="text-micro text-muted-foreground">
							<span class="font-medium text-foreground">{change.title}</span> · {t(
								change.state === 'open'
									? 'Open change'
									: change.state === 'merged'
										? 'Merged change'
										: 'Closed change'
							)}{#if change.state === 'open' && change.preview === null}
								· {t('No preview built')}{/if}
						</p>
					{/each}
					{#each entry.previews as change (change.id)}
						<p class="flex min-w-0 flex-wrap items-center gap-1.5 text-micro text-muted-foreground">
							<Icon name="lucide:flask-conical" class="size-3" />
							<span
								>{t(
									change.state !== 'open'
										? 'Past preview'
										: change.preview?.shelved
											? 'Preview shelved'
											: change.preview?.stale
												? 'Earlier preview build'
												: 'Active preview'
								)} · {change.title}</span
							>
							{#if change.preview?.artifact}<code title={change.preview.artifact}
									>{change.preview.artifact.slice(0, 12)}</code
								>{/if}
							{#if change.preview?.url}<a
									href={change.preview.url}
									class="underline underline-offset-4">{t('Open preview')}</a
								>{/if}
						</p>
					{/each}
					{#if entry.publications.length > 1}
						<details class="text-micro text-muted-foreground">
							<summary class="w-fit cursor-pointer"
								>{entry.publications.length} {t('publications')}</summary
							>
							<ul class="mt-1 grid gap-1">
								{#each entry.publications as publication, index (`${publication.at}:${index}`)}<li>
										{when(publication.at)} · {t(
											publication.current
												? 'Serving now'
												: publication.undo
													? 'Before a rollback'
													: publication.rollback
														? 'Rolled back'
														: 'Published'
										)}
									</li>{/each}
							</ul>
						</details>
					{/if}
					{#if version !== undefined && !version.current}
						<p class="text-micro text-muted-foreground">
							{reason === null
								? `${t('Rollback available')} · ${t(version.discards === undefined ? 'Current data retained' : 'Checkpoint data restored')}${version.discards ? ` · ${when(version.discards)}` : ''}`
								: t(reason)}
						</p>
					{/if}
					{#if (entry.build !== null && onBuild !== undefined) || (version !== undefined && onRestore !== undefined)}
						<div class="flex flex-wrap gap-1">
							{#if entry.build !== null && onBuild !== undefined}<Button
									size="sm"
									variant="ghost"
									class="h-7 px-2 text-micro"
									disabled={busy}
									onclick={() => onBuild?.(entry.commit)}
									><Icon name="lucide:scroll-text" class="size-3" />{t('Build log')}</Button
								>{/if}
							{#if version !== undefined && onRestore !== undefined}<Button
									size="sm"
									variant="outline"
									class="h-7 px-2 text-micro"
									disabled={busy || reason !== null}
									disabledMessage={reason === null ? undefined : t(reason)}
									onclick={() => onRestore?.(version.commit)}
									><Icon
										name={version.undo ? 'lucide:undo-2' : 'lucide:history'}
										class="size-3"
									/>{t(version.undo ? 'Undo rollback' : 'Roll back')}</Button
								>{/if}
						</div>
					{/if}
				</div>
			</li>
		{:else}<li class="py-4 text-meta">{t('No recorded builds or releases.')}</li>{/each}
	</ol>
</div>
