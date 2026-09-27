<!--
	The workspace launcher at `/` (staging's overview): the workspace's name, then its applications as cards — the app's
	banner, else its icon on a brand gradient — with a group's apps under the group's own heading on a brand rule.
-->
<script lang="ts">
	import { Icon } from '@norbital-ai/ui';
	import { based } from './nav.ts';
	import { Center, Frame, Inline, Scroll, Stack } from '@norbital-ai/ui/layout';
	import type { NavItem, NavModel } from './model.ts';

	let { model, t, onNavigate }: { model: NavModel; t: (key: string) => string; onNavigate: (href: string) => void } = $props();

	const apps = $derived(model.sections.find((s) => s.key === 'applications')?.items ?? []);
	const standalone = $derived(apps.filter((a) => a.children === undefined));
	const grouped = $derived(apps.filter((a) => a.children !== undefined));
</script>

{#snippet card(app: NavItem)}
	<a href={based(app.href)} onclick={(e) => { e.preventDefault(); onNavigate(app.href); }}
		class="group w-68 max-w-[calc(100vw-3rem)] shrink-0 snap-start overflow-hidden rounded-xl border bg-card shadow-card outline-none transition-colors duration-150 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring">
		<Stack gap="none">
			<Frame ratio="banner" shrink={false} class="bg-linear-to-br from-muted via-background to-brand/10">
				{#if app.thumbnail}
					<img src={app.thumbnail} alt="" class="size-full object-cover" loading="lazy" />
				{:else}
					<Inline fill justify="center" align="center" aria-hidden="true"><Icon name={app.icon ?? 'lucide:layout-grid'} class="size-10 text-brand/45" /></Inline>
				{/if}
			</Frame>
			<Inline align="start" gap="sm" class="p-3">
				<Inline shrink={false} justify="center" align="center" class="size-8 rounded-md border border-input bg-background text-foreground shadow-xs">
					<Icon name={app.icon ?? 'lucide:file-text'} class="size-4" />
				</Inline>
				<Stack gap="xs" grow class="min-w-0">
					<p class="truncate text-xs font-semibold text-foreground">{app.label}</p>
					<p class="line-clamp-2 min-h-8 text-micro leading-4 text-muted-foreground">{app.description ?? ''}</p>
				</Stack>
			</Inline>
		</Stack>
	</a>
{/snippet}

<Scroll name={t('Workspace overview')} inset>
	<Center measure="wide">
		<Stack gap="xl" class="py-2 sm:py-4 lg:py-6">
			<Stack as="header" gap="xs">
				<h1 class="text-base font-semibold text-foreground">{model.workspace.name}</h1>
				<p class="text-meta">{t('Pick an application')}</p>
			</Stack>
			<Stack as="section" gap="sm">
				<h2 class="text-overline">{t('Applications')}</h2>
				{#if apps.length === 0}
					<Stack align="center" justify="center" gap="xs" class="rounded-lg border border-dashed p-8">
						<Icon name="lucide:layout-dashboard" class="size-8 text-muted-foreground" />
						<span class="text-meta">{t('No applications yet')}</span>
						<span class="max-w-72 pt-1 text-center text-micro text-muted-foreground">{t('Add an application to this workspace to see it here.')}</span>
					</Stack>
				{:else}
					{#if standalone.length > 0}
						<Scroll axis="x" name="overview-apps" layout="inline" gap="sm" class="-mx-1 snap-x snap-mandatory px-1 pb-2">
							{#each standalone as app (app.key)}{@render card(app)}{/each}
						</Scroll>
					{/if}
					{#each grouped as group (group.key)}
						<Stack as="section" gap="sm" class="border-l-2 border-brand/40 pl-3">
							<Inline gap="sm" align="center">
								<Inline shrink={false} justify="center" align="center" class="size-8 rounded-md border border-input bg-background text-foreground shadow-xs">
									<Icon name={group.icon ?? 'lucide:layout-grid'} class="size-4" />
								</Inline>
								<Stack gap="xs" class="min-w-0">
									<p class="truncate text-sm font-semibold text-foreground">{group.label}</p>
									{#if group.description}<p class="text-micro text-muted-foreground">{group.description}</p>{/if}
								</Stack>
							</Inline>
							<Scroll axis="x" name={`overview-group-${group.key}`} layout="inline" gap="sm" class="-mx-1 snap-x snap-mandatory px-1 pb-2">
								{#each group.children ?? [] as child (child.key)}{@render card(child)}{/each}
							</Scroll>
						</Stack>
					{/each}
				{/if}
			</Stack>
		</Stack>
	</Center>
</Scroll>
