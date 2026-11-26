<!--
	@component One connection as a plugin-style card driven by the shared connection FSM:
	icon + title + status badge (Not yet installed → Not connected → Connecting/Pairing → Connected / Disconnected / Error)
	+ concise description + a single primary CTA whose label and action follow the current state, plus a Manage/Settings
	action for installed records. Pairing and management open cleanly in a Sheet (or inline inside Settings detail tabs)
	so raw provider forms never spill onto the main card grid.
-->
<script lang="ts">
	import { Effect } from 'effect';
	import type { ComponentProps, Snippet } from 'svelte';
	import { fork } from '@norbital-ai/ui/effect';
	import { watch } from '@norbital-ai/ui/behaviors';
	import { Button, confirm_action, Icon, Sheet } from '@norbital-ai/ui';
	import { Cluster, Inline, Stack, Surface } from '@norbital-ai/ui/layout';
	import type { Json } from '../decl/values.ts';
	import type { InstanceState, InstanceStatus, ProviderChoice } from '@norbital-ai/host-api';
	import IntegrationSetup from './IntegrationSetup.svelte';
	import Setup from '../shell/integration/Setup.svelte';
	import { importStartLabel } from '../shell/integration/import-start.ts';
	import type { IntegrationClient } from './integrations.ts';
	import {
		decodeStoredStatus,
		resolveConnectionState,
		type ConnectionAction,
		type ConnectionTone
	} from './connection-fsm.ts';
	import { SHELL_ZH } from '../shell/i18n.ts';
	import {
		driverIcon,
		driverLabel,
		releaseSignIn,
		reserveSignIn,
		sayOf,
		type IntegrationSetupEntry,
		type IntegrationSetupProps
	} from '../shell/integration/setup.ts';

	let {
		driver,
		name,
		icon,
		description = '',
		providers = [],
		providers_ready = true,
		instance,
		client,
		create,
		on_delete,
		on_resume,
		on_manage,
		manage,
		meta,
		presentation = 'sheet',
		t: customT,
		locale = 'en',
		setup,
		on_state_change,
		readonly = false
	}: {
		/** The integration definition's driver: its brand name and icon are the card's defaults. */
		driver: string;
		/** Card title; defaults to the primary provider or driver brand name. */
		name?: string | undefined;
		/** Iconify icon name; defaults to the primary provider's or driver's icon. */
		icon?: string | undefined;
		/** Short description shown on the card when no provider description overrides it. */
		description?: string;
		/** What this host offers for this definition, in its order of preference. */
		providers?: readonly ProviderChoice[];
		/** Set `false` while `integration_offers()` is loading so cards never flash unavailable. */
		providers_ready?: boolean;
		/** Durable `sys_integration` row; `null` when not yet installed. */
		instance: {
			readonly id: string;
			readonly status: Json | null;
			readonly active?: boolean;
		} | null;
		/** The installed instance's client, by its id: setup, pairing and health go through it. */
		client: (instance: string) => IntegrationClient;
		/** Creates the `sys_integration` record and returns its id (`null` when delegated to an external sheet). */
		create?: (() => Effect.Effect<string | null, { readonly message: string }>) | undefined;
		/** Deletes the `sys_integration` record (`Uninstall`), returning the card to `Not yet installed`. */
		on_delete?: (() => Effect.Effect<void, { readonly message: string }>) | undefined;
		/** Resumes a paused instance (`active: true`). */
		on_resume?: (() => Effect.Effect<void, { readonly message: string }>) | undefined;
		/** Custom Manage handler (e.g. opening Settings' multi-tab management view). */
		on_manage?: (() => void) | undefined;
		/** Optional extra configuration UI rendered inside the Manage Sheet (`close` closes the card's Sheet cleanly). */
		manage?: Snippet<[{ close: () => void }]> | undefined;
		/** Optional metadata strip rendered inside the card body (e.g. envoy audience & policies). */
		meta?: Snippet | undefined;
		/** Where setup and management open: `'sheet'` (default) or `'inline'`. */
		presentation?: 'sheet' | 'inline';
		/** Translator for the card's own strings; defaults to Bolt's built-in strings in `locale`. */
		t?: ((key: string) => string) | undefined;
		/** The viewer's locale (`en` by default), read when no `t` is given. */
		locale?: string;
		/** The definition's own setup component and its props, shown in place of the built-in setup. */
		setup?: IntegrationSetupEntry | undefined;
		/** Called as the connection's state moves (see `IntegrationSetup`). */
		on_state_change?: ComponentProps<typeof IntegrationSetup>['on_state_change'];
		/** Disables mutating CTA actions for read-only viewers. */
		readonly?: boolean;
	} = $props();

	const t = $derived(
		customT ?? ((key: string) => (locale.toLowerCase().startsWith('zh') ? (SHELL_ZH[key] ?? key) : key))
	);

	const BADGE_CLASS: { readonly [tone in ConnectionTone]: string } = {
		neutral: 'border-tone-neutral-border bg-tone-neutral-bg text-tone-neutral-text',
		info: 'border-tone-info-border bg-tone-info-bg text-tone-info-text',
		success: 'border-tone-success-border bg-tone-success-bg text-tone-success-text',
		warning: 'border-tone-warning-border bg-tone-warning-bg text-tone-warning-text',
		destructive: 'border-tone-destructive-border bg-tone-destructive-bg text-tone-destructive-text'
	};
	const DOT_CLASS: { readonly [tone in ConnectionTone]: string } = {
		neutral: 'bg-muted-foreground/60',
		info: 'bg-info animate-pulse',
		success: 'bg-success',
		warning: 'bg-warning',
		destructive: 'bg-destructive'
	};

	const say = $derived(sayOf(t, locale));
	let made = $state<string | null>(null);
	// Clear optimistic local `made` id once the parent prop catches up or removes the row.
	watch(
		() => instance?.id ?? null,
		(currentId, previousId) => {
			if (currentId !== null && currentId === made) made = null;
			else if (currentId === null && previousId !== null && previousId === made) made = null;
		}
	);
	const id = $derived(instance?.id ?? made);
	const setupClient = $derived(id === null ? null : client(id));
	const storedStatus = $derived(decodeStoredStatus(instance?.status));

	let panel = $state<'pair' | 'manage' | null>(null);
	let busy = $state(false);
	let error = $state<string | null>(null);
	let pairedNow = $state(false);
	let disconnectedLocally = $state(false);

	watch(
		() => id,
		() => {
			error = null;
			pairedNow = false;
			disconnectedLocally = false;
			if (id === null) panel = null;
		}
	);

	const stateChanged = (
		state: InstanceState | undefined,
		previous: InstanceState | undefined,
		status: InstanceStatus | null
	) => {
		if (state === 'connected') {
			disconnectedLocally = false;
			if (previous !== undefined && previous !== 'connected' && previous !== 'reconnecting') {
				pairedNow = true;
				if (panel === 'pair') panel = null;
			}
		} else {
			pairedNow = false;
			if (state === 'pairing' || state === 'connecting') disconnectedLocally = false;
		}
		on_state_change?.(state, previous, status);
	};

	const settle = <A,>(work: Effect.Effect<A, { readonly message: string }>) =>
		Effect.suspend(() => {
			busy = true;
			error = null;
			return work.pipe(
				Effect.catch((cause) =>
					Effect.sync(() => {
						releaseSignIn();
						error = cause.message;
					})
				),
				Effect.ensuring(
					Effect.sync(() => {
						busy = false;
					})
				)
			);
		});

	function install(): void {
		if (busy || create === undefined || readonly) return;
		fork(
			settle(
				create().pipe(
					Effect.tap((createdId) =>
						Effect.sync(() => {
							if (createdId !== null) {
								made = createdId;
								disconnectedLocally = false;
								panel = 'pair';
							}
						})
					)
				)
			)
		);
	}

	function startConnect(
		effectiveProviders: readonly ProviderChoice[],
		source: IntegrationSetupProps | null
	): void {
		const target = id;
		if (target === null || busy || readonly) return;
		error = null;
		pairedNow = false;
		disconnectedLocally = false;
		panel = 'pair';
		// Only auto-start one-click OAuth when there is a single OAuth provider with no import boundary to choose.
		const offered = effectiveProviders.filter((p) => p.available !== false);
		const sole = effectiveProviders.length === 1 ? offered[0] : undefined;
		if (sole !== undefined && sole.setup.kind === 'oauth' && sole.import_start === undefined) {
			reserveSignIn();
			fork(
				settle(
					source !== null
						? source.pair({})
						: client(target).pair({}).pipe(Effect.asVoid)
				)
			);
		}
	}

	function unpairConnection(
		connected: boolean,
		displayName: string,
		source: IntegrationSetupProps | null
	): void {
		const target = id;
		if (target === null || busy || readonly) return;
		const ask = connected
			? confirm_action({
					title: t('Disconnect {name}?').replace('{name}', displayName),
					body: t('This logs the account out and deletes its stored credentials.'),
					confirm_label: t('Disconnect'),
					cancel_label: t('Cancel'),
					destructive: true
				})
			: Effect.succeed(true);
		fork(
			ask.pipe(
				Effect.flatMap((confirmed) =>
					confirmed
						? settle(
								Effect.gen(function* () {
									yield* source === null
										? client(target).unpair().pipe(Effect.asVoid)
										: source.unpair();
									pairedNow = false;
									if (connected) disconnectedLocally = true;
									panel = null;
								})
							)
						: Effect.void
				)
			)
		);
	}

	function uninstallConnection(displayName: string): void {
		if (busy || on_delete === undefined || readonly) return;
		fork(
			confirm_action({
				title: t('Uninstall {name}?').replace('{name}', displayName),
				body: t('Its credentials, sync progress, conversations and messages are deleted with it.'),
				confirm_label: t('Uninstall'),
				cancel_label: t('Cancel'),
				destructive: true
			}).pipe(
				Effect.flatMap((confirmed) =>
					confirmed
						? settle(
								on_delete().pipe(
									Effect.tap(() =>
										Effect.sync(() => {
											made = null;
											panel = null;
											pairedNow = false;
											disconnectedLocally = false;
										})
									)
								)
							)
						: Effect.void
				)
			)
		);
	}

	function resumeConnection(): void {
		if (busy || on_resume === undefined || readonly) return;
		fork(settle(on_resume()));
	}

	function openManage(): void {
		if (on_manage !== undefined) {
			on_manage();
			return;
		}
		panel = panel === 'manage' ? null : 'manage';
	}

	function closePanel(): void {
		panel = null;
	}

	function runAction(
		action: ConnectionAction,
		displayName: string,
		effectiveProviders: readonly ProviderChoice[],
		source: IntegrationSetupProps | null
	): void {
		switch (action) {
			case 'install':
				install();
				break;
			case 'connect':
			case 'reconnect':
			case 'retry':
				startConnect(effectiveProviders, source);
				break;
			case 'continue':
				panel = 'pair';
				break;
			case 'cancel':
				unpairConnection(false, displayName, source);
				break;
			case 'disconnect':
				unpairConnection(true, displayName, source);
				break;
			case 'resume':
				resumeConnection();
				break;
			case 'manage':
				openManage();
				break;
		}
	}
