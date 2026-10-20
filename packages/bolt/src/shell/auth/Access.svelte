<!--
	The access surfaces (sign-in, invitation): ui's `AccessFrame` — the one access look a host's workspace
	picker shares — around one card, with "Change workspace" below it. The workspace is the one the boot names,
	even to a signed-out caller.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import { AccessFrame } from '@norbital-ai/ui/brand';
	import { LANGUAGE, LOCALES } from '../i18n.ts';

	/** `apex`: the host's workspace picker, linked below the card as "Change workspace". */
	let {
		t,
		environment,
		locale,
		onLocale,
		dark,
		onTheme,
		apex,
		children
	}: {
		t: (key: string) => string;
		environment?: string | undefined;
		locale: string;
		onLocale: (locale: string) => void;
		dark: boolean;
		onTheme: () => void;
		apex?: string | undefined;
		children: Snippet;
	} = $props();

	const base = $derived(LOCALES.find((l) => locale.startsWith(l)) ?? 'en');
	const nextLocale = $derived(LOCALES[(LOCALES.indexOf(base) + 1) % LOCALES.length]!);
</script>

<AccessFrame
	{environment}
	language={LANGUAGE[nextLocale]}
	onLanguage={() => onLocale(nextLocale)}
	{dark}
	{onTheme}
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
			{#if apex}
				<a href={apex} class="underline underline-offset-4 hover:text-foreground"
					>{t('Change workspace')}</a
				>
			{/if}
		</p>
	{/snippet}
</AccessFrame>
