<!--
	Live's main pane (staging's live-pane): the selected recorded commit — its id, message, when, whether it serves now and
	its restore point — with Restore (an administrator's, to a commit with a restore point), over the runtime log and
	Operations (the environments the host routes, live first).
-->
<script lang="ts">
	import { Button, Icon, Tabs } from '@norbital-ai/ui';
	import { Cluster, Inline, Scroll, Stack } from '@norbital-ai/ui/layout';
	import RuntimeLog from './RuntimeLog.svelte';
	import { routedEnvironment, type StudioRelease, type StudioView } from '../studio.ts';
	import type { ShellApi } from '../runtime.ts';

	let { api, view, release, admin, busy, sub, onsub, onrestore, t }: {
		api: ShellApi; view: StudioView; release: StudioRelease | undefined; admin: boolean; busy: boolean;
		sub: 'runtime' | 'operations'; onsub: (sub: 'runtime' | 'operations') => void; onrestore: (commit: string) => void; t: (key: string) => string;
	} = $props();
	const routed = $derived(routedEnvironment(view.environments));
	const PANE = 'min-h-0 flex-1 gap-0 [&>div:first-child]:px-4 sm:[&>div:first-child]:px-6';
</script>

{#snippet runtime()}
	{#if admin}
		<RuntimeLog {api} {t} />
	{:else}
		<Stack gap="sm" align="center" justify="center" fill class="px-6 text-center text-muted-foreground">
			<Icon name="lucide:lock" class="size-8 opacity-30" />
			<p class="text-xs">{t('The runtime log is an administrator’s.')}</p>
		</Stack>
	{/if}
{/snippet}

{#snippet operations()}
	<Scroll name={t('Operations')} class="h-full">
		<Stack gap="md" class="p-4 sm:p-6">
			<h3 class="text-overline">{t('Environments')}</h3>
			{#if routed === undefined}
				<p class="text-meta">{t('No environment is routed.')}</p>
			{:else}
				<Stack as="ul" gap="none" divided class="border-y border-border/50">
					{#each [routed, ...(view.environments ?? []).filter((e) => e.name !== routed.name)] as e (e.name)}
						<Cluster as="li" gap="sm" justify="between" class="py-3">
							<Inline gap="sm" class="min-w-0">
								<Icon name={e.name === 'live' ? 'lucide:radio-tower' : 'lucide:flask-conical'} class="size-4 shrink-0 text-muted-foreground" />
								<Stack gap="xs" class="min-w-0">
									<strong class="text-xs font-medium text-foreground">{e.name}</strong>
									{#if e.release === ''}<span class="text-micro text-muted-foreground">{t('unrouted')}</span>
									{:else}<code class="truncate font-mono text-micro text-muted-foreground">{e.release}</code>{/if}
								</Stack>
							</Inline>
							{#if e.url !== null && e.release !== ''}
								<Button size="sm" variant="outline" class="h-7 px-2 text-micro" href={e.url}><Icon name="lucide:external-link" class="size-3" />{t('Open')}</Button>
							{/if}
						</Cluster>
					{/each}
				</Stack>
			{/if}
		</Stack>
	</Scroll>
{/snippet}

<Stack gap="none" fill class="min-h-0">
	{#if release !== undefined}
		<Cluster align="start" gap="sm" shrink={false} class="border-b border-border/60 px-4 py-3 sm:px-6">
			<Stack gap="xs" grow class="min-w-0">
				<Cluster gap="xs">
					<h2 class="truncate font-mono text-sm font-semibold text-foreground">{release.commit.slice(0, 12)}</h2>
					{#if release.current}<span class="rounded-full border border-border/70 bg-muted px-2 py-0.5 text-micro">{t('Serving now')}</span>{/if}
				</Cluster>
				<p class="truncate text-xs text-foreground">{release.message}</p>
				<p class="text-micro text-muted-foreground">
					<time datetime={release.at}>{new Date(release.at).toLocaleString()}</time>
					{#if release.checkpoint} · {t('checkpoint')} <time datetime={release.checkpoint}>{new Date(release.checkpoint).toLocaleString()}</time>{/if}
				</p>
			</Stack>
			{#if admin}
				<Button size="sm" variant="outline" disabled={busy || release.current || release.checkpoint === null}
					disabledMessage={t(release.current ? 'This commit is already live.' : 'This commit has no restore point.')} onclick={() => onrestore(release.commit)}>
					<Icon name="lucide:history" class="size-3.5" />{t('Restore')}
				</Button>
			{/if}
		</Cluster>
	{/if}
	<Tabs value={sub} onValueChange={(v) => onsub(v === 'operations' ? 'operations' : 'runtime')} class={PANE}
		tabs={[{ name: 'runtime', title: t('Runtime log'), body: runtime }, { name: 'operations', title: t('Operations'), body: operations }]} />
</Stack>
