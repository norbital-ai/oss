<!--
	One connection as one card: the provider's mark and name, ONE status line (Not connected → Pairing → Connected as … /
	Needs attention), and one set of actions, each drawn once. The card owns the lifecycle: Connect (makes the instance when
	there is none and, for a provider that pairs at once — a QR, a code, a sign-in — starts pairing in the same click),
	Try again after an error, Cancel while pairing, Disconnect once connected (asked in-app: it logs the provider out and
	deletes the credentials while retaining the durable account). While pairing the setup opens beneath the card (the QR or code
	with its expiry and a fresh one on request, the sign-in, a form's own Connect); once connected Manage opens the details
	(Test, Import start, Reconnect). Settings presents configuration and messages alongside the same card, without another overlay.
-->
<script lang="ts">
	import { Effect } from 'effect';
	import type { ComponentProps } from 'svelte';
	import { fork } from '@norbital-ai/ui/effect';
	import { Button, confirm_action, Icon } from '@norbital-ai/ui';
	import { Stack } from '@norbital-ai/ui/layout';
	import type { Json } from '../decl/values.ts';
	import type { ImportStartInput, InstanceState, InstanceStatus, ProviderChoice } from '@norbital-ai/host-api';
	import IntegrationSetup from './IntegrationSetup.svelte';
	import Setup from '../shell/integration/Setup.svelte';
	import ImportStart from '../shell/integration/ImportStart.svelte';
	import { importStartDraft, importStartLabel, validImportStart } from '../shell/integration/import-start.ts';
	import type { IntegrationClient } from './integrations.ts';
	import {
		driverLabel,
		pairsAtOnce,
		releaseSignIn,
		reserveSignIn,
		sayOf,
		statusLabel,
		type IntegrationSetupProps,
		type IntegrationSetupEntry
	} from '../shell/integration/setup.ts';

	let {
		driver,
		description,
		providers,
		instance,
		client,
		create,
		t,
		locale,
		setup,
		on_state_change
	}: {
		driver: string;
		/** The definition's own description, shown when the provider has none. */
		description: string;
		/** What this host offers for it, in its order of preference. */
		providers: readonly ProviderChoice[];
		/** The instance this connector stands for, with its row's durable `status`; `null` before the first Connect. */
		instance: {
			readonly id: string;
			readonly status: Json | null;
			readonly active?: boolean;
		} | null;
		client: (instance: string) => IntegrationClient;
		/** Makes the instance and answers its id. */
		create: () => Effect.Effect<string, { readonly message: string }>;
		t: (key: string) => string;
		locale: string;
		setup?: IntegrationSetupEntry | undefined;
		on_state_change?: ComponentProps<typeof IntegrationSetup>['on_state_change'];
	} = $props();

	const say = $derived(sayOf(t, locale));
	const offered = $derived(providers.filter((p) => p.available !== false));
	/** The one-click way in, in the definition's order (Google before Microsoft); unavailable here, the card says so. */
	const shown = $derived(providers.find(pairsAtOnce) ?? providers[0]);
	const primary = $derived(shown?.available === false ? undefined : shown);
	const nameOf = (provider: ProviderChoice | undefined) =>
		provider?.name === undefined ? driverLabel(driver) : say(provider.name);
	/** Several providers and none that starts at once: no one of them speaks for the card until a person picks. */
	const undecided = $derived(offered.length > 1 && !providers.some(pairsAtOnce));
	const pickedIn = (status: InstanceStatus | null) =>
		status?.providers?.find((provider) => provider.id === status.provider);
	const headingOf = (status: InstanceStatus | null) =>
		pickedIn(status) ?? (undecided ? undefined : shown);
	let made = $state<string | null>(null);
	const id = $derived(instance?.id ?? made);
	const setupClient = $derived(id === null ? null : client(id));
	let open = $state(false);
	let busy = $state(false);
	let error = $state<string | null>(null);
	let pairedNow = $state(false);
	let boundary = $state<ImportStartInput | undefined>(undefined);
	let savedBoundary: string | undefined;
	const stateChanged = (
		state: InstanceState | undefined,
		previous: InstanceState | undefined,
		status: InstanceStatus | null
	) => {
		const latest = JSON.stringify(status?.import_start ?? null);
		if (savedBoundary !== undefined && latest !== savedBoundary) boundary = undefined;
		savedBoundary = latest;
		if (state !== 'connected') pairedNow = false;
		else if (previous !== undefined && previous !== 'connected' && previous !== 'reconnecting') {
			pairedNow = true;
			boundary = undefined;
			open = false;
		}
		if (state === 'pairing' || state === 'connecting') open = true;
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
	/** The instance (made now when absent); with `pairing`, the primary provider's pairing starts too. */
	function connect(pairing: boolean, import_start?: ImportStartInput): void {
		if (busy) return;
		pairedNow = false;
		const p = primary;
		const starts = pairing && pairsAtOnce(p);
		if (starts && p?.setup.kind === 'oauth') reserveSignIn();
		fork(
			settle(
				Effect.gen(function* () {
					const target = id ?? (yield* create());
					made = target;
					open = true;
					if (starts && p !== undefined)
						yield* client(target).pair({
							...(providers.length > 1 ? { provider: p.id } : {}),
							...(p.import_start !== undefined && import_start !== undefined ? { import_start } : {})
						});
				})
			)
		);
	}
	/** Unpairs the provider; deleting the durable account is a separate explicit action. */
	function disconnect(connected: boolean, source: IntegrationSetupProps | null): void {
		const target = id;
		if (target === null || busy) return;
		const ask = connected
			? confirm_action({
					title: t('Disconnect {name}?').replace('{name}', nameOf(headingOf(source?.status ?? null))),
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
									// through the card's own holder, so its status shows Not paired from the unpair answer
									yield* source === null ? client(target).unpair() : source.unpair();
									pairedNow = false;
									boundary = undefined;
									open = false;
								})
							)
						: Effect.void
				)
			)
		);
	}
