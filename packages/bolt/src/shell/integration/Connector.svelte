<!--
	One connector as a row, the way a plugin list draws it: the provider's mark, its name and one line, where it stands,
	and one button. Connect makes the instance when there is none (`create`) and, for a provider that pairs at once (a QR,
	a code, a sign-in), starts pairing in the same click; the instance's setup then opens beneath the row. Disconnect
	unpairs and removes the instance (`remove`). Other ways to connect (another mailbox) open the setup's provider choice.
-->
<script lang="ts">
	import { Effect, Predicate } from 'effect';
	import { fork } from '@norbital-ai/ui/effect';
	import { Button, Icon } from '@norbital-ai/ui';
	import { Stack } from '@norbital-ai/ui/layout';
	import type { Json } from '../../decl/values.ts';
	import type { InstanceState, ProviderChoice } from '../../protocol/instance-status.ts';
	import IntegrationSetup from '../../page/IntegrationSetup.svelte';
	import type { IntegrationClient } from '../../page/integrations.ts';
	import {
		driverLabel,
		pairsAtOnce,
		releaseSignIn,
		reserveSignIn,
		sayOf,
		statusLabel
	} from './setup.ts';

	let {
		driver,
		description,
		providers,
		instance,
		client,
		create,
		remove,
		t,
		locale
	}: {
		driver: string;
		/** The definition's own description, shown when the provider has none. */
		description: string;
		/** What this host offers for it, in its order of preference. */
		providers: readonly ProviderChoice[];
		/** The instance this connector stands for, with its row's durable `status`; `null` before the first Connect. */
		instance: { readonly id: string; readonly status: Json | null } | null;
		client: (instance: string) => IntegrationClient;
		/** Makes the instance and answers its id. */
		create: () => Effect.Effect<string, { readonly message: string }>;
		/** Removes the instance once it was unpaired. */
		remove: (instance: string) => Effect.Effect<void, { readonly message: string }>;
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
	const recorded = $derived.by(
		(): { state: InstanceState; account: string | null; stored: false } => {
			const s = instance?.status;
			const state = Predicate.isObject(s) ? s['state'] : undefined;
			const account = Predicate.isObject(s) ? s['account'] : undefined;
			return {
				state: state === 'connected' || state === 'error' ? state : 'unpaired',
				account: typeof account === 'string' ? account : null,
				stored: false
			};
		}
	);
	const connected = $derived(recorded.state === 'connected');

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
	function connect(pairing: boolean): void {
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
						yield* client(target).pair(providers.length > 1 ? { provider: p.id } : {});
				})
			)
		);
	}
	function disconnect(): void {
		const target = id;
		if (target === null) return;
		if (!confirm(t('Disconnect {name}?').replace('{name}', name))) return;
		fork(
			settle(
				Effect.gen(function* () {
					yield* client(target).unpair();
					yield* remove(target);
					made = null;
					open = false;
				})
			)
		);
	}
</script>

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
				<p class="text-meta" data-connector-state={recorded.state} aria-live="polite">
					{primary === undefined
						? t('Not available on this host')
						: instance === null
							? t('Not connected')
							: statusLabel(recorded, t)}
				</p>
			</Stack>
		</div>
		<div class="flex shrink-0 items-center gap-1">
			{#if connected}
				<Button size="sm" variant="ghost" onclick={() => (open = !open)}
					>{open ? t('Hide') : t('Manage')}</Button
				>
			{:else}
				<Button
					size="sm"
					disabled={busy || primary === undefined}
					onclick={() => connect(true)}
					data-connect>{busy ? t('Connecting…') : t('Connect')}</Button
				>
			{/if}
			{#if id !== null}
				<Button
					size="sm"
					variant="ghost"
					class="text-destructive"
					disabled={busy}
					onclick={disconnect}
					data-disconnect>{t('Disconnect')}</Button
				>
			{/if}
		</div>
	</div>
	{#if error !== null}<p role="alert" class="text-sm text-destructive">{error}</p>{/if}
	{#if !connected && !open && offered.some((p) => p !== primary)}
		<button
			type="button"
			class="self-start text-meta underline-offset-2 hover:underline"
			disabled={busy}
			onclick={() => connect(false)}>{t('Other ways to connect')}</button
		>
	{/if}
	{#if open && setupClient !== null}
		<div class="border-t pt-3"><IntegrationSetup client={setupClient} {t} {locale} /></div>
	{/if}
</li>
