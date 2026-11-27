<!--
@component
	`AccessCard`: the one access card inside `AccessFrame` — Bolt's sign-in, invitation and failure, and a host's
	workspace picker, sign-up, switch, paywall and error pages. An overline and the workspace it names, the title and an
	optional line under it, then the caller's field and one full-width primary action (with at most one text link under
	it), then a hairline and one hint. Every string is the caller's, in its own locale.
@example
<AccessCard eyebrow="Signing in to" name="Acme" title="Sign in" hint="We'll email you a six-digit code.">
	<Input … /><Button class="w-full">Send sign-in code</Button>
</AccessCard>
-->
<svelte:options runes />

<script lang="ts">
	import type { Snippet } from 'svelte';
	import { Stack } from '../layout/index.js';

	let {
		eyebrow,
		name,
		title,
		description,
		hint,
		wide = false,
		children
	}: {
		/** The overline: what is happening to the workspace ("Signing in to", "Switching to"). */
		eyebrow?: string | undefined;
		/** The workspace's name, under the overline. */
		name?: string | undefined;
		/** The page's one heading. */
		title: string;
		/** One line under the title, such as where a code went. */
		description?: string | undefined;
		/** One line under a hairline: what happens next. */
		hint?: Snippet | string | undefined;
		/** The full measure of a wide `AccessFrame` (a template picker); otherwise the narrow card. Default false. */
		wide?: boolean;
		/** The field, the primary action and its one secondary link. */
		children: Snippet;
	} = $props();
</script>

<Stack gap="sm" class="access-card" data-access-wide={wide}>
	{#if eyebrow || name}
		<Stack as="header" gap="xs" class="access-identity min-w-0">
			{#if eyebrow}<p class="text-overline">{eyebrow}</p>{/if}
			{#if name}<p class="text-base font-medium break-words text-foreground">{name}</p>{/if}
		</Stack>
	{/if}
	<Stack as="section" gap="md" class="access-card-content">
		<Stack as="header" gap="xs">
			<h1 class="text-heading text-balance">{title}</h1>
			{#if description}
				<p
					class="access-card-description max-w-[52ch] text-sm leading-relaxed text-muted-foreground"
				>
					{description}
				</p>
			{/if}
		</Stack>
		<Stack gap="sm">{@render children()}</Stack>
		{#if hint}
			<p class="access-card-hint border-t border-border pt-4 text-sm text-muted-foreground">
				{#if typeof hint === 'string'}{hint}{:else}{@render hint()}{/if}
			</p>
		{/if}
	</Stack>
</Stack>
