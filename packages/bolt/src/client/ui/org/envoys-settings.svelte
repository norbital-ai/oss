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
	} from './envoy-connection-presentation.js';

	/**
	 * The Envoys surface: every agent this workspace exposes on a transport, and how each is doing.
	 *
	 * An envoy is an agent that is not the web agent — it has its own identity, its own declared
	 * policies, and one transport it answers on. It is not a collection's integration, which syncs
	 * records for one collection and lives under that collection's own tab in Workspace Studio. The
	 * two were previously shown together and read as one thing; keeping them on separate surfaces is
	 * what stops that.
	 *
	 * **One envoy is one row, and there is no grouping above it.** This page used to draw an agent
	 * card and nest the channels under it, because a channel pointed at an agent — a back-pointer
	 * whose value was the single synthesized agent, in every workspace, always. So every reader paid
	 * for a level of hierarchy that had exactly one node. An envoy *is* the agent; the card is the
	 * envoy.
	 *
	 * Pairing is folded in here too, for the same reason. It was a separate component because it
	 * looked like a separate object; it is a *state* of an envoy — whether the host is holding an open
	 * socket for it — and it belongs on the envoy's own card beside the traffic the runtime reports.
	 *
	 * Every state on this page is one somebody actually published. `workspace.manifest` names the
	 * envoys, `envoys.status` reports registration and traffic, the host answers for the connection,
	 * and where a command answers with neither — a failure, or a field the projection never carried —
	 * the page says so rather than filling the gap with a default that would read as "connected".
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

	/**
	 * Exactly the projection `workspace.manifest` publishes for an envoy.
	 *
	 * No `agent`. The manifest stopped carrying one because there is nothing to point at.
	 */
	type DeclaredEnvoy = WorkspaceManifest['envoys'][number];
	/** Exactly what `envoys.status` returns — one owner: the Studio's `EnvoyStatusSchema`, decoded. */
	/** Exactly the projection the host's `transport` operation answers with. */
	const ConnectionSchema = Schema.Struct({
		envoy: Schema.String,
		provider: Schema.String,
		state: Schema.Literals(['disconnected', 'connecting', 'pairing', 'connected', 'error']),
		revision: Schema.optionalKey(
			Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))
		),
		pairedAs: Schema.optionalKey(Schema.String),
		pairing: Schema.optionalKey(Schema.String),
		pairingExpiresAt: Schema.optionalKey(Schema.Number),
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
	const envoys = $derived<ReadonlyArray<DeclaredEnvoy>>(manifestQuery?.current?.envoys ?? []);
	const statusQueries = $derived(
		envoys.map((envoy) => {
			const deadline = AbortSignal.timeout(STATUS_DEADLINE_MS);
			return {
				name: envoy.name,
				deadline,
				query: client.system.envoys.status({ envoy: envoy.name }, deadline)
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
										: 'The runtime did not report this envoy.'
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
	let pairingTarget = $state<DeclaredEnvoy | undefined>(undefined);
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
	const renderQr = (envoy: string, payload: string | undefined) =>
		Effect.gen(function* () {
			if (payload === undefined) {
				delete qrCodes[envoy];
				return;
			}
			const { toDataURL } = yield* Effect.tryPromise(() => import('qrcode'));
			// Fixed colours rather than the theme's: a QR is read by a camera, not by a person, and a
			// low-contrast pairing code in dark mode is one that simply does not scan.
			qrCodes[envoy] = yield* Effect.tryPromise(() =>
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
	 * The workspace declares the envoy and its policies; the host holds the credential and the
	 * socket — so "is this connected" is a question only the host can answer. `envoys.status` answers
	 * a deliberately different one (whether anything ever registered, and how many messages have
	 * passed) and is rendered separately for that reason.
	 *
	 * `action: 'transport'`, not `'envoy'`. Colony supplies the wire and never sees a policy, so its
	 * half of this is named for the wire.
	 */
	const runPairingRequest = (
		envoy: string,
		provider: string,
		operation: 'pair' | 'status' | 'observe' | 'unpair',
		afterRevision?: number
	): Effect.Effect<void> =>
		Effect.suspend(() => {
			const requestVersion = (connectionRequestVersions.get(envoy) ?? 0) + 1;
			connectionRequestVersions.set(envoy, requestVersion);

			return Effect.gen(function* () {
				const answer = yield* Schema.decodeUnknownEffect(ConnectionAnswerSchema)(
					yield* Effect.tryPromise((signal) =>
						operations.run(
							{
								action: 'transport',
								operation,
								envoy,
								provider,
								...(afterRevision === undefined ? {} : { afterRevision })
							},
							signal
						)
					)
				);
				const next = answer.connection;
				if (next === undefined)
					return yield* Effect.fail(new Error('The host did not report this envoy.'));
				// The page starts one status read per envoy. If somebody clicks Pair before that read
				// settles, its older "disconnected" answer must not overwrite the newer pairing socket.
				if (connectionRequestVersions.get(envoy) !== requestVersion) return;
				connections[envoy] = next;
				delete connectionErrors[envoy];
				yield* renderQr(envoy, next.pairing);
			}).pipe(
				Effect.catch((cause) => {
					if (connectionRequestVersions.get(envoy) !== requestVersion) return Effect.void;
					// Shown verbatim. The refusals this host produces name what is wrong and what to do — no
					// transport for this provider, no secret key to seal a credential with, two envoys open on
					// one transport — and replacing them with "pairing failed" throws all of that away.
					connectionErrors[envoy] =
						cause instanceof Error ? cause.message : 'The host refused this operation.';
					return Effect.void;
				})
			);
		});

	/**
	 * Owns the one host-side socket open that may be unresolved for an envoy.
	 *
	 * The socket open itself deliberately outlives the modal fiber. Releasing `pairingBusy` when a
	 * dialog closes would make interruption look like cancellation while the host is still opening,
	 * so reopening could dispatch a second `pair`. The independently owned Promise below lives until
	 * the real host request settles. Every dialog opened meanwhile awaits that same Promise; the event
	 * observation after it is interruptible.
	 */
	const ownPairingOpen = (envoy: string, provider: string): Promise<void> => {
		const existing = pairingOpens.get(envoy);
		if (existing !== undefined) return existing;

		pairingBusy[envoy] = true;
		let completion: Promise<void>;
		completion = Effect.runPromise(runPairingRequest(envoy, provider, 'pair')).finally(() => {
			// Identity matters if this code ever grows a retry hand-off: an older completion must not
			// release ownership held by a newer request.
			if (pairingOpens.get(envoy) !== completion) return;
			pairingOpens.delete(envoy);
			pairingBusy[envoy] = false;
		});
		pairingOpens.set(envoy, completion);
		return completion;
	};

	const runUnpairing = (envoy: string, provider: string): Effect.Effect<void> =>
		Effect.suspend(() => {
			if (pairingBusy[envoy] === true || unpairingBusy[envoy] === true) return Effect.void;
			unpairingBusy[envoy] = true;
			return runPairingRequest(envoy, provider, 'unpair').pipe(
				Effect.ensuring(
					Effect.sync(() => {
						unpairingBusy[envoy] = false;
					})
				)
			);
		});

	/** Waits for provider-published revisions; it performs no timed status reads. */
	const observePairing = (envoy: DeclaredEnvoy): Effect.Effect<void> =>
		Effect.suspend(() => {
			const current = connections[envoy.name];
			const revision = current?.revision;
			if (
				pairingTarget?.name !== envoy.name ||
				connectionErrors[envoy.name] !== undefined ||
				current === undefined ||
				revision === undefined ||
				current.state === 'connected' ||
				current.state === 'error'
			)
				return Effect.void;
			return runPairingRequest(envoy.name, envoy.transport, 'observe', revision).pipe(
				Effect.andThen(
					Effect.suspend(() => {
						const nextRevision = connections[envoy.name]?.revision;
						return nextRevision !== undefined && nextRevision > revision
							? observePairing(envoy)
							: Effect.void;
					})
				)
			);
		});

	const followPairing = (envoy: DeclaredEnvoy): Effect.Effect<void> =>
		Effect.tryPromise({
			try: () => ownPairingOpen(envoy.name, envoy.transport),
			catch: toError
		}).pipe(
			Effect.andThen(observePairing(envoy)),
			Effect.catch((cause) => {
				// `runPairingRequest` reports its own refusals and cannot fail, so a rejection here is the
				// owned open itself breaking — a defect in the fiber holding it. The dialog is waiting on
				// that Promise, and this is the only fiber that will ever hear about it: the `$effect`
				// below forks this and a failure left in the channel would be discarded there, leaving the
				// card on a spinner for a socket nobody is still opening. Shown on the card, like every
				// other pairing failure this page reports.
				connectionErrors[envoy.name] =
					cause.message === '' ? 'The pairing request could not be started.' : cause.message;
				return Effect.void;
			})
		);

	function openPairing(envoy: DeclaredEnvoy): void {
		const resumingOpen = pairingOpens.has(envoy.name);
		if (!resumingOpen) {
			pairingReconnects[envoy.name] = connections[envoy.name]?.stored === true;
			delete connectionErrors[envoy.name];
			delete qrCodes[envoy.name];
			// Do not paint the card's older disconnected snapshot as the outcome of the pair request that
			// has only just started. The dialog owns a fresh host workflow and waits for its first answer.
			delete connections[envoy.name];
		}
		pairingTarget = envoy;
	}

	function closePairing(): void {
		pairingTarget = undefined;
	}

	$effect(() => {
		const target = pairingTarget;
		if (target === undefined) return;
		const fiber = Effect.runFork(followPairing(target));
		return () => {
			Effect.runFork(Fiber.interrupt(fiber));
		};
	});

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

	// The read is the browser's, as it is in `studio/envoys-panel.svelte`: server rendering must not
	// issue a Bolt command, and a reader who opens Envoys has already asked the question it answers.
	// It ran at component init here, which happens on the server too under any host that renders this
	// surface — `workspaceSession()` throws there rather than returning a session to command with.
	const pairingStarted = new Set<string>();
	const pairingStatusTargets = $derived(envoys.map((envoy) => envoy.name));
	watch(
		() => pairingStatusTargets,
		(names) => {
			for (const envoy of envoys) {
				if (!names.includes(envoy.name) || pairingStarted.has(envoy.name)) continue;
				pairingStarted.add(envoy.name);
				Effect.runFork(runPairingRequest(envoy.name, envoy.transport, 'status'));
			}
		}
	);
</script>

{#snippet pairingPanel(envoy: DeclaredEnvoy)}
	{@const connection = connections[envoy.name]}
	{@const failure = connectionErrors[envoy.name]}
	<Stack as="section" gap="sm" class="border-t pt-4">
		<Inline align="center" justify="between" gap="md">
			<div>
				<h5 class="text-sm font-medium">Transport connection</h5>
				<p class="text-meta">
					{#if connection === undefined && failure === undefined}
						Asking the host…
					{:else if connection?.state === 'connected'}
						{connection.pairedAs === undefined
							? 'This host holds an open session for this envoy.'
							: `Paired to ${connection.pairedAs}.`}
					{:else if connection?.state === 'pairing'}
						{envoy.transport === 'whatsapp'
							? 'Open WhatsApp on the phone this envoy should answer as, then Linked devices → Link a device.'
							: 'The transport provider is waiting for pairing to finish.'}
					{:else if connectionIsRecovering(connection)}
						The host is reopening the {envoy.transport} session automatically.
					{:else if connection?.stored === true}
						A credential is stored, but this host has no open session for it.
					{:else}
						No credential is stored for this envoy yet.
					{/if}
				</p>
			</div>
			<span class="shrink-0 rounded-sm bg-muted px-1.5 py-0.5 text-meta">
				{connectionLabel(connection, envoy.transport)}
			</span>
		</Inline>

		{#if failure !== undefined}
			<p class="text-xs text-destructive" role="alert">{failure}</p>
		{/if}

		<p class="text-meta">
			Pairing only links this envoy to its {envoy.transport} account. Sender registration happens later,
			when an unknown person messages an authenticated envoy.
		</p>

		{#if connection?.detail !== undefined}
			<p class="text-meta" aria-live="polite">{connection.detail}</p>
		{/if}

		{#if connectionIsTerminalError(connection) && connection?.error !== undefined}
			<p class="text-xs text-destructive" role="alert">{connection.error}</p>
		{/if}

		<Inline gap="sm" align="center">
			<button
				type="button"
				class="rounded-md border px-2.5 py-1 text-xs font-medium disabled:opacity-50"
				disabled={unpairingBusy[envoy.name] === true}
				onclick={() => openPairing(envoy)}
			>
				{pairingBusy[envoy.name] === true
					? 'Resume pairing'
					: connection?.stored === true
						? 'Reconnect'
						: 'Pair this envoy'}
			</button>
			{#if connection?.stored === true}
				<button
					type="button"
					class="rounded-md border px-2.5 py-1 text-xs font-medium text-destructive disabled:opacity-50"
					disabled={pairingBusy[envoy.name] === true || unpairingBusy[envoy.name] === true}
					onclick={() => void Effect.runPromise(runUnpairing(envoy.name, envoy.transport))}
				>
					Unpair
				</button>
			{/if}
		</Inline>

		<!--
			Said where the person scanning can see it, which is the only place saying it is any use.
			Pairing a real account with an unofficial client is against WhatsApp's terms and accounts do
			get banned for it. Someone about to link their own number is entitled to know that before they
			do, not from a commit message afterwards.
		-->
		{#if envoy.transport === 'whatsapp'}
			<p class="text-meta">
				This links a real WhatsApp account through an unofficial client. That is against WhatsApp's
				terms of service and accounts are sometimes banned for it — use a number the business owns
				and can afford to lose, not a personal one.
			</p>
			<!--
				Two operational facts stated before somebody pairs, not after they notice.

				A paired session is a socket held in one host process, and neither of these is something
				the person clicking this button can see from here: a redeploy drops it, and a host running
				more than one instance has two of them fighting over one account. Both surface as an envoy
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

{#snippet envoyCard(declared: DeclaredEnvoy)}
	{@const status = statuses[declared.name]}
	{@const failure = statusErrors[declared.name]}
	<!--
		The same card the Workspace Studio manifest draws, at the same density. The name is mono
		because it is an identifier the workspace source declares, not a title somebody chose.
	-->
	<Stack as="section" gap="sm" class="rounded-lg border border-border bg-card p-4 shadow-card">
		<Inline gap="sm" align="start" class="min-w-0">
			<div
				class="flex size-6 shrink-0 items-center justify-center rounded-md border border-border/60"
			>
				<IconWrapper name="lucide:bot" class="size-3.5 text-muted-foreground" />
			</div>
			<div class="min-w-0">
				<p class="truncate font-mono text-sm font-semibold text-foreground">{declared.name}</p>
				<p class="text-meta">Declared in the workspace source.</p>
			</div>
		</Inline>
		<!-- Outside the status block on purpose. The transport and the audience are declared in the
		     workspace source, so they are known whether or not `envoys.status` answered; folding them
		     in would hide what the envoy *is* behind a failure to read how it is *doing*. -->
		<Grid as="dl" gap="sm" minimum="compact" class="border-t pt-4 text-xs">
			<Stack gap="xs">
				<dt class="font-medium text-foreground">Transport</dt>
				<dd class="text-muted-foreground">{declared.transport}</dd>
			</Stack>
			<Stack gap="xs">
				<dt class="font-medium text-foreground">Audience</dt>
				<dd class="text-muted-foreground">
					{declared.audience === 'public'
						? 'Public — anyone who can reach the transport.'
						: declared.audience === 'authenticated'
							? 'Authenticated — known senders are matched to a workspace identity; unknown senders receive a private 15-minute registration link.'
							: declared.audience}
				</dd>
			</Stack>
		</Grid>
		<!-- The runtime answers only for traffic; the host answers only for its live transport. -->
		{@render pairingPanel(declared)}
		{#if failure !== undefined}
			<!-- The message is shown verbatim: an operator who sees a blank card concludes the envoy is
			     idle, when the runtime in fact refused to answer for it. -->
			<p class="border-t pt-4 text-xs text-destructive">{failure}</p>
		{:else if status !== undefined}
			<Grid as="dl" gap="sm" minimum="compact" class="border-t pt-4 text-xs">
				<Stack gap="xs">
					<dt class="font-medium text-foreground">Messages received</dt>
					<dd class="text-muted-foreground">{status.received}</dd>
				</Stack>
				<Stack gap="xs">
					<dt class="font-medium text-foreground">Replies sent</dt>
					<dd class="text-muted-foreground">{status.replied}</dd>
				</Stack>
			</Grid>
		{:else}
			<p class="border-t pt-4 text-meta">Reading this envoy's traffic…</p>
		{/if}
	</Stack>
{/snippet}

<!-- Root navigation follows the product's page-heading rhythm, as Workspace Studio does: title, one
     line of what the page is for, then the body. The header sits on the background, not in a card.

     There is no tab strip. It carried exactly one tab, "Channels", under a heading that already said
     the same word — a rail with one rung, kept against the day an agent grew other facets. Those
     facets are policies now, and they are not configured here. -->
<Cover class="relative bg-background" gap="none">
	{#snippet top()}
		<Stack gap="lg" shrink={false} class="bg-background px-4 pt-4 sm:px-6 sm:pt-6">
			<Stack as="header" gap="xs">
				<h1 class="text-heading">Envoys</h1>
				<p class="max-w-2xl text-meta">
					The agents this workspace exposes on a transport, and how each one is reachable. What an
					envoy may <em>do</em> is the policies it declares, in the workspace source. A collection's own
					record sync is not configured here — it belongs to the collection, under its tab in Workspace
					Studio.
				</p>
			</Stack>
		</Stack>
	{/snippet}

	<!-- One page gutter for the whole body, matching the header's own left/right padding, so the
	     content lines up with the title on every axis. -->
	<Inline align="stretch" gap="none" fill class="px-4 pt-4 pb-4 sm:px-6 sm:pt-6 sm:pb-6">
		<Bound size="full" grow clip class="relative min-w-0 bg-background font-sans">
			<!--
				The panel owns its scroll, because the frame around it does not.

				`Bound … clip` clips what overflows and scrolls nothing, so a workspace with more than a
				screenful of envoys — or one showing a pairing code, which is tall — had content that could
				not be reached at all. `organization-general` already wraps its pane this way; this one was
				the outlier, and the symptom was a page that looked complete and would not move.
			-->
			<Scroll name="Envoys">
				<Stack gap="md" class="min-h-0">
					{#if manifestQuery === undefined || (manifestQuery.current === undefined && manifestQuery.loading)}
						<p class="text-sm text-muted-foreground">Reading the workspace manifest…</p>
					{:else if manifestQuery.current === undefined && manifestQuery.error !== undefined}
						<p class="text-sm text-destructive" role="alert">
							{manifestQuery.error instanceof Error
								? manifestQuery.error.message
								: 'Unable to read the workspace manifest.'}
						</p>
					{:else if envoys.length === 0}
						<div
							class="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground"
						>
							No envoys declared. Author one in <code>src/envoys/</code> to put this workspace's agent
							on a transport.
						</div>
					{:else}
						<Stack gap="md">
							{#each envoys as declared (declared.name)}
								{@render envoyCard(declared)}
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
						Open WhatsApp on the phone this envoy should answer as, then choose Linked devices →
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
			{:else if connection?.state === 'connected'}
				<Stack gap="sm" align="center" class="rounded-lg border border-success/30 p-6 text-center">
					<IconWrapper name="lucide:circle-check" class="size-9 text-success" />
					<p class="text-sm font-medium text-foreground">Envoy connected</p>
					<p class="text-meta">
						{connection.pairedAs === undefined
							? 'The transport connection is open.'
							: `Connected as ${connection.pairedAs}.`}
					</p>
					<p class="max-w-sm text-meta">
						Pairing is complete. People register their own numbers only when they first message an
						authenticated envoy.
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
								? 'The host is using the saved credential for this envoy.'
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
