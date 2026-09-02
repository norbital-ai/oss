<script lang="ts">
	import Icon from '@iconify/svelte';
	import * as Breadcrumb from '@norbital-ai/ui/breadcrumb';
	import { CodeEditor } from '@norbital-ai/ui/code-editor';
	import { Cover, Grid, SCROLL_AXIS_CLASSES, Scroll, Stack } from '@norbital-ai/ui/layout';
	import { useI18n } from '@norbital-ai/ui/i18n';
	import {
		editorLanguage,
		type WorkbenchDiffBaselineKey
	} from '#lib/client/ui/studio/studio-state.js';

	let {
		path = '',
		value = '',
		fileCount = 0,
		baselineKey,
		before = null,
		dirty = false,
		onValueChange
	}: {
		path?: string;
		value?: string;
		fileCount?: number;
		baselineKey?: WorkbenchDiffBaselineKey | undefined;
		before?: string | null;
		dirty?: boolean;
		onValueChange?: (value: string) => void;
	} = $props();
	const { t } = useI18n();

	const pathSegments = $derived(path.split('/').filter(Boolean));
	const showDiff = $derived(dirty && path !== '');
</script>

<Cover gap="none" data-testid="studio-source-editor">
	{#snippet top()}
		{#if pathSegments.length > 0}
			<Stack gap="none" shrink={false} class="border-b border-border/60 bg-muted/20">
				<Breadcrumb.Root
					class={SCROLL_AXIS_CLASSES.x}
					data-testid="studio-file-breadcrumb"
				>
					<Breadcrumb.List class="h-7 flex-nowrap px-3 font-mono text-xs">
						{#each pathSegments as segment, index (`${index}:${segment}`)}
							<Breadcrumb.Item class="min-w-0 shrink-0 gap-1">
								{#if index === pathSegments.length - 1}
									<Breadcrumb.Page class="font-medium" title={path}>{segment}</Breadcrumb.Page>
								{:else}
									<span>{segment}</span>
									<Breadcrumb.Separator class="text-muted-foreground/70" />
								{/if}
							</Breadcrumb.Item>
						{/each}
					</Breadcrumb.List>
				</Breadcrumb.Root>
				{#if baselineKey !== undefined}
					<p class="px-3 pb-1.5 text-micro text-muted-foreground" data-testid="studio-editor-baseline">
						{t(baselineKey)}
					</p>
				{/if}
			</Stack>
		{/if}
	{/snippet}

	{#if path === ''}
		<Stack gap="sm" align="center" justify="center" fill class="text-muted-foreground">
			<Icon icon="lucide:file-code-2" class="size-8 opacity-30" />
			<p class="text-xs">
				{t(fileCount === 0 ? 'bolt.studio.noSourceFiles' : 'bolt.studio.chooseSource')}
			</p>
		</Stack>
	{:else if showDiff}
		<Grid
			minimum="compact"
			gap="none"
			class="h-full min-h-0 divide-y divide-border/60 md:grid-cols-2 md:divide-x md:divide-y-0"
		>
			<Scroll name={t('bolt.studio.before')} class="min-w-0 p-3">
				<Stack gap="xs">
					<span class="text-micro font-medium text-foreground">{t('bolt.studio.before')}</span>
					<pre
						class="whitespace-pre-wrap break-all font-mono text-micro text-muted-foreground">{before ??
							'∅'}</pre>
				</Stack>
			</Scroll>
			<Stack gap="none" class="min-h-0 min-w-0">
				<span class="px-3 pt-3 text-micro font-medium text-foreground">{t('bolt.studio.after')}</span>
				{#key path}
					<CodeEditor
						{value}
						language={editorLanguage(path)}
						ariaLabel={path}
						minHeight="100%"
						class="h-full w-full min-h-0 rounded-none border-0 shadow-none"
						{...onValueChange ? { onValueChange } : {}}
					/>
				{/key}
			</Stack>
		</Grid>
	{:else}
		{#key path}
			<CodeEditor
				{value}
				language={editorLanguage(path)}
				ariaLabel={path}
				minHeight="100%"
				class="h-full w-full min-h-0 rounded-none border-0 shadow-none"
				{...onValueChange ? { onValueChange } : {}}
			/>
		{/key}
	{/if}
</Cover>
