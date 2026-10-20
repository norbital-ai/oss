<!--
	`AccessFrame`: the one access look — Bolt's sign-in and invitation, and a host's workspace picker. The
	Norbius band behind, the Norbital mark and environment badge, the language and theme switches and the "secure access"
	overline, then one content-sized card. Every string is the caller's, in its own locale.
-->
<svelte:options runes />

<script lang="ts">
	import type { Snippet } from 'svelte';
	import logo from '../../assets/logo.svg';
	import { Badge } from '../primitives/badge/index.js';
	import { Bound, Center, Frame, Imposter, Inline, Stack } from '../layout/index.js';
	import NorbiusField from './norbius-field.svelte';
	import { accessHeight } from './access-height.js';

	let {
		environment,
		home,
		language,
		onLanguage,
		dark,
		onTheme,
		labels,
		wide = false,
		children,
		footer
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
		/** Navigation below the card, such as changing workspace. */
		footer?: Snippet;
	} = $props();

	const badge = $derived.by(() => {
		const e = environment?.trim() ?? '';
		return e === '' || e === 'production' ? null : e === 'development' ? 'local' : e;
	});
</script>

<Bound clip size="full" class="access-frame">
	<div class="access-backdrop"><NorbiusField /></div>

	<Center
		measure={wide ? 'full' : 'narrow'}
		layout="stack"
		justify="center"
		class={['access-content', wide && 'access-content-wide']}
	>
		<Imposter placement="top" class="access-header">
			<Inline as="header" justify="between" gap="md" class="access-header-content">
				<Inline
					as={home === undefined ? 'div' : 'a'}
					href={home}
					gap="sm"
					align="center"
					class="access-brand w-fit rounded-sm focus-visible:ring-2 focus-visible:ring-ring"
				>
					<Frame as="span" ratio="square" class="access-mark shadow-xs">
						<img src={logo} alt="" aria-hidden="true" class="size-full" />
					</Frame>
					<span class="text-sm font-semibold tracking-tight">Norbital</span>
					{#if badge !== null}
						<Badge
							variant={badge === 'staging' ? 'warning' : 'outline'}
							data-testid="environment-badge">{badge}</Badge
						>
					{/if}
				</Inline>
				<Inline gap="xs" align="center">
					<button
						type="button"
						onclick={onLanguage}
						aria-label={labels.switchLanguage}
						class="min-h-11 rounded-sm px-2 py-1 text-tiny font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
					>
						{language}
					</button>
					<button
						type="button"
						onclick={onTheme}
						aria-label={dark ? labels.lightMode : labels.darkMode}
						class="size-11 rounded-md text-sm transition-colors hover:bg-accent hover:text-accent-foreground"
					>
						{dark ? '☀' : '☾'}
					</button>
					<p class="text-overline hidden sm:block">{labels.secureAccess}</p>
				</Inline>
			</Inline>
		</Imposter>
		<Stack as="main" gap="none" style={`--access-footer-space: ${footer ? '2.5rem' : '0px'}`}>
			<section class="access-panel">
				<div class="access-panel-body" {@attach accessHeight}>
					{@render children()}
				</div>
			</section>
			{@render footer?.()}
		</Stack>
	</Center>
</Bound>
