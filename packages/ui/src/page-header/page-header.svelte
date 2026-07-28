<!-- fallow-ignore-file unrendered-component -- exported package header rendered by authored workspace applications -->
<script lang="ts" module>
	import type { Snippet } from 'svelte';
	import type { HTMLAttributes } from 'svelte/elements';

	export interface PageHeaderProps extends Omit<HTMLAttributes<HTMLElement>, 'children'> {
		title: string;
		description?: string;
		eyebrow?: string;
		actions?: Snippet;
	}
</script>

<script lang="ts">
	import { Cluster, Split, Stack } from '#lib/layout';
	import { cn } from '#lib/utils';

	let {
		title,
		description,
		eyebrow,
		actions,
		class: className,
		...restProps
	}: PageHeaderProps = $props();
</script>

{#snippet heading()}
	<Stack gap="xs">
		{#if eyebrow}
			<p class="text-micro font-medium tracking-wide text-muted-foreground uppercase sm:text-tiny">
				{eyebrow}
			</p>
		{/if}
		<h1 class="text-heading text-balance">{title}</h1>
		{#if description}
			<p class="max-w-[72ch] text-sm leading-relaxed text-muted-foreground">{description}</p>
		{/if}
	</Stack>
{/snippet}

{#snippet controls()}
	<Cluster justify="end">{@render actions?.()}</Cluster>
{/snippet}

<header
	class={cn(className, 'border-b border-border px-4 py-4 sm:px-6')}
	data-page-header
	{...restProps}
>
	{#if actions}
		<Split ratio="wide" collapse="stack" gap="md" start={heading} end={controls} />
	{:else}
		{@render heading()}
	{/if}
</header>
