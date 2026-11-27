<!--
	One integration instance's setup, end to end. A definition's own `+integration.svelte` draws it when the workspace has
	one; every other instance by what its host publishes: the provider and its state first, then Pair while it is not
	connected (or while the operator reconnects it), the Connected summary once it is. Unboxed: its host owns the surface.
	Inside a connector card (`controls` false) the card owns the name, the one status line and Disconnect, so neither is
	drawn here again.
-->
<script lang="ts">
	import { Effect } from 'effect';
	import type { Snippet } from 'svelte';
	import { watch } from '@norbital-ai/ui/behaviors';
	import { Icon, Spinner } from '@norbital-ai/ui';
	import { AccretionDisc } from '@norbital-ai/ui/brand';
	import { Inline, Stack } from '@norbital-ai/ui/layout';
	import type { Json } from '../../decl/values.ts';
	import Connected from './Connected.svelte';
	import Pair from './Pair.svelte';
	import {
		driverIcon,
		driverLabel,
		providerOf,
		sayOf,
		statusLabel,
		type IntegrationSetupEntry,
		type IntegrationSetupProps
	} from './setup.ts';

	let {
		instance,
		status,
		error,
		pair,
		import_start,
		unpair,
		test,
		busy,
		t,
		locale,
		setup,
		controls = true,
		on_footer
	}: IntegrationSetupProps & {
		/** The definition's own setup component, from the compiled registry. */
		setup?: IntegrationSetupEntry | undefined;
		controls?: boolean | undefined;
		/** When hosted inside a Sheet, receives pairing actions to pin in the Sheet's footer. */
		on_footer?: ((footer: Snippet | null) => void) | undefined;
	} = $props();

	const formatDetail = (detail: string): string => {
		const trimmed = detail.trim();
		return trimmed === '' ? '' : trimmed.replace(/^[a-z]/, (ch) => ch.toUpperCase());
	};

	// the component is a module, so the same chunk is fetched once however often this is re-derived
	const chunk = $derived(setup?.load() ?? null);
	// a reconnect is a connected instance catching its breath: it keeps its summary, not a setup form
	const connected = $derived(status?.state === 'connected' || status?.state === 'reconnecting');
	const connecting = $derived(status?.state === 'connecting' || status?.state === 'reconnecting');
	const say = $derived(sayOf(t, locale));
	const provider = $derived(providerOf(status));
	/** Reconnect: the setup again over a connected instance, until its pairing is sent or cancelled. */
	let again = $state(false);
	watch(
		() => instance,
		() => {
			again = false;
		}
	);
	const repair = (input?: Json) =>
		Effect.sync(() => {
			again = false;
		}).pipe(Effect.flatMap(() => pair(input)));
</script>

{#if chunk !== null}
	{#await chunk}
		<div role="status" aria-busy="true" class="flex items-center gap-2 text-sm text-muted-foreground">
			<Spinner class="size-4" /><span>{t('Loading…')}</span>
		</div>
	{:then module}
		{#if module.configuration_tab !== undefined}
			{@render standard()}
		{:else}
			<module.default
				{instance}
				{status}
				{error}
				{pair}
				{import_start}
				{unpair}
				{test}
				{busy}
				{t}
				{locale}
			/>
		{/if}
	{:catch cause}
		<p role="alert" class="text-sm text-destructive">
			{t('This integration’s setup could not be loaded:')}
			{cause instanceof Error ? cause.message : String(cause)}
		</p>
	{/await}
{:else}
	{@render standard()}
{/if}

{#snippet standard()}
	<Stack gap="md" class="min-h-0 flex-1">
		{#if controls}
			<Inline gap="md" data-connection-progress={connecting ? '' : undefined}>
				{#if connecting}
					<span class="relative shrink-0" aria-hidden="true">
						<AccretionDisc size={80} class="text-muted-foreground" />
						<span class="absolute inset-0 grid place-items-center">
							<Icon name={provider?.icon ?? driverIcon(status?.driver ?? '')} class="size-5" />
						</span>
					</span>
				{/if}
				<Stack
					gap="xs"
					role={connecting ? 'status' : undefined}
					aria-live={connecting ? 'polite' : undefined}
					aria-atomic={connecting ? 'true' : undefined}
				>
					{#if status !== null}<p class="text-sm font-medium">
							{provider === undefined ? driverLabel(status.driver) : say(provider.label)}
						</p>{/if}
					<p
						class="text-meta"
						aria-live={connecting ? undefined : 'polite'}
						data-connection-state={status?.state ?? 'loading'}
					>
						{statusLabel(status, t)}
					</p>
					{#if connecting && status?.detail !== undefined}<p class="text-meta wrap-anywhere">
							{formatDetail(status.detail)}
						</p>{/if}
				</Stack>
			</Inline>
		{:else if connecting && status?.state === 'connecting'}
			<div
				class="flex flex-1 flex-col items-center justify-center gap-4 py-12 text-center"
				data-connection-progress
			>
				<span class="relative shrink-0" aria-hidden="true">
					<AccretionDisc size={96} class="text-muted-foreground" />
					<span class="absolute inset-0 grid place-items-center">
						<Icon name={provider?.icon ?? driverIcon(status.driver)} class="size-6" />
					</span>
				</span>
				<Stack gap="xs" align="center" role="status" aria-live="polite" aria-atomic="true">
					<p class="text-sm font-medium text-foreground" data-connection-state={status.state}>
						{statusLabel(status, t)}
					</p>
					<p class="text-meta">
						{provider === undefined ? driverLabel(status.driver) : say(provider.name ?? provider.label)}
					</p>
					{#if status.detail !== undefined && status.detail.trim() !== ''}
						<p class="max-w-sm text-meta wrap-anywhere">{formatDetail(status.detail)}</p>
					{/if}
				</Stack>
			</div>
		{/if}
		{#if error !== null}<p role="alert" class="text-sm text-destructive" data-connection-error>
				{error}
			</p>{/if}
		{#if !connecting && status?.detail !== undefined && status.detail.trim() !== ''}<p
				class="text-meta"
				aria-live="polite"
			>
				{formatDetail(status.detail)}
			</p>{/if}
		{#if status?.state === 'error' && status.error !== undefined}<p
				role="alert"
				class="text-sm text-destructive"
			>
				{status.error}
			</p>{/if}
		{#if connected && !again}
			<Connected
				{status}
				{busy}
				{error}
				{unpair}
				{test}
				{import_start}
				reconnect={() => (again = true)}
				{t}
				{locale}
				{controls}
			/>
		{:else if !(status?.state === 'connecting' && !controls)}
			<Pair
				{status}
				{error}
				{busy}
				pair={repair}
				{unpair}
				cancel={again ? () => (again = false) : undefined}
				{t}
				{locale}
				{controls}
				{on_footer}
			/>
		{/if}
	</Stack>
{/snippet}
