<script lang="ts">
	import Icon from '@iconify/svelte';
	import { Button } from '@norbital-ai/ui/button';
	import { useI18n } from '@norbital-ai/ui/i18n';
	import { Bound, Cover, Inline, INSET_X_CLASS, Stack } from '@norbital-ai/ui/layout';
	import * as Sheet from '@norbital-ai/ui/sheet';
	import DocumentationPane from './documentation-pane.svelte';
	import DocumentationTree from './documentation-tree.svelte';
	import {
		selectedWorkspaceDocumentationPath,
		workspaceDocumentationPages
	} from './workspace-documentation.js';

	let { sourceFiles }: { sourceFiles: Readonly<Record<string, string>> } = $props();
	const i18n = useI18n();
	const { t } = i18n;
	let selectedPath = $state('');
	let navigatorSheetOpen = $state(false);
	const pages = $derived(workspaceDocumentationPages(sourceFiles, i18n.locale));
	const documentationPath = $derived(selectedWorkspaceDocumentationPath(pages, selectedPath));
	const content = $derived(documentationPath === '' ? '' : (sourceFiles[documentationPath] ?? ''));
</script>

{#snippet navigator()}
	<DocumentationTree
		{pages}
		{sourceFiles}
		selectedPath={documentationPath}
		onselect={(path) => {
			selectedPath = path;
			navigatorSheetOpen = false;
		}}
	/>
{/snippet}

<Cover class="relative bg-background" gap="none">
	{#snippet top()}
		<Inline
			as="header"
			gap="md"
			align="end"
			justify="between"
			shrink={false}
			class="bg-background px-4 pt-4 sm:px-6 sm:pt-6"
		>
			<Stack gap="xs">
				<h1 class="text-heading">{t('bolt.shell.documentation')}</h1>
				<p class="hidden max-w-2xl text-meta sm:block">{t('bolt.documentation.description')}</p>
			</Stack>
			<Button
				variant="ghost"
				size="sm"
				class="shrink-0 gap-2 md:hidden"
				onclick={() => (navigatorSheetOpen = true)}
			>
				<Icon icon="lucide:panel-bottom" class="size-4" />
				{t('bolt.documentation.browse')}
			</Button>
		</Inline>
	{/snippet}

	<Inline align="stretch" gap="none" fill class="min-w-0 pt-4 sm:pt-6 {INSET_X_CLASS}">
		<aside
			class="hidden w-72 shrink-0 border-r border-border/60 bg-card font-sans md:block"
			aria-label={t('bolt.studio.documentationNavigator')}
		>
			<Stack gap="none" fill>{@render navigator()}</Stack>
		</aside>

		<Bound size="full" grow clip class="relative min-w-0 bg-background font-sans">
			<DocumentationPane
				selectedPath={documentationPath}
				{content}
				{pages}
				{sourceFiles}
				onselect={(path) => (selectedPath = path)}
			/>
		</Bound>
	</Inline>
</Cover>

<Sheet.Root bind:open={navigatorSheetOpen}>
	{#if navigatorSheetOpen}
		<Sheet.Content flush>
			<Sheet.Header class="shrink-0 border-b border-border px-4 py-3 pr-12">
				<Sheet.Title>{t('bolt.shell.documentation')}</Sheet.Title>
				<Sheet.Description>{t('bolt.documentation.description')}</Sheet.Description>
			</Sheet.Header>
			<Stack gap="none" grow class="min-h-0 bg-card">{@render navigator()}</Stack>
		</Sheet.Content>
	{/if}
</Sheet.Root>
