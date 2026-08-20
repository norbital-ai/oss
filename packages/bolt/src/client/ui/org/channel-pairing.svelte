<script lang="ts">
	import { onDestroy } from 'svelte';
	import { Inline, Stack } from '@norbital-ai/ui/layout';
	import { workspaceSession } from '../../session.js';

	/**
	 * Pairing one declared channel to a real messaging account.
	 *
	 * This is the registration workflow, and it is host-owned. The workspace declares the channel, its
	 * policy and its agent; what the host holds is the credential and the socket — so "is this channel
	 * connected" is a question only the host can answer, and it is asked through
	 * `operations`, the same seam Workspace Studio reads releases through. The runtime's own
	 * `channels.status` answers a deliberately different question (whether anything ever registered,
	 * and how many messages have passed) and is rendered separately for that reason.
	 *
	 * Every state shown here is one the host observed. There is no optimistic "connecting…" that
	 * outlives a failure and no green dot that means "we asked and nobody said no".
	 */

	const { operations } = workspaceSession();

	let { channel, provider }: { channel: string; provider: string } = $props();

	/** Exactly the projection the host's `channel` operation answers with. */
	type Connection = {
		readonly channel: string;
		readonly provider: string;
		readonly state: 'disconnected' | 'connecting' | 'pairing' | 'connected' | 'error';
		readonly pairedAs?: string;
		readonly pairing?: string;
		readonly pairingExpiresAt?: number;
		readonly error?: string;
		readonly stored: boolean;
	};

	let connection = $state<Connection | undefined>(undefined);
	let failure = $state<string | null>(null);
	let busy = $state(false);
	let qr = $state<string | undefined>(undefined);
	let poll: ReturnType<typeof setInterval> | undefined;

	/**
	 * The transport rotates its pairing code every twenty seconds and there is nothing to push it
	 * here, so the dialog asks. Polling stops the moment the channel is connected or errors — a page
	 * left open on a paired channel should not keep a timer alive for the rest of the session.
	 */
	const POLL_MS = 3_000;

	const stopPolling = () => {
		if (poll !== undefined) clearInterval(poll);
		poll = undefined;
	};
	onDestroy(stopPolling);

	/** Renders the transport's pairing payload as a QR the phone's camera can read. */
	const renderQr = async (payload: string | undefined): Promise<void> => {
		if (payload === undefined) {
			qr = undefined;
			return;
		}
		const { toDataURL } = await import('qrcode');
		// Fixed colours rather than the theme's: a QR is read by a camera, not by a person, and a
		// low-contrast pairing code in dark mode is one that simply does not scan.
		qr = await toDataURL(payload, {
			margin: 2,
			width: 240,
			color: { dark: '#000000', light: '#ffffff' }
		});
	};

	const run = async (operation: 'pair' | 'status' | 'unpair'): Promise<void> => {
		if (busy && operation !== 'status') return;
		if (operation !== 'status') busy = true;
		try {
			const answer = (await operations.run({
				action: 'channel',
				operation,
				channel,
				provider
			})) as { readonly connection?: Connection };
			const next = answer.connection;
			if (next === undefined) throw new Error('The host did not report this channel.');
			connection = next;
			failure = null;
			await renderQr(next.pairing);
			if (next.state === 'connected' || next.state === 'error') stopPolling();
			else if (poll === undefined && next.state !== 'disconnected')
				poll = setInterval(() => void run('status'), POLL_MS);
		} catch (cause) {
			// Shown verbatim. The refusals this host produces name what is wrong and what to do — no
			// transport for this provider, no secret key to seal a credential with, two channels open on
			// one transport — and replacing them with "pairing failed" throws all of that away.
			failure = cause instanceof Error ? cause.message : 'The host refused this operation.';
			stopPolling();
		} finally {
			if (operation !== 'status') busy = false;
		}
	};

	void run('status');

	const label = $derived.by(() => {
		if (connection === undefined) return 'Reading…';
		switch (connection.state) {
			case 'connected':
				return 'Connected';
			case 'pairing':
				return 'Scan to pair';
			case 'connecting':
				return 'Connecting';
			case 'error':
				return 'Needs attention';
			default:
				return connection.stored ? 'Paired, not connected' : 'Not paired';
		}
	});
</script>

<Stack as="section" gap="sm" class="border-t pt-4">
	<Inline align="center" justify="between" gap="md">
		<div>
			<h5 class="text-sm font-medium">Transport connection</h5>
			<p class="text-meta">
				{#if connection === undefined && failure === null}
					Asking the host…
				{:else if connection?.state === 'connected'}
					{connection.pairedAs === undefined
						? 'This host holds an open session for this channel.'
						: `Paired to ${connection.pairedAs}.`}
				{:else if connection?.state === 'pairing'}
					Open WhatsApp on the phone this agent should answer as, then Linked devices → Link a
					device.
				{:else if connection?.stored === true}
					A credential is stored, but this host has no open session for it.
				{:else}
					No credential is stored for this channel yet.
				{/if}
			</p>
		</div>
		<span class="shrink-0 rounded-sm bg-muted px-1.5 py-0.5 text-meta">{label}</span>
	</Inline>

	{#if failure !== null}
		<p class="text-xs text-destructive" role="alert">{failure}</p>
	{/if}

	{#if connection?.error !== undefined}
		<p class="text-xs text-destructive" role="alert">{connection.error}</p>
	{/if}

	{#if qr !== undefined && connection?.state === 'pairing'}
		<Stack gap="sm" class="items-center">
			<!-- On a white plate regardless of theme, for the same reason the code itself is: the
			     quiet zone around a QR has to be light or the camera cannot find its edges. -->
			<img src={qr} alt="Pairing code for {channel}" class="rounded-md bg-white p-2" />
			<p class="max-w-sm text-center text-meta">
				The code changes every few seconds; this refreshes on its own.
			</p>
		</Stack>
	{/if}

	<Inline gap="sm" align="center">
		<button
			type="button"
			class="rounded-md border px-2.5 py-1 text-xs font-medium disabled:opacity-50"
			disabled={busy}
			onclick={() => void run('pair')}
		>
			{connection?.stored === true ? 'Reconnect' : 'Pair this channel'}
		</button>
		{#if connection?.stored === true}
			<button
				type="button"
				class="rounded-md border px-2.5 py-1 text-xs font-medium text-destructive disabled:opacity-50"
				disabled={busy}
				onclick={() => void run('unpair')}
			>
				Unpair
			</button>
		{/if}
	</Inline>

	<!--
		Said where the person scanning can see it, which is the only place saying it is any use.
		Pairing a real account with an unofficial client is against WhatsApp's terms and accounts do get
		banned for it. Someone about to link their own number is entitled to know that before they do,
		not from a commit message afterwards.
	-->
	{#if provider === 'whatsapp'}
		<p class="text-meta">
			This links a real WhatsApp account through an unofficial client. That is against WhatsApp's
			terms of service and accounts are sometimes banned for it — use a number the business owns and
			can afford to lose, not a personal one.
		</p>
		<!--
			Two operational facts stated before somebody pairs, not after they notice.
			
			A paired session is a socket held in one host process, and neither of these is something the
			person clicking this button can see from here: a redeploy drops it, and a host running more
			than one instance has two of them fighting over one account. Both surface as a channel that
			answered yesterday and does not today, which is the hardest kind of fault to attribute — so
			the warning is worth more here, before the first pairing, than in any runbook.
		-->
		<p class="text-meta">
			A paired session lives in this host's memory. It does not survive a redeploy — reconnect here
			afterwards — and the host must run a single instance, or two of them will fight over the same
			account.
		</p>
	{/if}
</Stack>