</script>

{#snippet card(source: IntegrationSetupProps | null)}
	{@const status = source?.status ?? null}
	{@const connected = status?.state === 'connected'}
	{@const waiting =
		status?.state === 'pairing' ||
		status?.state === 'connecting' ||
		status?.state === 'reconnecting'}
	{@const working = busy || source?.busy === true}
	{@const failure =
		error ?? source?.error ?? (status?.state === 'error' ? (status.error ?? null) : null)}
	{@const active = pickedIn(status) ?? primary}
	{@const heading = headingOf(status)}
	{@const draft =
		primary === undefined
			? undefined
			: (boundary ?? importStartDraft(status?.import_start, primary, id === null))}
	{@const paused = instance !== null && instance.id === id && instance.active === false}
	<section
		class="flex min-w-0 flex-col gap-3 rounded-lg border bg-card px-4 py-3"
		data-connector={driver}
	>
		<div class="flex items-center justify-between gap-3">
			<div class="flex min-w-0 items-center gap-3">
				<span class="grid size-9 shrink-0 place-items-center rounded-md border bg-background">
					<Icon name={heading?.icon ?? 'lucide:plug'} class="size-5" />
				</span>
				<Stack gap="none" class="min-w-0">
					<p class="truncate text-sm font-medium">
						{nameOf(heading)}
					</p>
					<p class="truncate text-meta">
						{heading?.description === undefined ? description : say(heading.description)}
					</p>
					<p
						class="text-meta"
						data-connector-state={paused
							? 'paused'
							: id === null
								? 'none'
								: (status?.state ?? 'loading')}
						data-connection-success={pairedNow && connected ? '' : undefined}
						role="status"
					>
						{#if pairedNow && connected}<Icon
								name="lucide:circle-check"
								class="mr-1 inline size-3.5"
							/>{/if}
						{paused
							? t('Paused')
							: primary === undefined
								? t('Not available on this host')
								: id === null
									? t('Not connected')
									: statusLabel(status, t)}
					</p>
					{#if connected && status !== null && active?.import_start !== undefined}
						<p class="text-meta wrap-anywhere" data-import-start-active>
							{t('Import start')}: {importStartLabel(status.import_start, t, locale)}
						</p>
						{#if status.import_start?.kind === 'since' && status.import_start.origin === 'now' && active.import_start.kind === 'timestamp' && active.import_start.precision === 'second'}
							<p class="text-meta" data-import-start-precision>
								{t(
									'This source timestamps messages to the second; the whole starting second is included.'
								)}
							</p>
						{/if}
					{/if}
				</Stack>
			</div>
			<div class="flex shrink-0 items-center gap-1">
				{#if connected && source !== null}
					<Button
						variant="ghost"
						aria-expanded={open}
						onclick={() => (open = !open)}
						data-manage>{open ? t('Hide') : t('Manage')}</Button
					>
				{/if}
				{#if !connected && !waiting && !open && (id === null || status !== null)}
					<Button
						disabled={working ||
							primary === undefined ||
							(draft !== undefined && primary !== undefined && !validImportStart(draft, primary))}
						onclick={() => connect(true, boundary ?? (id === null ? draft : undefined))}
						data-connect
						>{working
							? t('Connecting…')
							: status?.state === 'error' || failure !== null
								? t('Try again')
								: t('Connect')}</Button
					>
				{/if}
				{#if id !== null && status !== null}
					<Button
						variant="ghost"
						class="text-destructive"
						disabled={working}
						onclick={() => disconnect(connected, source)}
						data-disconnect={connected ? '' : undefined}
						data-cancel-setup={!connected ? '' : undefined}
						>{t(connected ? 'Disconnect' : waiting ? 'Cancel pairing' : 'Cancel setup')}</Button
					>
				{/if}
			</div>
		</div>
		{#if failure !== null && !open}<p role="alert" class="text-sm text-destructive">
				{failure}
			</p>{/if}
		{#if !connected && !waiting && !open && (id === null || status !== null) && pairsAtOnce(primary) && primary?.import_start !== undefined && draft !== undefined}
			<ImportStart
				provider={primary}
				value={draft}
				on_change={(value) => (boundary = value)}
				busy={working}
				{t}
				{locale}
			/>
		{/if}
		{#if !connected && !waiting && !open && !undecided && offered.some((p) => p !== primary)}
			<button
				type="button"
				class="self-start text-meta underline-offset-2 hover:underline"
				disabled={working}
				onclick={() => connect(false)}>{t('Other ways to connect')}</button
			>
		{/if}
		{#if open && source !== null}
			<div class="border-t pt-3">
				<Setup {...source} {setup} error={error ?? source.error} controls={false} />
			</div>
		{/if}
	</section>
{/snippet}

{#if setupClient === null}
	{@render card(null)}
{:else}
	<IntegrationSetup client={setupClient} on_state_change={stateChanged} {t} {locale}>
		{#snippet children(source)}{@render card(source)}{/snippet}
	</IntegrationSetup>
{/if}