</script>

{#snippet statusBadge(label: string, tone: ConnectionTone, phase: string)}
	<span
		class="inline-flex shrink-0 items-center gap-1.5 rounded-badge border px-2 py-0.5 text-xs font-medium {BADGE_CLASS[tone]}"
		data-connector-state={phase}
		role="status"
	>
		<span class="size-1.5 rounded-full {DOT_CLASS[tone]}" aria-hidden="true"></span>
		<span>{t(label)}</span>
	</span>
{/snippet}

{#snippet card(source: IntegrationSetupProps | null)}
	{@const rawStatus = source?.status ?? null}
	{@const status =
		rawStatus !== null && disconnectedLocally && rawStatus.state === 'unpaired' && rawStatus.code === undefined
			? { ...rawStatus, code: 'disconnected' }
			: rawStatus}
	{@const effectiveProviders =
		status?.providers !== undefined && status.providers.length > 0 ? status.providers : providers}
	{@const offered = effectiveProviders.filter((p) => p.available !== false)}
	{@const available =
		!providers_ready
			? true
			: effectiveProviders.length > 0
				? offered.length > 0
				: status !== null && status.providers !== undefined
					? status.providers.length > 0
					: true}
	{@const picked = status?.providers?.find((p) => p.id === status.provider)}
	{@const heading = picked ?? (effectiveProviders.length === 1 ? effectiveProviders[0] : undefined)}
	{@const displayName =
		name ?? (heading?.name !== undefined ? say(heading.name) : driverLabel(driver))}
	{@const displayIcon = icon ?? heading?.icon ?? driverIcon(driver)}
	{@const displayDescription =
		description !== ''
			? description
			: heading?.description !== undefined
				? say(heading.description)
				: ''}
	{@const working = busy || source?.busy === true}
	{@const effectiveStored =
		disconnectedLocally && (storedStatus === null || storedStatus.state === 'unpaired')
			? { ...(storedStatus ?? {}), state: 'unpaired' as const, code: 'disconnected' }
			: storedStatus}
	{@const snapshot = resolveConnectionState({
		installed: id !== null,
		active: instance !== null && instance.id === id ? (instance.active ?? true) : true,
		status,
		storedStatus: effectiveStored,
		busy: working,
		error: error ?? source?.error ?? null,
		available,
		setupOpen: panel !== null,
		canResume: on_resume !== undefined,
		readonly
	})}
	{@const activeProvider = picked ?? offered[0]}

	<Surface
		as="section"
		tone="card"
		padding="md"
		radius="overlay"
		class="flex min-w-0 flex-col justify-between gap-4 transition-colors hover:border-border-control"
		data-connector={driver}
		data-connector-phase={snapshot.phase}
	>
		<Stack gap="sm" class="min-w-0">
			<div class="flex items-start justify-between gap-3">
				<div class="flex min-w-0 items-center gap-3">
					<span class="grid size-9 shrink-0 place-items-center rounded-control border border-border bg-background">
						<Icon name={displayIcon} class="size-5" />
					</span>
					<div class="min-w-0">
						<p class="truncate text-sm font-medium text-foreground">{displayName}</p>
						{#if snapshot.phase === 'connected' && snapshot.account !== null && snapshot.account !== ''}
							<p class="truncate text-meta" data-connection-success={pairedNow ? '' : undefined}>
								{snapshot.account}
							</p>
						{:else if !available}
							<p class="truncate text-meta">{t('Not available on this host')}</p>
						{/if}
					</div>
				</div>
				{@render statusBadge(snapshot.label, snapshot.tone, snapshot.phase)}
			</div>

			{#if displayDescription !== ''}
				<p class="line-clamp-2 text-meta">{displayDescription}</p>
			{/if}

			{#if meta !== undefined}
				{@render meta()}
			{/if}

			{#if snapshot.phase === 'error' && snapshot.detail !== null && panel === null}
				<p role="alert" class="line-clamp-2 text-xs text-destructive" data-connector-error>
					{snapshot.detail}
				</p>
			{/if}

			{#if snapshot.phase === 'connected' && status !== null && activeProvider?.import_start !== undefined}
				<p class="text-meta wrap-anywhere" data-import-start-active>
					{t('Import start')}: {importStartLabel(status.import_start, t, locale)}
				</p>
			{/if}
		</Stack>

		<div class="flex items-center justify-between gap-2 border-t border-border/60 pt-3">
			<div class="flex min-w-0 items-center gap-1">
				{#if id !== null && (!readonly || on_manage !== undefined || manage !== undefined)}
					<Button
						variant="ghost"
						size="icon"
						hint={t('Manage')}
						aria-label={t('Manage')}
						aria-expanded={panel === 'manage'}
						data-manage
						onclick={openManage}
					>
						<Icon name="lucide:settings-2" class="size-4" />
					</Button>
				{/if}
			</div>
			<div class="flex shrink-0 items-center gap-2">
				{#if !readonly || snapshot.cta.action === 'manage' || snapshot.cta.action === 'continue'}
					<Button
						variant={snapshot.cta.variant}
						disabled={snapshot.cta.disabled || (snapshot.cta.action === 'install' && create === undefined)}
						data-connector-action={snapshot.cta.action}
						data-connect={snapshot.cta.action === 'connect' || snapshot.cta.action === 'reconnect' || snapshot.cta.action === 'retry' || snapshot.cta.action === 'install' ? '' : undefined}
						data-disconnect={snapshot.cta.action === 'disconnect' ? '' : undefined}
						data-cancel-setup={snapshot.cta.action === 'cancel' ? '' : undefined}
						onclick={() => runAction(snapshot.cta.action, displayName, effectiveProviders, source)}
					>
						{t(snapshot.cta.label)}
					</Button>
				{/if}
			</div>
		</div>

		{#if presentation === 'inline' && panel !== null && source !== null}
			<div class="border-t border-border pt-4" data-connector-panel={panel}>
				<Stack gap="md">
					<Setup {...source} {setup} error={error ?? source.error} controls={false} />
					{#if manage !== undefined}
						<div class="border-t border-border pt-4">
							{@render manage({ close: closePanel })}
						</div>
					{/if}
					{#if on_delete !== undefined && !readonly}
						<div class="flex justify-end border-t border-border pt-3">
							<Button
								variant="ghost"
								class="text-destructive"
								disabled={working}
								data-uninstall
								onclick={() => uninstallConnection(displayName)}
							>
								{t('Uninstall')}
							</Button>
						</div>
					{/if}
				</Stack>
			</div>
		{/if}
	</Surface>

	{#if presentation === 'sheet' && source !== null}
		<Sheet
			open={panel !== null}
			on_open_change={(open) => {
				if (!open) panel = null;
			}}
			title={displayName}
			memory={`integration-${driver}`}
		>
			{#snippet header()}
				<Inline gap="sm" align="center" class="min-w-0">
					<span class="grid size-7 shrink-0 place-items-center rounded-control border border-border bg-background">
						<Icon name={displayIcon} class="size-4" />
					</span>
					<h2 class="truncate text-heading">{displayName}</h2>
					{@render statusBadge(snapshot.label, snapshot.tone, snapshot.phase)}
				</Inline>
			{/snippet}

			{#if panel !== null}
				<Stack gap="lg" class="min-w-0" data-connector-panel={panel}>
					{#if snapshot.phase === 'connected' && snapshot.account !== null && snapshot.account !== ''}
						<p class="text-sm text-muted-foreground">
							{t('Connected as {as}').replace('{as}', snapshot.account)}
						</p>
					{/if}

					<Setup {...source} {setup} error={error ?? source.error} controls={false} />

					{#if manage !== undefined}
						<div class="border-t border-border pt-4">
							{@render manage({ close: closePanel })}
						</div>
					{/if}

					{#if !readonly && (snapshot.phase === 'connecting' || snapshot.phase === 'connected' || on_delete !== undefined)}
						<Cluster gap="sm" justify="between" align="center" class="border-t border-border pt-4">
							<div>
								{#if snapshot.phase === 'connecting'}
									<Button
										variant="outline"
										disabled={working}
										data-cancel-setup
										onclick={() => unpairConnection(false, displayName, source)}
									>
										{t('Cancel pairing')}
									</Button>
								{:else if snapshot.phase === 'connected'}
									<Button
										variant="ghost"
										class="text-destructive"
										disabled={working}
										data-disconnect
										onclick={() => unpairConnection(true, displayName, source)}
									>
										{t('Disconnect')}
									</Button>
								{/if}
							</div>
							{#if on_delete !== undefined}
								<Button
									variant="ghost"
									class="text-destructive"
									disabled={working}
									data-uninstall
									onclick={() => uninstallConnection(displayName)}
								>
									{t('Uninstall')}
								</Button>
							{/if}
						</Cluster>
					{/if}
				</Stack>
			{/if}
		</Sheet>
	{/if}
{/snippet}

{#if setupClient === null}
	{@render card(null)}
{:else}
	<IntegrationSetup client={setupClient} on_state_change={stateChanged} {t} {locale}>
		{#snippet children(source)}{@render card(source)}{/snippet}
	</IntegrationSetup>
{/if}
