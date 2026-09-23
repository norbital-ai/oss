<script lang="ts">
	import { Effect, Fiber, Schema } from 'effect';
	import { onMount } from 'svelte';
	import { watch } from 'runed';
	import { Button } from '@norbital-ai/ui/button';
	import * as Dialog from '@norbital-ai/ui/dialog';
	import { Bound, Cover, Grid, Inline, Scroll, Stack } from '@norbital-ai/ui/layout';
	import { IconWrapper } from '@norbital-ai/ui/icon-wrapper';
	import { toError } from '@norbital-ai/std';
	import { workspaceSession } from '#lib/client/session.js';
	import type { WorkspaceManifest } from '#lib/client/ui/studio/studio-state.js';
	import type { WorkspaceClient } from '#lib/client/ui/studio/workspace-client.js';
	import {
		connectionIsRecovering,
		connectionIsTerminalError,
		connectionLabel
	} from './channel-connection-presentation.js';

	/**
	 * Settings → Channels: every channel this workspace declares, how its history sync and its outbox
	 * are doing, and — for the transports a host must pair — the pairing itself (channels.md §12).
	 *
	 * Every state on this page is one somebody published: `workspace.manifest` names the channels and
	 * the envoy on each, `channels.status` reports history and delivery, and the host answers for the
	 * connection. Where a command answers with neither, the page says so rather than filling the gap
	 * with a default that would read as "connected".
	 */

	/**
	 * The transport is the session's, named rather than reached for.
	 *
	 * It used to arrive as a `command` prop the host shell threaded down, which was correct while the
	 * host owned the shell. The workspace client owns it now, and one declared session is what every
	 * surface reads — a second channel handed down beside it would be two ways to say the same thing.
	 */
	let { client }: { client: WorkspaceClient } = $props();
	const { operations } = workspaceSession();

	/** Exactly the projection `workspace.manifest` publishes for a channel. */
	type DeclaredChannel = WorkspaceManifest['channels'][number];
	type DeclaredEnvoy = WorkspaceManifest['envoys'][number];
	/** The transports a host pairs: a QR to scan, or a credential to paste. */
	const PAIRED_TRANSPORTS: ReadonlyArray<string> = ['whatsapp', 'telegram'];
	/** Exactly the projection the host's `transport` operation answers with. */
	const ConnectionSchema = Schema.Struct({
		channel: Schema.String,
		provider: Schema.String,
		state: Schema.Literals(['disconnected', 'connecting', 'pairing', 'connected', 'error']),
		revision: Schema.optionalKey(
			Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
		),
		pairedAs: Schema.optionalKey(Schema.String),
		pairing: Schema.optionalKey(Schema.String),
		pairingExpiresAt: Schema.optionalKey(Schema.Number),
		/** How an unpaired channel is paired: scan a QR, or submit a credential. */
		pairingKind: Schema.optionalKey(Schema.Literals(['qr', 'credential'])),
		/** True only while the host is automatically reopening a recoverable connection. */
		retrying: Schema.optionalKey(Schema.Boolean),
		/** Operator-readable context for a non-terminal connection transition. */
		detail: Schema.optionalKey(Schema.String),
		/** Reserved for `state: 'error'`, whose recovery requires operator action. */
		error: Schema.optionalKey(Schema.String),
		stored: Schema.Boolean
	});
	type Connection = typeof ConnectionSchema.Type;
	const ConnectionAnswerSchema = Schema.Struct({
		connection: Schema.optionalKey(ConnectionSchema)
	});

	let browserReady = $state(false);
	onMount(() => {
		browserReady = true;
	});
	const manifestQuery = $derived(browserReady ? client.system.workspace.manifest({}) : undefined);
	const channels = $derived<ReadonlyArray<DeclaredChannel>>(manifestQuery?.current?.channels ?? []);
	const envoyOn = (channel: string): DeclaredEnvoy | undefined =>
		manifestQuery?.current?.envoys.find((declared) => declared.channel === channel);
	const statusQueries = $derived(
		channels.map((channel) => {
			const deadline = AbortSignal.timeout(STATUS_DEADLINE_MS);
			return {
				name: channel.name,
				deadline,
				query: client.system.channels.status({ channel: channel.name }, deadline)
			};
		})
	);
	const statuses = $derived(
		Object.fromEntries(
			statusQueries.flatMap(({ name, query }) => {
				const status = query.current;
				return status === undefined ? [] : [[name, status] as const];
			})
		)
	);
	// Kept beside the statuses rather than folded into them: a failed traffic query is not zero
	// traffic, and storing both in one record would let the page render counters it never received.
	const statusErrors = $derived(
		Object.fromEntries(
			statusQueries.flatMap(({ name, deadline, query }) =>
				query.error === undefined
					? []
					: [
							[
								name,
								deadline.aborted
									? `The runtime did not answer within ${Math.round(STATUS_DEADLINE_MS / 1000)}s.`
									: query.error instanceof Error
										? query.error.message
										: 'The runtime did not report this channel.'
							] as const
						]
			)
		)
	);
	let connections = $state<Record<string, Connection>>({});
	let connectionErrors = $state<Record<string, string>>({});
	let qrCodes = $state<Record<string, string>>({});
	// This is ownership of an unresolved host `pair` operation, not ownership of the dialog.
	// Closing the dialog must not clear it: the underlying operations.run Promise cannot be cancelled.
	let pairingBusy = $state<Record<string, boolean>>({});
	let unpairingBusy = $state<Record<string, boolean>>({});
	let pairingTarget = $state<DeclaredChannel | undefined>(undefined);
	/** The token being typed for a credential-paired transport, per channel. */
	let credentialInput = $state<Record<string, string>>({});
	let pairingReconnects = $state<Record<string, boolean>>({});
	const connectionRequestVersions = new Map<string, number>();
	const pairingOpens = new Map<string, Promise<void>>();

	/**
	 * How long one status read may take before this page says so.
	 *
	 * Not a preference, and not defensive decoration. `transport.command` is a bare `fetch` with no
	 * timeout of its own (`browser-transport.ts`), and the reads below were awaited with no signal —
	 * so a command that never settled left its card reading "Checking" indefinitely, reporting
	 * neither a status nor a failure. That is the one outcome this surface's whole premise forbids:
	 * a state the runtime never published, rendered as though it had. A bound does not fix whatever
	 * stalled upstream; it makes the stall say its own name instead of impersonating a slow page.
	 */
	const STATUS_DEADLINE_MS = 15_000;

	/** Renders the transport's pairing payload as a QR the phone's camera can read. */
	const renderQr = (channel: string, payload: string | undefined) =>
		Effect.gen(function* () {
			if (payload === undefined) {
				delete qrCodes[channel];
				return;
			}
			const { toDataURL } = yield* Effect.tryPromise(() => import('qrcode'));
			// Fixed colours rather than the theme's: a QR is read by a camera, not by a person, and a
			// low-contrast pairing code in dark mode is one that simply does not scan.
			qrCodes[channel] = yield* Effect.tryPromise(() =>
				toDataURL(payload, {
					margin: 2,
					width: 240,
					color: { dark: '#000000', light: '#ffffff' }
				})
			);
		});

	/**
	 * Pairing, which is host-owned and asked through `operations` rather than through the runtime.
	 *
	 * The workspace declares the channel; the host holds the credential and the socket — so "is this
	 * connected" is a question only the host can answer. `channels.status` answers a different one
	 * (the history sync and the delivery record) and is rendered separately for that reason.
	 */
	const runPairingRequest = (
		channel: string,
		provider: string,
		operation: 'pair' | 'status' | 'observe' | 'unpair',
		afterRevision?: number,
		credential?: string
	): Effect.Effect<void> =>
		Effect.suspend(() => {
			const requestVersion = (connectionRequestVersions.get(channel) ?? 0) + 1;
			connectionRequestVersions.set(channel, requestVersion);

			return Effect.gen(function* () {
				const answer = yield* Schema.decodeUnknownEffect(ConnectionAnswerSchema)(
					yield* Effect.tryPromise((signal) =>
						operations.run(
							{
								action: 'transport',
								operation,
								channel,
								provider,
								...(afterRevision === undefined ? {} : { afterRevision }),
								...(credential === undefined ? {} : { credential })
							},
							signal
						)
					)
				);
				const next = answer.connection;
				if (next === undefined)
					return yield* Effect.fail(new Error('The host did not report this channel.'));
				// The page starts one status read per channel. If somebody clicks Pair before that read
				// settles, its older "disconnected" answer must not overwrite the newer pairing socket.
				if (connectionRequestVersions.get(channel) !== requestVersion) return;
				connections[channel] = next;
				delete connectionErrors[channel];
				yield* renderQr(channel, next.pairing);
			}).pipe(
				Effect.catch((cause) => {
					if (connectionRequestVersions.get(channel) !== requestVersion) return Effect.void;
					// Shown verbatim. The refusals this host produces name what is wrong and what to do — no
					// adapter for this transport, no secret key to seal a credential with — and replacing
					// them with "pairing failed" throws all of that away.
					connectionErrors[channel] =
						cause instanceof Error ? cause.message : 'The host refused this operation.';
					return Effect.void;
				})
			);
		});

	/**
	 * Owns the one host-side socket open that may be unresolved for a channel.
	 *
	 * The socket open itself deliberately outlives the modal fiber. Releasing `pairingBusy` when a
	 * dialog closes would make interruption look like cancellation while the host is still opening,
	 * so reopening could dispatch a second `pair`. The independently owned Promise below lives until
	 * the real host request settles. Every dialog opened meanwhile awaits that same Promise; the event
	 * observation after it is interruptible.
	 */
	const ownPairingOpen = (channel: string, provider: string): Promise<void> => {
		const existing = pairingOpens.get(channel);
		if (existing !== undefined) return existing;

		pairingBusy[channel] = true;
		let completion: Promise<void>;
		completion = Effect.runPromise(runPairingRequest(channel, provider, 'pair')).finally(() => {
			// Identity matters if this code ever grows a retry hand-off: an older completion must not
			// release ownership held by a newer request.
			if (pairingOpens.get(channel) !== completion) return;
			pairingOpens.delete(channel);
			pairingBusy[channel] = false;
		});
		pairingOpens.set(channel, completion);
		return completion;
	};

	const runUnpairing = (channel: string, provider: string): Effect.Effect<void> =>
		Effect.suspend(() => {
			if (pairingBusy[channel] === true || unpairingBusy[channel] === true) return Effect.void;
			unpairingBusy[channel] = true;
			return runPairingRequest(channel, provider, 'unpair').pipe(
				Effect.ensuring(
					Effect.sync(() => {
						unpairingBusy[channel] = false;
					})
				)
			);
		});

	/** Waits for provider-published revisions; it performs no timed status reads. */
	const observePairing = (channel: DeclaredChannel): Effect.Effect<void> =>
		Effect.suspend(() => {
			const current = connections[channel.name];
			const revision = current?.revision;
			if (
				pairingTarget?.name !== channel.name ||
				connectionErrors[channel.name] !== undefined ||
				current === undefined ||
				revision === undefined ||
				current.state === 'connected' ||
				current.state === 'error'
			)
				return Effect.void;
			return runPairingRequest(channel.name, channel.transport, 'observe', revision).pipe(
				Effect.andThen(
					Effect.suspend(() => {
						const nextRevision = connections[channel.name]?.revision;
						return nextRevision !== undefined && nextRevision > revision
							? observePairing(channel)
							: Effect.void;
					})
				)
			);
		});

	const followPairing = (channel: DeclaredChannel): Effect.Effect<void> =>
		Effect.tryPromise({
			try: () => ownPairingOpen(channel.name, channel.transport),
			catch: toError
		}).pipe(
			Effect.andThen(observePairing(channel)),
			Effect.catch((cause) => {
				// `runPairingRequest` reports its own refusals and cannot fail, so a rejection here is the
				// owned open itself breaking — a defect in the fiber holding it. The dialog is waiting on
				// that Promise, and this is the only fiber that will ever hear about it: the `$effect`
				// below forks this and a failure left in the channel would be discarded there, leaving the
				// card on a spinner for a socket nobody is still opening. Shown on the card, like every
				// other pairing failure this page reports.
				connectionErrors[channel.name] =
					cause.message === '' ? 'The pairing request could not be started.' : cause.message;
				return Effect.void;
			})
		);

	function openPairing(channel: DeclaredChannel): void {
		const resumingOpen = pairingOpens.has(channel.name);
		if (!resumingOpen) {
			pairingReconnects[channel.name] = connections[channel.name]?.stored === true;
			delete connectionErrors[channel.name];
			delete qrCodes[channel.name];
			// Do not paint the card's older disconnected snapshot as the outcome of the pair request that
			// has only just started. The dialog owns a fresh host workflow and waits for its first answer.
			delete connections[channel.name];
		}
		pairingTarget = channel;
	}

	function closePairing(): void {
		pairingTarget = undefined;
	}

	$effect(() => {
		const target = pairingTarget;
		if (target === undefined) return;
		// A credential transport waits for the operator: opening it without a secret would only
		// publish a failure the person has not had a chance to prevent.
		const connection = connections[target.name];
		if (connection?.pairingKind === 'credential' && connection.stored !== true) return;
		const fiber = Effect.runFork(followPairing(target));
		return () => {
			Effect.runFork(Fiber.interrupt(fiber));
		};
	});

	const submitCredential = (channel: DeclaredChannel): void => {
		const credential = credentialInput[channel.name]?.trim();
		if (credential === undefined || credential === '' || pairingBusy[channel.name] === true) return;
		pairingBusy[channel.name] = true;
		Effect.runFork(
			runPairingRequest(channel.name, channel.transport, 'pair', undefined, credential).pipe(
				Effect.ensuring(
					Effect.sync(() => {
						pairingBusy[channel.name] = false;
						delete credentialInput[channel.name];
					})
				),
				Effect.andThen(observePairing(channel))
			)
		);
	};

	/**
	 * The clock behind the pairing countdown, ticking only while the dialog shows a code.
	 *
	 * `pairingExpiresAt` is the host's wall clock, so the remaining time is host minus client and a
	 * skewed client shows a shifted count — accepted, because the alternative is a countdown the host
	 * would have to stream. What is not accepted is showing a code past its expiry: a scanned-expired
	 * code fails on the phone with a message that blames the phone's connection, which is exactly the
	 * misattribution this page exists to prevent.
	 */
	let pairingNow = $state(Date.now());
	const EXPIRED_REFRESH_GRACE_MS = 5_000;
	const refreshKicks = new Map<string, number>();
	watch(
		[() => pairingTarget, () => (pairingTarget ? connections[pairingTarget.name] : undefined)],
		([target, connection]) => {
			if (target === undefined) return;
			if (connection?.state !== 'pairing' || connection.pairingExpiresAt === undefined) return;
			const checkStall = (): void => {
				const current = connections[target.name];
				if (current?.state !== 'pairing' || current.pairingExpiresAt === undefined) return;
				const now = Date.now();
				pairingNow = now;
				if (now - current.pairingExpiresAt < EXPIRED_REFRESH_GRACE_MS) return;
				const revision = current.revision ?? 0;
				if (refreshKicks.get(target.name) === revision) return;
				refreshKicks.set(target.name, revision);
				Effect.runFork(
					runPairingRequest(target.name, target.transport, 'status').pipe(
						Effect.andThen(observePairing(target))
					)
				);
			};
			checkStall();
			const timer = setInterval(checkStall, 500);
			return () => clearInterval(timer);
		}
	);

	// The read is the browser's: server rendering must not issue a Bolt command, and a reader who opens
	// Channels has already asked the question it answers.
	const pairingStarted = new Set<string>();
	const hostChannels = $derived(channels.filter(({ transport }) => transport !== 'inbox'));
	const pairingStatusTargets = $derived(hostChannels.map((channel) => channel.name));
	watch(
		() => pairingStatusTargets,
		(names) => {
			for (const channel of hostChannels) {
				if (!names.includes(channel.name) || pairingStarted.has(channel.name)) continue;
				pairingStarted.add(channel.name);
				Effect.runFork(runPairingRequest(channel.name, channel.transport, 'status'));
			}
		}
	);
