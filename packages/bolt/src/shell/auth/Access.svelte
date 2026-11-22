<!--
	The access surfaces (sign-in, invitation): ui's `AccessFrame` — the one access look a host's workspace
	picker shares — around one card, with "Change workspace" below it. The workspace is the one the boot names,
	even to a signed-out caller.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import { AccessFrame } from '@norbital-ai/ui/brand';
	import { LOCALES, languageLabel } from '../i18n.ts';

	/**
	 * `apex`: the host's workspace picker, linked below the card as "Change workspace". `recovery`: on a failure, the
	 * host's recovery, linked there instead as "Open workspace recovery".
	 */
	let {
		t,
		environment,
		languages,
		locale,
		on_locale,
		dark,
		on_theme,
		apex,
		recovery,
		children
	}: {
		t: (key: string) => string;
		environment?: string | undefined;
		languages?: readonly string[] | undefined;
		locale: string;
		on_locale: (locale: string) => void;
		dark: boolean;
		on_theme: () => void;
		apex?: string | undefined;
		recovery?: string | undefined;
		children: Snippet;
	} = $props();

	const languageOptions = $derived(
		(languages ?? LOCALES).map((code) => ({ code, label: languageLabel(code) }))
	);
</script>

<AccessFrame
	{environment}
	languages={languageOptions}
	{locale}
	{on_locale}
	{dark}
	{on_theme}
	labels={{
		switchLanguage: t('Switch language'),
		lightMode: t('Switch to light mode'),
		darkMode: t('Switch to dark mode'),
		secureAccess: t('Secure access')
	}}
>
	{@render children()}
	{#snippet footer()}
		<p class="access-switch text-muted-foreground">
			{#if recovery}
				<a href={recovery} class="underline underline-offset-4 hover:text-foreground"
					>{t('Open workspace recovery')}</a
				>
			{:else if apex}
				<a href={apex} class="underline underline-offset-4 hover:text-foreground"
					>{t('Change workspace')}</a
				>
			{/if}
		</p>
	{/snippet}
</AccessFrame>
