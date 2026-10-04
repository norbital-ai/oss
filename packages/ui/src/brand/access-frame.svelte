<!--
	`AccessFrame`: the one access look — Bolt's sign-in and invitation, and a host's workspace picker. The
	Norbius band behind, the Norbital mark and environment badge, the language and theme switches and the "secure access"
	overline, then the page's own column (its card is the caller's). Every string is the caller's, in its own locale.
-->
<svelte:options runes />

<script lang="ts">
	import type { Snippet } from 'svelte';
	import logo from '../../assets/logo.svg';
	import { Badge } from '../primitives/badge/index.js';
	import { Bound, Center, Frame, Imposter, Inline, Stack } from '../layout/index.js';
	import NorbiusField from './norbius-field.svelte';

	let {
		environment,
		home,
		language,
		onLanguage,
		dark,
		onTheme,
		labels,
		wide = false,
		children
	}: {
		/** The deploy environment: nothing in production, `development` reads `local`, anything else as itself. */
		environment?: string | null | undefined;
		/** Where the mark links, if anywhere. */
		home?: string | undefined;
		/** The next language's own name; the switch cycles to it. */
		language: string;
		onLanguage: () => void;
		dark: boolean;
		onTheme: () => void;
		labels: { switchLanguage: string; lightMode: string; darkMode: string; secureAccess: string };
		wide?: boolean;
		children: Snippet;
	} = $props();

	const badge = $derived.by(() => {
		const e = environment?.trim() ?? '';
		return e === '' || e === 'production' ? null : e === 'development' ? 'local' : e;
	});
</script>

<Bound clip size="full" class="access-frame relative min-h-svh bg-background text-foreground">
	<div class="access-backdrop"><NorbiusField /></div>

	<Center measure={wide ? 'full' : 'narrow'} layout="stack" justify="center"
		class={['access-content relative z-20 min-h-svh px-[max(1.25rem,env(safe-area-inset-left))] pt-[calc(max(1.5rem,env(safe-area-inset-top))+3.5rem)] pb-[max(1.5rem,env(safe-area-inset-bottom))] pe-[max(1.25rem,env(safe-area-inset-right))] sm:px-8',
			wide ? 'max-w-3xl' : 'max-w-lg']}>
		<Imposter placement="top" class="access-header px-[max(1.25rem,env(safe-area-inset-left))] pt-[max(1.5rem,env(safe-area-inset-top))] sm:px-8">
			<Inline as="header" justify="between" gap="md">
				<Inline as={home === undefined ? 'div' : 'a'} href={home} gap="sm" align="center" class="w-fit rounded-sm focus-visible:ring-2 focus-visible:ring-ring">
					<Frame as="span" ratio="square" class="size-8 rounded-sm border border-border bg-card shadow-xs">
						<img src={logo} alt="" aria-hidden="true" class="size-full" />
					</Frame>
					<span class="text-sm font-semibold tracking-tight">Norbital</span>
					{#if badge !== null}
						<Badge variant={badge === 'staging' ? 'warning' : 'outline'} data-testid="environment-badge">{badge}</Badge>
					{/if}
				</Inline>
				<Inline gap="xs" align="center">
					<button type="button" onclick={onLanguage} aria-label={labels.switchLanguage}
						class="min-h-11 rounded-sm px-2 py-1 text-tiny font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
						{language}
					</button>
					<button type="button" onclick={onTheme} aria-label={dark ? labels.lightMode : labels.darkMode}
						class="size-11 rounded-md text-sm transition-colors hover:bg-accent hover:text-accent-foreground">
						{dark ? '☀' : '☾'}
					</button>
					<p class="text-overline hidden sm:block">{labels.secureAccess}</p>
				</Inline>
			</Inline>
		</Imposter>
		<Stack as="main" gap="none" fill>
			{@render children()}
		</Stack>
	</Center>
</Bound>

<style>
	/* Short landscape viewports need the same scrollable access layout as phones. */
	@media (max-width: 639px), (max-height: 500px) and (pointer: coarse) {
		.access-backdrop { display: none; }
		:global(.access-frame .access-content) {
			justify-content: flex-start;
			min-height: 100dvh;
			padding-top: calc(max(1rem, env(safe-area-inset-top)) + 5rem);
			padding-left: max(1.25rem, env(safe-area-inset-left));
			padding-right: max(1.25rem, env(safe-area-inset-right));
			padding-bottom: max(1.5rem, env(safe-area-inset-bottom));
		}
		:global(.access-frame .access-header) {
			padding-left: max(1.25rem, env(safe-area-inset-left));
			padding-right: max(1.25rem, env(safe-area-inset-right));
			padding-top: max(1rem, env(safe-area-inset-top));
		}
		:global(.access-frame .access-panel) {
			border: 0; border-radius: 0; background: transparent;
			padding: 0; box-shadow: none; backdrop-filter: none;
		}
		:global(.access-frame input) { font-size: 1rem; min-height: 2.75rem; }
		:global(.access-frame button) { min-height: 2.75rem; }
	}
	@media (orientation: landscape) and (max-height: 500px) and (pointer: coarse) {
		:global(.access-frame .access-content) {
			max-width: 56rem;
			padding-top: calc(env(safe-area-inset-top) + 3.5rem);
			padding-bottom: max(0.75rem, env(safe-area-inset-bottom));
		}
		:global(.access-frame .access-header) { padding-top: env(safe-area-inset-top); }
		:global(.access-frame .access-header .text-overline) { display: none; }
	}
	@media (orientation: landscape) and (max-height: 300px) and (min-width: 640px) and (pointer: coarse) {
		:global(.access-frame:focus-within .access-header),
		:global(.access-frame:focus-within .access-panel > header),
		:global(.access-frame:focus-within .access-panel > [data-layout="inline"]) { display: none; }
		:global(.access-frame:focus-within .access-content) { padding-top: max(0.75rem, env(safe-area-inset-top)); }
		:global(.access-frame:focus-within .access-panel) { display: flex; }
	}
</style>
