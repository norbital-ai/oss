<!--
@component
	`AccessFrame`: the one access look — Bolt's sign-in and invitation, and a host's workspace picker. The
	Norbius band behind, the Norbital mark and environment badge, the language and theme switches and the "secure access"
	overline, then one content-sized card. Every string is the caller's, in its own locale.
-->
<svelte:options runes />

<script lang="ts">
	import type { Snippet } from 'svelte';
	import logo from '../../assets/logo.svg';
	import { create_menu } from '../behaviors/index.js';
	import Badge from '../primitives/badge/badge.svelte';
	import Icon from '../primitives/icon/icon-wrapper.svelte';
	import * as Popover from '../primitives/popover/index.js';
	import { cn } from '../primitives/utils.js';
	import { Bound, Center, Frame, Imposter, Inline, Stack } from '../layout/index.js';
	import NorbiusField from './norbius-field.svelte';
	import { accessHeight } from './access-height.js';

	let {
		environment,
		home,
		languages,
		locale,
		on_locale,
		dark,
		on_theme,
		labels,
		wide = false,
		children,
		footer
	}: {
		/** The deploy environment: nothing in production, `development` reads `local`, anything else as itself. */
		environment?: string | null | undefined;
		/** Where the mark links, if anywhere. */
		home?: string | undefined;
		/** Available languages (`code` + native `label`); the Globe switcher renders when more than one is offered. */
		languages: readonly { readonly code: string; readonly label: string }[];
		/** Currently active locale tag. */
		locale: string;
		/** A language was selected from the Globe menu; the caller switches to `code`. */
		on_locale: (code: string) => void;
		/** The current theme is dark: the theme switch offers light. */
		dark: boolean;
		/** The theme switch was pressed; the caller toggles `dark`. */
		on_theme: () => void;
		/** The chrome's accessible names and the overline, in the caller's locale. */
		labels: { switchLanguage: string; lightMode: string; darkMode: string; secureAccess: string };
		/** A full-measure card instead of the narrow one. Default false. */
		wide?: boolean;
		/** The card's content. */
		children: Snippet;
		/** Navigation below the card, such as changing workspace. */
		footer?: Snippet | undefined;
	} = $props();

	let langOpen = $state(false);
	const activeCode = $derived.by(() => {
		const norm = locale.toLowerCase();
		const exact = languages.find((item) => item.code.toLowerCase() === norm);
		if (exact !== undefined) return exact.code;
		const primary = norm.split('-')[0] ?? norm;
		return (
			languages.find((item) => item.code.toLowerCase() === primary)?.code ?? languages[0]?.code
		);
	});

	const langMenu = create_menu({
		open: () => langOpen,
		on_open_change: (next) => (langOpen = next),
		items: () =>
			languages.map((item) => ({
				id: item.code,
				label: item.label,
				role: 'menuitemradio' as const,
				checked: item.code === activeCode,
				on_select: () => {
					langOpen = false;
					on_locale(item.code);
				}
			}))
	});

	const badge = $derived.by(() => {
		const e = environment?.trim() ?? '';
		return e === '' || e === 'production' ? null : e === 'development' ? 'local' : e;
	});
</script>

<Bound clip size="fill" class="access-frame">
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
					{#if languages.length > 1}
						<Popover.Root bind:open={langOpen}>
							<Popover.Trigger>
								{#snippet child({ props })}
									<button
										{...props}
										type="button"
										aria-label={labels.switchLanguage}
										data-testid="access-language-trigger"
										class="grid size-11 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-accent data-[state=open]:text-foreground"
									>
										<Icon name="lucide:globe" class="size-4" />
									</button>
								{/snippet}
							</Popover.Trigger>
							<Popover.Content align="end" side_offset={6} class="w-44 p-1">
								<div {...langMenu.menu_attrs()} aria-label={labels.switchLanguage} class="flex flex-col gap-0.5">
									{#each languages as item (item.code)}
										{@const active = item.code === activeCode}
										{@const itemAttrs = langMenu.item_attrs(item.code)}
										<button
											type="button"
											{...itemAttrs}
											{@attach langMenu.item(item.code)}
											class={cn(
												'flex h-8 w-full items-center gap-2 rounded-sm px-2 text-left text-xs outline-hidden transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring',
												active && 'font-medium text-foreground'
											)}
										>
											<span class="min-w-0 flex-1 truncate">{item.label}</span>
											{#if active}
												<Icon name="lucide:check" class="size-3.5 shrink-0" />
											{/if}
										</button>
									{/each}
								</div>
							</Popover.Content>
						</Popover.Root>
					{/if}
					<button
						type="button"
						onclick={on_theme}
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
