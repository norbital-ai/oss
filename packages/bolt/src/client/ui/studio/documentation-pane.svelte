<script lang="ts">
	import Icon from '@iconify/svelte';
	import { Button } from '@norbital-ai/ui/button';
	import { DocTocRoot } from '@norbital-ai/ui/doc-toc';
	import { useI18n } from '@norbital-ai/ui/i18n';
	import { Center, Inline, Scroll } from '@norbital-ai/ui/layout';
	import { ReadonlyMarkdown } from '@norbital-ai/ui/markdown-editor';
	import { watch } from 'runed';
	import { tick } from 'svelte';
	import {
		documentationNavigationFromHref,
		resolveWorkspaceDocumentationHref,
		type WorkspaceDocumentationPage
	} from './workspace-documentation.js';

	let {
		selectedPath,
		content,
		pages,
		sourceFiles,
		onselect,
		onopenSource
	}: {
		selectedPath: string;
		content: string;
		pages: readonly WorkspaceDocumentationPage[];
		sourceFiles: Readonly<Record<string, string>>;
		onselect?: (path: string) => void;
		onopenSource?: (path: string) => void;
	} = $props();
	const { t } = useI18n();

	let scrollElement = $state<HTMLDivElement | null>(null);
	let pendingHeading = $state('');

	function scrollToHeading(heading: string): void {
		if (heading === '') {
			scrollElement?.scrollTo({ top: 0 });
			return;
		}
		scrollElement
			?.querySelector<HTMLElement>(`#${CSS.escape(heading)}`)
			?.scrollIntoView({ block: 'start' });
	}

	watch(
		() => selectedPath,
		() => {
			const heading = pendingHeading;
			pendingHeading = '';
			void tick().then(() => scrollToHeading(heading));
		}
	);

	function handleLink(href: string, event: MouseEvent): void {
		const navigation = documentationNavigationFromHref(href);
		if (navigation === null) return;
		event.preventDefault();
		if (navigation.kind === 'source') {
			onopenSource?.(navigation.path);
			return;
		}
		pendingHeading = navigation.heading;
		if (navigation.path === selectedPath) {
			const heading = pendingHeading;
			pendingHeading = '';
			void tick().then(() => scrollToHeading(heading));
			return;
		}
		onselect?.(navigation.path);
	}
</script>

{#snippet documentToolbar()}
	<Inline as="header" gap="sm" justify="between" class="border-b border-border/60 pb-3">
		<Inline gap="xs" class="min-w-0 text-muted-foreground">
			<Icon icon="lucide:file-text" class="size-3.5 shrink-0" />
			<span class="truncate text-micro">{selectedPath}</span>
		</Inline>
		{#if onopenSource}
			<Button
				variant="ghost"
				size="sm"
				class="shrink-0 gap-2"
				onclick={() => onopenSource(selectedPath)}
			>
				<Icon icon="lucide:pencil" class="size-3.5" />
				{t('bolt.studio.editDocumentationSource')}
			</Button>
		{/if}
	</Inline>
{/snippet}

{#if selectedPath === ''}
	<Center
		measure="narrow"
		layout="stack"
		gap="sm"
		align="center"
		justify="center"
		class="h-full px-6 py-12 text-center"
	>
		<Icon icon="lucide:book-open" class="size-8 text-muted-foreground" />
		<h2 class="text-heading">{t('bolt.studio.noDocumentation')}</h2>
		<p class="text-meta">{t('bolt.studio.noDocumentationDescription')}</p>
	</Center>
{:else}
	<Scroll
		bind:ref={scrollElement}
		name={t('bolt.studio.documentation')}
		fade={false}
		class="scroll-smooth [container-type:size]"
		data-testid="studio-documentation-pane"
	>
		<DocTocRoot
			observerRoot={scrollElement}
			title={t('bolt.studio.onThisPage')}
			class="min-h-full"
			mainClass="mx-auto max-w-3xl px-5 pt-6 pb-[30cqh] sm:px-8 sm:pt-8"
			articleClass="min-w-0 pt-6"
			asideWidthClass="w-[200px] xl:w-[240px]"
			asideClass="!top-0 !max-h-[100cqh] pt-8"
			popoverClass="[&>div]:!h-[100cqh]"
			before={documentToolbar}
		>
			<ReadonlyMarkdown
				{content}
				scale="documentation"
				anchorHeadings
				allowHtml={false}
				externalLinksNewTab
				resolveHref={(href, kind) =>
					resolveWorkspaceDocumentationHref({
						currentPath: selectedPath,
						href,
						kind,
						files: sourceFiles,
						pages
					})}
				onlink={handleLink}
			/>
		</DocTocRoot>
	</Scroll>
{/if}
