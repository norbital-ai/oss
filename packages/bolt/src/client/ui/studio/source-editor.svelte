<script lang="ts">
	import Icon from '@iconify/svelte';
	import * as Breadcrumb from '@norbital-ai/ui/breadcrumb';
	import { CodeEditor } from '@norbital-ai/ui/code-editor';
	import { Cover, SCROLL_AXIS_CLASSES, Stack } from '@norbital-ai/ui/layout';
	import { cn } from '@norbital-ai/ui/utils';
	import { editorLanguage } from '#lib/client/ui/studio/studio-state.js';

	/**
	 * The Editor view's right-hand pane: one source file from the personal workbench commit.
	 *
	 * Breadcrumbs sit on the file path; the editor fills the rest of the viewport. CodeMirror is
	 * browser-only, and so is everything here: this component ships in the tenant's compiled client
	 * bundle, which is fetched and mounted by a browser and never server-rendered. The `browser`
	 * guard this used to carry was SvelteKit's answer to a question that can no longer be asked.
	 */
	let {
		path = '',
		value = '',
		fileCount = 0,
		onValueChange
	}: {
		path?: string;
		value?: string;
		fileCount?: number;
		onValueChange?: (value: string) => void;
	} = $props();

	const pathSegments = $derived(path.split('/').filter(Boolean));
</script>

<Cover gap="none" data-testid="studio-source-editor">
	{#snippet top()}
		{#if pathSegments.length > 0}
			<!-- The strip scrolls sideways rather than wrapping: a deep path is one line the reader drags,
			     not a block that grows and pushes the editor down. `Breadcrumb.Root` owns its own element,
			     so it names the scrollport token rather than being a `Scroll`. -->
			<Breadcrumb.Root
				class={cn('shrink-0 border-b border-border/60 bg-muted/20', SCROLL_AXIS_CLASSES.x)}
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
		{/if}
	{/snippet}

	{#if path === ''}
		<Stack gap="sm" align="center" justify="center" fill class="text-muted-foreground">
			<Icon icon="lucide:file-code-2" class="size-8 opacity-30" />
			<p class="text-xs">
				Choose a file on the left. The host holds {fileCount} for this tenant.
			</p>
		</Stack>
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
