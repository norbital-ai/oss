<script lang="ts">
	import { cn } from '#lib/utils';
	import Icon from '@iconify/svelte';
	import { Inline, Stack } from '#lib/layout';
	import DocTocItem from './doc-toc-item.svelte';
	import DocTocItems from './doc-toc-items.svelte';
	import DocTocScrollArea from './doc-toc-scroll-area.svelte';
	import { getDocTocState } from './context.svelte';

	let {
		title = 'On this page',
		widthClass,
		class: className
	}: {
		title?: string;
		widthClass?: string;
		class?: string;
	} = $props();

	const toc = getDocTocState()();
	let scrollElement = $state<HTMLDivElement | null>(null);
</script>

{#if toc.items.length > 0}
	<!--
		The rail is the primary form of the table of contents and stays on screen wherever it
		fits: from `lg` up, paired with `DocTocPopover`'s `lg:hidden` so exactly one of the
		two is present at every width. It yields to the floating popover only below `lg`,
		where the sidebar's 18rem plus this rail would leave the article too narrow to read.

		`max-lg:hidden`, not `hidden … lg:flex`: `Stack` merges the incoming class *before*
		its own `flex`, so an unmodified `hidden` here always lost — the rail rendered beside
		the article on phones and squeezed it to a third of the screen. A `max-lg` variant is
		a different twMerge group, so it survives the merge and wins inside its media query.

		It narrows before it disappears: 268px is the comfortable width, 216px buys the
		article back 52px in the band where space is tight.

		`max-h`, never `h`: a sticky box is still bounded by its containing block, so a rail
		with a *fixed* viewport height has to ride up once the article runs out beneath it —
		at the foot of the page it sat at -29px and `overflow-hidden` ate the "On this page"
		heading behind the nav bar. Sized by its content instead, it stays pinned at `top-14`
		for the whole scroll unless the contents genuinely fill the viewport, and the inner
		scroll area still gets a definite height to scroll within from the cap.
	-->
	<Stack
		as="aside"
		gap="none"
		shrink={false}
		class={cn(
			'sticky top-14 z-20 max-h-[calc(100dvh-3.5rem)] min-w-0 self-start overflow-hidden pt-12 ps-4 pe-4 pb-2 max-lg:hidden',
			widthClass ?? 'w-[216px] xl:w-[268px]',
			className
		)}
	>
		<h3 class="text-overline">
			<Inline as="span" gap="xs">
				<Icon icon="lucide:text" class="size-3.5 shrink-0" aria-hidden="true" />
				{title}
			</Inline>
		</h3>
		<DocTocScrollArea bind:scrollElement>
			<DocTocItems>
				{#each toc.items as item (item.url)}
					<DocTocItem {item} {scrollElement} />
				{/each}
			</DocTocItems>
		</DocTocScrollArea>
	</Stack>
{/if}
