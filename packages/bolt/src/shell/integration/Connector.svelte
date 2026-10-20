<!--
	One connector as a row, the way a plugin list draws it: the provider's mark, its name and one line, where it stands,
	and one button. Connect makes the instance when there is none (`create`) and, for a provider that pairs at once (a QR,
	a code, a sign-in), starts pairing in the same click; the instance's setup then opens beneath the row. Disconnect
	unpairs and removes the instance (`remove`). Other ways to connect (another mailbox) open the setup's provider choice.
-->
<script lang="ts">
	import { Effect } from 'effect';
	import { fork } from '@norbital-ai/ui/effect';
	import { Button, Icon } from '@norbital-ai/ui';
	import { Stack } from '@norbital-ai/ui/layout';
	import type { Json } from '../../decl/values.ts';
	import type {
		ImportStartInput,
		InstanceState,
		InstanceStatus,
		ProviderChoice
	} from '../../protocol/instance-status.ts';
	import IntegrationSetup from '../../page/IntegrationSetup.svelte';
	import Setup from './Setup.svelte';
	import ImportStart from './ImportStart.svelte';
	import { importStartDraft, importStartLabel, validImportStart } from './import-start.ts';
	import type { IntegrationClient } from '../../page/integrations.ts';
	import {
		driverLabel,
		pairsAtOnce,
		releaseSignIn,
		reserveSignIn,
		sayOf,
		statusLabel,
		type IntegrationSetupProps
	} from './setup.ts';

	let {
		driver,
		description,
		providers,
		instance,
		client,
		create,
		remove,
		onManage,
		t,
		locale
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
		/** Removes the instance once it was unpaired. */
		remove: (instance: string) => Effect.Effect<void, { readonly message: string }>;
		/** Opens the full instance sheet when this connector is part of Settings. */
		onManage?: (instance: string) => void;
		t: (key: string) => string;
		locale: string;
	} = $props();

	const say = $derived(sayOf(t, locale));
	const offered = $derived(providers.filter((p) => p.available !== false));
	/** The one-click way in, in the definition's order (Google before Microsoft); unavailable here, the card says so. */
	const shown = $derived(providers.find(pairsAtOnce) ?? providers[0]);
	const primary = $derived(shown?.available === false ? undefined : shown);
	const name = $derived(shown?.name === undefined ? driverLabel(driver) : say(shown.name));
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
		const latest = JSON.stringify(status?.importStart ?? null);
		if (savedBoundary !== undefined && latest !== savedBoundary) boundary = undefined;
		savedBoundary = latest;
		if (state !== 'connected') pairedNow = false;
		else if (previous !== undefined && previous !== 'connected' && previous !== 'reconnecting') {
			pairedNow = true;
			boundary = undefined;
			open = false;
		}
		if (state === 'pairing' || state === 'connecting') open = true;
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
	function connect(pairing: boolean, waiting = false, importStart?: ImportStartInput): void {
		if (busy || waiting) return;
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
							...(p.importStart !== undefined && importStart !== undefined ? { importStart } : {})
						});
				})
			)
		);
	}
	function disconnect(connected: boolean): void {
		const target = id;
		if (target === null) return;
		if (connected && !confirm(t('Disconnect {name}?').replace('{name}', name))) return;
		fork(
			settle(
				Effect.gen(function* () {
					yield* client(target).unpair();
					yield* remove(target);
					made = null;
					pairedNow = false;
					boundary = undefined;
					open = false;
				})
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
	{@const failure = error ?? source?.error ?? null}
	{@const active =
		status?.providers?.find((provider) => provider.id === status.provider) ?? primary}
	{@const draft =
		primary === undefined
			? undefined
			: (boundary ?? importStartDraft(status?.importStart, primary, id === null))}
	<li class="flex flex-col gap-3 rounded-lg border bg-card px-4 py-3" data-connector={driver}>
		<div class="flex items-center justify-between gap-3">
			<div class="flex min-w-0 items-center gap-3">
				<span class="grid size-9 shrink-0 place-items-center rounded-md border bg-background">
					<Icon name={shown?.icon ?? 'lucide:plug'} class="size-5" />
				</span>
				<Stack gap="none" class="min-w-0">
					<p class="truncate text-sm font-medium">{name}</p>
					<p class="truncate text-meta">
						{shown?.description === undefined ? description : say(shown.description)}
					</p>
					{#if id !== null && status !== null && active?.importStart !== undefined}
						<p class="text-meta wrap-anywhere" data-import-start-active>
							{t('Import start')}: {importStartLabel(status.importStart, t, locale)}
						</p>
						{#if status.importStart?.kind === 'since' && status.importStart.origin === 'now' && active.importStart.kind === 'timestamp' && active.importStart.precision === 'second'}
							<p class="text-meta" data-import-start-precision>
								{t(
									'This source timestamps messages to the second; the whole starting second is included.'
								)}
							</p>
						{/if}
					{/if}
					<p
						class="text-meta"
						data-connector-state={instance?.active === false
							? 'paused'
							: (status?.state ?? 'loading')}
						data-connection-success={pairedNow && connected ? '' : undefined}
						role="status"
					>
						{#if pairedNow && connected}<Icon
								name="lucide:circle-check"
								class="mr-1 inline size-3.5"
							/>{/if}
						{instance?.active === false
							? t('Paused')
							: primary === undefined
								? t('Not available on this host')
								: pairedNow && connected
									? t('Connected')
									: instance === null && made === null
										? t('Not connected')
										: statusLabel(status, t)}
					</p>
				</Stack>
			</div>
			<div class="flex shrink-0 items-center gap-1">
				{#if id !== null && onManage !== undefined}
					<Button size="sm" variant="ghost" onclick={() => id !== null && onManage?.(id)}
						>{t('Manage')}</Button
					>
				{:else if connected}
					<Button size="sm" variant="ghost" onclick={() => (open = !open)}
						>{open ? t('Hide') : t('Manage')}</Button
					>
				{/if}
				{#if !connected && (!open || waiting || source === null)}
					<Button
						size="sm"
						disabled={working ||
							waiting ||
							primary === undefined ||
							(id !== null && status === null) ||
							(draft !== undefined && primary !== undefined && !validImportStart(draft, primary))}
						onclick={() => connect(true, waiting, boundary ?? (id === null ? draft : undefined))}
						data-connect
						>{working
							? t('Connecting…')
							: waiting
								? statusLabel(status, t)
								: status?.state === 'error' || failure !== null
									? t('Try again')
									: t('Connect')}</Button
					>
				{/if}
				{#if id !== null}
					<Button
						size="sm"
						variant="ghost"
						class="text-destructive"
						disabled={working}
						onclick={() => disconnect(connected)}
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
		{#if !connected && !waiting && !open && (id === null || status !== null) && pairsAtOnce(primary) && primary?.importStart !== undefined && draft !== undefined}
			<ImportStart
				provider={primary}
				value={draft}
				onChange={(value) => (boundary = value)}
				busy={working}
				{t}
				{locale}
			/>
		{/if}
		{#if !connected && !open && offered.some((p) => p !== primary)}
			<button
				type="button"
				class="self-start text-meta underline-offset-2 hover:underline"
				disabled={working || waiting}
				onclick={() => connect(false, waiting)}>{t('Other ways to connect')}</button
			>
		{/if}
		{#if open && source !== null}
			<div class="border-t pt-3">
				<Setup {...source} error={failure} controls={false} />
			</div>
		{/if}
	</li>
{/snippet}

{#if setupClient === null}
	{@render card(null)}
{:else}
	<IntegrationSetup client={setupClient} onStateChange={stateChanged} {t} {locale}>
		{#snippet children(source)}{@render card(source)}{/snippet}
	</IntegrationSetup>
{/if}