</script>

{#snippet pairingPanel(channel: DeclaredChannel)}
	{@const connection = connections[channel.name]}
	{@const failure = connectionErrors[channel.name]}
	<Stack as="section" gap="sm" class="border-t pt-4">
		<Inline align="center" justify="between" gap="md">
			<div>
				<h5 class="text-sm font-medium">Transport connection</h5>
				<p class="text-meta">
					{#if connection === undefined && failure === undefined}
						Asking the host…
					{:else if connection?.state === 'connected'}
						{connection.pairedAs === undefined
							? 'This host holds an open session for this channel.'
							: channel.transport === 'email'
								? `Receiving at ${connection.pairedAs}.`
								: channel.transport === 'http'
									? `Webhook URL: ${connection.pairedAs}`
									: `Paired to ${connection.pairedAs}.`}
					{:else if connection?.state === 'pairing'}
						{channel.transport === 'whatsapp'
							? 'Open WhatsApp on the phone this channel should answer as, then Linked devices → Link a device.'
							: 'The transport provider is waiting for pairing to finish.'}
					{:else if connectionIsRecovering(connection)}
						The host is reopening the {channel.transport} session automatically.
					{:else if connection?.stored === true}
						A credential is stored, but this host has no open session for it.
					{:else if PAIRED_TRANSPORTS.includes(channel.transport)}
						No credential is stored for this channel yet.
					{:else}
						The host provisions this channel with the workspace; nothing to pair.
					{/if}
				</p>
			</div>
			<span class="shrink-0 rounded-sm bg-muted px-1.5 py-0.5 text-meta">
				{connectionLabel(connection, channel.transport)}
			</span>
		</Inline>

		{#if failure !== undefined}
			<p class="text-xs text-destructive" role="alert">{failure}</p>
		{/if}

		{#if PAIRED_TRANSPORTS.includes(channel.transport)}
			<p class="text-meta">
				Pairing only links this channel to its {channel.transport} account. Sender registration happens
				later, when an unknown person messages an authenticated channel on it.
			</p>
		{/if}

		{#if connection?.detail !== undefined}
			<p class="text-meta" aria-live="polite">{connection.detail}</p>
		{/if}

		{#if connectionIsTerminalError(connection) && connection?.error !== undefined}
			<p class="text-xs text-destructive" role="alert">{connection.error}</p>
		{/if}

		{#if PAIRED_TRANSPORTS.includes(channel.transport)}
		<Inline gap="sm" align="center">
			<button
				type="button"
				class="rounded-md border px-2.5 py-1 text-xs font-medium disabled:opacity-50"
				disabled={unpairingBusy[channel.name] === true}
				onclick={() => openPairing(channel)}
			>
				{pairingBusy[channel.name] === true
					? 'Resume pairing'
					: connection?.stored === true
						? 'Reconnect'
						: 'Pair this channel'}
			</button>
			{#if connection?.stored === true}
				<button
					type="button"
					class="rounded-md border px-2.5 py-1 text-xs font-medium text-destructive disabled:opacity-50"
					disabled={pairingBusy[channel.name] === true || unpairingBusy[channel.name] === true}
					onclick={() => void Effect.runPromise(runUnpairing(channel.name, channel.transport))}
				>
					Unpair
				</button>
			{/if}
		</Inline>
		{/if}

		<!--
			Said where the person scanning can see it, which is the only place saying it is any use.
			Pairing a real account with an unofficial client is against WhatsApp's terms and accounts do
			get banned for it. Someone about to link their own number is entitled to know that before they
			do, not from a commit message afterwards.
		-->
		{#if channel.transport === 'whatsapp'}
			<p class="text-meta">
				This links a real WhatsApp account through an unofficial client. That is against WhatsApp's
				terms of service and accounts are sometimes banned for it — use a number the business owns
				and can afford to lose, not a personal one.
			</p>
			<!--
				Two operational facts stated before somebody pairs, not after they notice.

				A paired session is a socket held in one host process, and neither of these is something
				the person clicking this button can see from here: a redeploy drops it, and a host running
				more than one instance has two of them fighting over one account. Both surface as an channel
				that answered yesterday and does not today, which is the hardest kind of fault to
				attribute — so the warning is worth more here, before the first pairing, than in any
				runbook.
			-->
			<p class="text-meta">
				A paired session lives in this host's memory. It does not survive a redeploy — reconnect
				here afterwards — and the host must run a single instance, or two of them will fight over
				the same account.
			</p>
		{/if}
	</Stack>
{/snippet}

{#snippet channelCard(declared: DeclaredChannel)}
	{@const status = statuses[declared.name]}
	{@const failure = statusErrors[declared.name]}
	{@const speaker = envoyOn(declared.name)}
	<Stack as="section" gap="sm" class="rounded-lg border border-border bg-card p-4 shadow-card">
		<Inline gap="sm" align="start" class="min-w-0">
			<div
				class="flex size-6 shrink-0 items-center justify-center rounded-md border border-border/60"
			>
				<IconWrapper name="lucide:radio-tower" class="size-3.5 text-muted-foreground" />
			</div>
			<div class="min-w-0">
				<p class="truncate font-mono text-sm font-semibold text-foreground">{declared.name}</p>
				<p class="text-meta">Declared in the workspace source.</p>
			</div>
		</Inline>
		<!-- What the channel *is* is declared in source, so it shows whether or not the runtime answered. -->
		<Grid as="dl" gap="sm" minimum="compact" class="border-t pt-4 text-xs">
			<Stack gap="xs">
				<dt class="font-medium text-foreground">Transport</dt>
				<dd class="text-muted-foreground">{declared.transport}</dd>
			</Stack>
			<Stack gap="xs">
				<dt class="font-medium text-foreground">Envoy</dt>
				<dd class="text-muted-foreground">
					{#if speaker === undefined}
						None — history only.
					{:else}
						<span class="font-mono">{speaker.name}</span> ·
						{speaker.audience === 'public'
							? 'public'
							: speaker.audience === 'authenticated'
								? 'authenticated senders; unknown senders get a 15-minute registration link'
								: "private: a direct message runs under the sender's own policies"}
					{/if}
				</dd>
			</Stack>
		</Grid>
		{#if declared.transport !== 'inbox'}
			{@render pairingPanel(declared)}
		{/if}
		{#if failure !== undefined}
			<p class="border-t pt-4 text-xs text-destructive">{failure}</p>
		{:else if status !== undefined}
			<Grid as="dl" gap="sm" minimum="compact" class="border-t pt-4 text-xs">
				<Stack gap="xs">
					<dt class="font-medium text-foreground">History</dt>
					<dd class="text-muted-foreground">
						{status.history}{status.horizon === null ? '' : ` · recorded from ${status.horizon}`}
					</dd>
				</Stack>
				<Stack gap="xs">
					<dt class="font-medium text-foreground">Last inbound</dt>
					<dd class="text-muted-foreground">{status.lastInboundAt ?? '—'}</dd>
				</Stack>
				<Stack gap="xs">
					<dt class="font-medium text-foreground">Received</dt>
					<dd class="text-muted-foreground">{status.received}</dd>
				</Stack>
				<Stack gap="xs">
					<dt class="font-medium text-foreground">Sent · queued · failed</dt>
					<dd class={status.failed > 0 ? 'text-destructive' : 'text-muted-foreground'}>
						{status.sent} · {status.pending} · {status.failed}
					</dd>
				</Stack>
			</Grid>
		{:else}
			<p class="border-t pt-4 text-meta">Reading this channel's status…</p>
		{/if}
	</Stack>
{/snippet}

<!-- Root navigation follows the product's page-heading rhythm, as Workspace Studio does: title, one
     line of what the page is for, then the body. The header sits on the background, not in a card.

     -->
<Cover class="relative bg-background" gap="none">
	{#snippet top()}
		<Stack gap="lg" shrink={false} class="bg-background px-4 pt-4 sm:px-6 sm:pt-6">
			<Stack as="header" gap="xs">
				<h1 class="text-heading">Channels</h1>
				<p class="max-w-2xl text-meta">
					Where this workspace sends and receives messages: each channel's history, its delivery
					record, and the pairing a host needs. What an channel on a channel may <em>do</em> is the
					policies it declares, in the workspace source.
				</p>
			</Stack>
		</Stack>
	{/snippet}

	<!-- One page gutter for the whole body, matching the header's own left/right padding, so the
	     content lines up with the title on every axis. -->
	<Inline align="stretch" gap="none" fill class="px-4 pt-4 pb-4 sm:px-6 sm:pt-6 sm:pb-6">
		<Bound size="full" grow clip class="relative min-w-0 bg-background font-sans">
			<!--
				The panel owns its scroll, because the frame around it does not: `Bound … clip` clips what
				overflows and scrolls nothing.
			-->
			<Scroll name="Channels">
				<Stack gap="md" class="min-h-0">
					{#if manifestQuery === undefined || (manifestQuery.current === undefined && manifestQuery.loading)}
						<p class="text-sm text-muted-foreground">Reading the workspace manifest…</p>
					{:else if manifestQuery.current === undefined && manifestQuery.error !== undefined}
						<p class="text-sm text-destructive" role="alert">
							{manifestQuery.error instanceof Error
								? manifestQuery.error.message
								: 'Unable to read the workspace manifest.'}
						</p>
					{:else if channels.length === 0}
						<div
							class="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground"
						>
							No channels declared. Author one in <code>src/channels/</code> to give this workspace a
							place to send and receive messages.
						</div>
					{:else}
						<Stack gap="md">
							{#each channels as declared (declared.name)}
								{@render channelCard(declared)}
							{/each}
						</Stack>
					{/if}
				</Stack>
			</Scroll>
		</Bound>
	</Inline>
</Cover>

<Dialog.Root open={pairingTarget !== undefined} onOpenChange={(open) => !open && closePairing()}>
	{#if pairingTarget !== undefined}
		{@const target = pairingTarget}
		{@const connection = connections[target.name]}
		{@const failure = connectionErrors[target.name]}
		{@const qr = qrCodes[target.name]}
		{@const reconnecting = pairingReconnects[target.name] === true}
		{@const pairingRemainingMs =
			connection?.state === 'pairing' && connection.pairingExpiresAt !== undefined
				? Math.max(0, connection.pairingExpiresAt - pairingNow)
				: undefined}
		{@const pairingExpired = pairingRemainingMs === 0}
		<!-- repository-health:allow UI21 -- the pairing dialog panel width is viewport-responsive (min(28rem, 100vw - 2rem)); Bound states height contracts only -->
		<Dialog.Content class="w-[min(28rem,calc(100vw-2rem))]">
			<Dialog.Header>
				<Dialog.Title>{reconnecting ? 'Reconnect' : 'Pair'} {target.name}</Dialog.Title>
				<Dialog.Description>
					{#if reconnecting}
						The host is reopening the saved {target.transport} session. Keep this dialog open while it
						connects.
					{:else if target.transport === 'whatsapp'}
						Open WhatsApp on the phone this channel should answer as, then choose Linked devices →
						Link a device.
					{:else}
						Keep this dialog open while the host starts the {target.transport} transport. Follow any verification
						steps its provider requests.
					{/if}
				</Dialog.Description>
			</Dialog.Header>

			{#if failure !== undefined}
				<Stack
					gap="sm"
					align="center"
					class="rounded-lg border border-destructive/30 p-5 text-center"
				>
					<IconWrapper name="lucide:circle-alert" class="size-8 text-destructive" />
					<p class="text-sm font-medium text-foreground">The transport could not open</p>
					<p class="text-xs text-destructive" role="alert">{failure}</p>
				</Stack>
			{:else if connection?.pairingKind === 'credential' && connection.stored !== true}
				<Stack gap="sm" class="rounded-lg border p-4">
					<p class="text-sm font-medium text-foreground">Transport credential</p>
					<p class="text-meta">
						{target.transport === 'telegram'
							? 'Create a bot with BotFather (/newbot) and paste its token. The host seals it and points the bot at this host.'
							: `Paste the ${target.transport} credential. The host seals it before opening the session.`}
					</p>
					<input
						type="password"
						class="w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-sm"
						placeholder="Token"
						aria-label="Transport credential"
						value={credentialInput[target.name] ?? ''}
						oninput={(event) => (credentialInput[target.name] = event.currentTarget.value)}
					/>
					<Button
						onclick={() => submitCredential(target)}
						disabled={pairingBusy[target.name] === true}
					>
						{pairingBusy[target.name] === true ? 'Registering…' : 'Register credential'}
					</Button>
				</Stack>
			{:else if connection?.state === 'connected'}
				<Stack gap="sm" align="center" class="rounded-lg border border-success/30 p-6 text-center">
					<IconWrapper name="lucide:circle-check" class="size-9 text-success" />
					<p class="text-sm font-medium text-foreground">Channel connected</p>
					<p class="text-meta">
						{connection.pairedAs === undefined
							? 'The transport connection is open.'
							: `Connected as ${connection.pairedAs}.`}
					</p>
					<p class="max-w-sm text-meta">
						Pairing is complete. People register their own numbers only when they first message an
						authenticated channel on this channel.
					</p>
				</Stack>
			{:else if connectionIsRecovering(connection)}
				<Stack gap="sm" align="center" class="rounded-lg border border-info/30 p-5 text-center">
					<IconWrapper
						name="lucide:loader-circle"
						class="size-8 text-info motion-safe:animate-spin"
					/>
					<p class="text-sm font-medium text-foreground">Reconnecting the transport</p>
					<p class="text-meta" aria-live="polite">
						{connection?.detail ??
							`The host is reopening the ${target.transport} session automatically. No action is needed.`}
					</p>
				</Stack>
			{:else if connectionIsTerminalError(connection)}
				<Stack
					gap="sm"
					align="center"
					class="rounded-lg border border-destructive/30 p-5 text-center"
				>
					<IconWrapper name="lucide:circle-alert" class="size-8 text-destructive" />
					<p class="text-sm font-medium text-foreground">The transport needs attention</p>
					<p class="text-xs text-destructive" role="alert">
						{connection?.error ?? 'Close this dialog and try again.'}
					</p>
				</Stack>
			{:else if connection?.state === 'disconnected'}
				<Stack gap="sm" align="center" class="rounded-lg border border-warning/30 p-5 text-center">
					<IconWrapper name="lucide:unplug" class="size-8 text-warning" />
					<p class="text-sm font-medium text-foreground">Transport disconnected</p>
					<p class="text-meta">
						{connection.detail ?? 'Close this dialog, then try pairing again.'}
					</p>
				</Stack>
			{:else if connection?.state === 'pairing' && qr !== undefined && !pairingExpired}
				<Stack gap="sm" align="center">
					<!-- Fixed white quiet zone and a fixed pixel size keep the camera-readable code intact. -->
					<img
						src={qr}
						alt="Pairing code for {target.name}"
						width="240"
						height="240"
						class="size-60 max-w-full rounded-md bg-white p-2"
					/>
					<p class="max-w-sm text-center text-meta">
						{target.transport === 'whatsapp'
							? 'Scan this code with the linked-devices camera. It refreshes here when WhatsApp rotates it.'
							: `Use this pairing code with ${target.transport}. It refreshes here when the provider rotates it.`}
					</p>
					{#if pairingRemainingMs !== undefined}
						<p class="text-meta tabular-nums" aria-live="polite">
							This code expires in {Math.ceil(pairingRemainingMs / 1000)}s.
						</p>
					{/if}
				</Stack>
			{:else}
				<Stack gap="sm" align="center" class="p-8 text-center" aria-live="polite">
					<IconWrapper
						name="lucide:loader-circle"
						class="size-8 text-muted-foreground motion-safe:animate-spin"
					/>
					<p class="text-sm font-medium text-foreground">
						{pairingExpired
							? 'Waiting for a fresh code…'
							: reconnecting
								? 'Reopening the transport…'
								: target.transport === 'whatsapp'
									? 'Waiting for a pairing code…'
									: 'Opening the transport…'}
					</p>
					<p class="text-meta">
						{pairingExpired
							? 'The previous code expired, so it was taken off screen. A new one appears when the provider rotates it.'
							: reconnecting
								? 'The host is using the saved credential for this channel.'
								: target.transport === 'whatsapp'
									? 'The code will appear when WhatsApp publishes it.'
									: `The host is starting the ${target.transport} connection.`}
					</p>
				</Stack>
			{/if}

			<Dialog.Footer>
				<Button variant="outline" onclick={closePairing}>
					{connection?.state === 'connected' ? 'Done' : 'Close'}
				</Button>
			</Dialog.Footer>
		</Dialog.Content>
	{/if}
</Dialog.Root>
