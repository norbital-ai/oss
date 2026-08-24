<!-- exported package header rendered by authored workspace applications -->
<script lang="ts" module>
	import type { Snippet } from 'svelte';
	import type { HTMLAttributes } from 'svelte/elements';

	export interface PageHeaderProps extends Omit<HTMLAttributes<HTMLElement>, 'children'> {
		/** Omit when the shell `AppMediaHeader` already shows app identity. */
		title?: string;
		description?: string;
		eyebrow?: string;
		actions?: Snippet;
	}
</script>

<script lang="ts">
	import { Cluster, INSET_X_CLASS, Split, Stack } from '#lib/layout';
	import { cn } from '#lib/utils';

	let {
		title,
		description,
		eyebrow,
		actions,
		class: className,
		...restProps
	}: PageHeaderProps = $props();

	const hasHeading = $derived(Boolean(title || description || eyebrow));
</script>

{#snippet heading()}
	<Stack gap="xs">
		{#if eyebrow}
			<p class="text-overline">
				{eyebrow}
			</p>
		{/if}
		{#if title}
			<h1 class="text-heading text-balance">{title}</h1>
		{/if}
		{#if description}
			<p class="max-w-[72ch] text-sm leading-relaxed text-muted-foreground">{description}</p>
		{/if}
	</Stack>
{/snippet}

{#snippet controls()}
	<Cluster justify="end">{@render actions?.()}</Cluster>
{/snippet}

<header
	class={cn(className, INSET_X_CLASS, 'border-b border-border py-4')}
	data-page-header
	{...restProps}
>
	{#if actions && hasHeading}
		<Split ratio="wide" collapse="stack" gap="md" start={heading} end={controls} />
	{:else if actions}
		{@render controls()}
	{:else if hasHeading}
		{@render heading()}
	{/if}
</header>
