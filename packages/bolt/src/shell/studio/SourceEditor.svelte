<!--
	Studio's editor pane (staging's source-editor): the open file's path as a breadcrumb over a flush CodeEditor, or an
	empty state. With the baseline shown, the target's baseline (Before) sits beside the edited file (After); the two stack
	on a narrow screen.
-->
<script lang="ts">
	import { Button, CodeEditor, Icon } from '@norbital-ai/ui';
	import { Columns, Inline, Scroll, Stack } from '@norbital-ai/ui/layout';
	import { languageOf } from '../studio.ts';

	let { path, value, baseline, diff, deleted, fileCount, against, onChange, onDiff, onDelete, t }: {
		path: string; value: string; baseline: string | undefined; diff: boolean; deleted: boolean; fileCount: number; against: string;
		onChange: (value: string) => void; onDiff: () => void; onDelete: () => void; t: (key: string) => string;
	} = $props();
	const segments = $derived(path.split('/').filter(Boolean));
	const EDITOR = 'h-full min-h-0 w-full rounded-none border-0 shadow-none';
</script>

{#if path === ''}
	<Stack gap="sm" align="center" justify="center" fill class="text-muted-foreground">
		<Icon name="lucide:file-code-2" class="size-8 opacity-30" />
		<p class="text-xs">{t(fileCount === 0 ? 'No source files' : 'Open a file to edit it.')}</p>
	</Stack>
{:else}
	<div class="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)]">
		<Inline gap="xs" class="min-w-0 border-b border-border/60 bg-muted/20 pr-2">
			<Scroll axis="x" name={t('File path')} grow class="min-w-0">
				<ol class="flex h-7 flex-nowrap items-center gap-1.5 px-3 font-mono text-xs text-muted-foreground">
					{#each segments as segment, i (`${i}:${segment}`)}
						{#if i === segments.length - 1}
							<li class="shrink-0 font-medium text-foreground {deleted ? 'line-through' : ''}" title={path} aria-current="page">{segment}</li>
						{:else}
							<li class="shrink-0">{segment}</li>
							<li aria-hidden="true" class="shrink-0 text-muted-foreground/70"><Icon name="lucide:chevron-right" class="size-3" /></li>
						{/if}
					{/each}
				</ol>
			</Scroll>
			<span class="hidden shrink-0 text-micro text-muted-foreground sm:inline">{against}</span>
			{#if baseline !== undefined}
				<Button size="sm" variant="ghost" class="h-6 px-2 text-micro" aria-pressed={diff} onclick={onDiff}>
					<Icon name="lucide:git-compare" class="size-3.5" />{t('Baseline')}
				</Button>
			{/if}
			<Button size="sm" variant="ghost" class="h-6 px-2 text-micro hover:text-destructive" disabled={deleted} onclick={onDelete}>
				<Icon name="lucide:trash-2" class="size-3.5" />{t('Delete file')}
			</Button>
		</Inline>
		{#if diff && baseline !== undefined}
			<Columns count={2} gap="none" collapse="narrow" class="h-full min-h-0">
				<Stack gap="none" class="min-h-0 min-w-0">
					<span class="px-3 pt-3 text-micro font-medium text-foreground">{t('Before')}</span>
					{#key path}<CodeEditor aria-label={`${path} (baseline)`} value={baseline} language={languageOf(path)} readonly minHeight="100%" class={EDITOR} />{/key}
				</Stack>
				<Stack gap="none" class="min-h-0 min-w-0 border-t border-border/60 @min-[40rem]:border-t-0 @min-[40rem]:border-l">
					<span class="px-3 pt-3 text-micro font-medium text-foreground">{t('After')}</span>
					{#key path}<CodeEditor aria-label={path} {value} language={languageOf(path)} readonly={deleted} minHeight="100%" class={EDITOR} {onChange} />{/key}
				</Stack>
			</Columns>
		{:else}
			{#key path}<CodeEditor aria-label={path} {value} language={languageOf(path)} readonly={deleted} minHeight="100%" class={EDITOR} {onChange} />{/key}
		{/if}
	</div>
{/if}
