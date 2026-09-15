<script lang="ts">
	import { Stack } from '@norbital-ai/ui/layout';
	import SignIn from './sign-in.svelte';
	import type { IdentityLocale, SignInTransport } from './i18n.js';

	/**
	 * The whole sign-in card: which workspace this is, then the email and code steps.
	 *
	 * A host places it where its routing says an unauthenticated person lands and supplies the
	 * transport that mints its cookie; the card, its copy and its steps are the workspace's own.
	 * `eyebrow` and the change-workspace link are the host's words, because only a host that serves
	 * several workspaces has anything to say there.
	 */
	let {
		workspace,
		transport,
		locale = 'en',
		eyebrow,
		changeWorkspace,
		onAuthenticated
	}: {
		workspace: string;
		transport: SignInTransport;
		locale?: IdentityLocale;
		eyebrow?: string;
		changeWorkspace?: { readonly href: string; readonly label: string };
		/** Absent: the page reloads itself, and the host's session gate decides where that lands. */
		onAuthenticated?: () => void;
	} = $props();
</script>

<Stack gap="md">
	<div
		class="sign-in-card rounded-lg border border-border/80 bg-card/95 p-5 shadow-xs backdrop-blur-sm sm:p-7"
	>
		<Stack gap="sm">
			{#if workspace.length > 0}
				<Stack as="header" gap="xs" class="min-w-0">
					{#if eyebrow}<p class="text-overline">{eyebrow}</p>{/if}
					<p class="text-subhead break-words text-foreground">{workspace}</p>
				</Stack>
			{/if}
			<SignIn
				{locale}
				{transport}
				onAuthenticated={() => {
					if (onAuthenticated === undefined) {
						window.location.assign(`${window.location.pathname}${window.location.search}`);
					} else {
						onAuthenticated();
					}
				}}
			/>
		</Stack>
	</div>
	{#if changeWorkspace}
		<p class="text-center text-sm text-muted-foreground">
			<a href={changeWorkspace.href} class="underline underline-offset-4 hover:text-foreground">
				{changeWorkspace.label}
			</a>
		</p>
	{/if}
</Stack>

<style>
	/* The form's own section is flattened into this card: one border, one background. */
	.sign-in-card :global(section) {
		border: 0;
		border-radius: 0;
		background: none;
		padding: 0;
		box-shadow: none;
		backdrop-filter: none;
	}
</style>
