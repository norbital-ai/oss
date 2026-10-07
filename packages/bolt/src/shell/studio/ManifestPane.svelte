<!--
	The target's manifest (staging's manifest-pane): a chip per section, then the section's heading and count and its
	declarations as a divided list — each opens its source file, and an app also opens itself.
-->
<script lang="ts">
	import { Button, Icon, Tabs } from '@norbital-ai/ui';
	import { based } from '../nav.ts';
	import { Cluster, Inline, Scroll, Stack } from '@norbital-ai/ui/layout';
	import { SECTIONS, type Section, type StudioView } from '../studio.ts';

	let { view, onopen, t }: { view: StudioView; onopen: (path: string) => void; t: (key: string) => string } = $props();
	const SECTION_TITLES: { readonly [s in Section]: string } = { collections: 'Collections', pipelines: 'Pipelines', apps: 'Apps', kiosks: 'Kiosks', policies: 'Policies',
		channelTypes: 'Channel types', automations: 'Automations', remotes: 'Remotes', environment: 'Environment' };
	const ICONS: { readonly [s in Section]: string } = { collections: 'lucide:database', pipelines: 'lucide:workflow', apps: 'lucide:layout-grid', kiosks: 'lucide:monitor',
		policies: 'lucide:shield-check', channelTypes: 'lucide:radio', automations: 'lucide:zap', remotes: 'lucide:plug', environment: 'lucide:key-round' };
	let section = $state<string>('collections');
</script>

{#snippet empty(icon: string, text: string)}
	<Stack gap="sm" align="center" justify="center" class="py-12 text-center text-muted-foreground">
		<Icon name={icon} class="size-8 opacity-30" />
		<p class="text-xs">{text}</p>
	</Stack>
{/snippet}

{#snippet body()}
	{@const s = section as Section}
	{@const entries = view.sections?.[s] ?? []}
	<Scroll name={t(SECTION_TITLES[s])} class="h-full">
		<Stack gap="md" class="py-4">
			<Inline gap="sm" align="start">
				<Icon name={ICONS[s]} class="mt-0.5 size-4 shrink-0 text-muted-foreground" />
				<h2 class="text-sm font-medium text-foreground">{t(SECTION_TITLES[s])} ({entries.length})</h2>
			</Inline>
			{#if entries.length === 0}
				{@render empty(ICONS[s], t('None declared.'))}
			{:else}
				<Stack as="ul" gap="none" divided class="border-y border-border/50">
					{#each entries as e (`${e.name} ${e.path}`)}
						<Cluster as="li" gap="sm" align="start" justify="between" class="py-3">
							<Inline gap="sm" align="start" grow class="min-w-0">
								<Icon name={ICONS[s]} class="mt-0.5 size-4 shrink-0 text-muted-foreground" />
								<Stack gap="xs" class="min-w-0">
									<h3 class="truncate text-xs font-medium text-foreground {s === 'apps' ? '' : 'font-mono'}">{e.name}</h3>
									<p class="truncate font-mono text-micro text-muted-foreground">{e.path}</p>
								</Stack>
							</Inline>
							<Cluster gap="sm" justify="end" shrink={false}>
								{#if e.href !== undefined}
									<Button size="sm" variant="outline" class="h-7 px-2 text-micro" href={based(e.href)}><Icon name="lucide:external-link" class="size-3" />{t('Open')}</Button>
								{/if}
								<button type="button" class="shrink-0 text-micro text-primary hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none" title={e.path} onclick={() => onopen(e.path)}>
									<Inline as="span" gap="xs"><Icon name="lucide:arrow-right-circle" class="size-3" />{t('Source')}</Inline>
								</button>
							</Cluster>
						</Cluster>
					{/each}
				</Stack>
			{/if}
		</Stack>
	</Scroll>
{/snippet}

{#if view.stale === true}
	{@render empty('lucide:clock', t('The manifest is older than the source. Preview to rebuild it.'))}
{:else if view.sections === null}
	{@render empty('lucide:package', t('The workbench has not built yet.'))}
{:else}
	<Tabs bind:value={section} orientation="horizontal" class="px-4 pt-3 sm:px-6" tabs={SECTIONS.map((s) => ({ name: s, title: t(SECTION_TITLES[s]), body }))} />
{/if}
