<script lang="ts">
	import { Effect, Schema } from 'effect';
	import { onMount } from 'svelte';
	import { Button } from '@norbital-ai/ui/button';
	import { IconWrapper } from '@norbital-ai/ui/icon-wrapper';
	import { Scroll, Stack } from '@norbital-ai/ui/layout';
	import { getErrorMessage } from '@norbital-ai/std';
	import type { WorkspaceClient } from '#lib/client/ui/studio/workspace-client.js';

	/**
	 * The page a claim link lands on — an envoy registration or a workspace invitation — redeemed
	 * on load for the signed-in person, then a card about what happened. Nothing to press: the
	 * host has already established who is signed in, and a person who was not is sent back here by
	 * the host's own sign-in.
	 */
	let {
		client,
		search,
		kind
	}: { client: WorkspaceClient; search: string; kind: 'registration' | 'invitation' } = $props();

	const CLAIMS = {
		registration: {
			title: 'Register your number',
			doneTitle: 'Number registered',
			pending: 'Registering your number…',
			done: ['registered', 'already_registered'],
			redeem: (claimId: string) => client.system.envoys.registration.redeem({ claimId }),
			copy: {
				registered:
					'Your number is registered. Return to the conversation and send your message again.',
				expired: 'This registration link has expired. Send another message to receive a new link.',
				used: 'This registration link was used by a different account.',
				conflict: 'This number is already linked to another identity in this workspace.'
			} as Record<string, string>
		},
		invitation: {
			title: 'Join this workspace',
			doneTitle: 'Invitation accepted',
			pending: 'Accepting your invitation…',
			done: ['accepted', 'already_accepted'],
			redeem: (invitationId: string) => client.system.identity.invitation.accept({ invitationId }),
			copy: {
				accepted: 'You now have access to this workspace.',
				expired:
					'This invitation has expired. Ask a workspace administrator to send a new invitation.',
				revoked: 'This invitation was revoked. Ask a workspace administrator for a new one.',
				wrong_account: 'Sign in with the email address that received this invitation.'
			} as Record<string, string>
		}
	} as const;
	const claim = $derived(CLAIMS[kind]);
	const decodeState = Schema.decodeUnknownOption(Schema.Struct({ state: Schema.String }));

	const claimId = $derived(new URLSearchParams(search).get('claim')?.trim() ?? '');
	let outcome = $state<{ state: string; reason?: string }>({ state: 'pending' });

	onMount(() => {
		if (claimId === '') {
			outcome = { state: 'invalid' };
			return;
		}
		void Effect.runPromise(
			claim.redeem(claimId).pipe(
				Effect.match({
					onSuccess: (value) => {
						const decoded = decodeState(value);
						outcome = decoded._tag === 'Some' ? decoded.value : { state: 'invalid' };
					},
					onFailure: (cause) => {
						outcome = { state: 'unavailable', reason: getErrorMessage(cause) };
					}
				})
			)
		);
	});

	const done = $derived((claim.done as ReadonlyArray<string>).includes(outcome.state));
	const settled = $derived(outcome.state !== 'pending');
	const copy = $derived(
		outcome.state === 'pending'
			? claim.pending
			: done
				? claim.copy[claim.done[0]]!
				: outcome.state === 'unavailable'
					? `This could not be completed: ${outcome.reason}`
					: (claim.copy[outcome.state] ?? 'This link is not valid.')
	);
	/** The card is one of three states, and each says it with a colour and a mark, not a sentence alone. */
	const tone = $derived(
		done
			? { border: 'border-success/30', icon: 'lucide:circle-check', text: 'text-success' }
			: settled
				? { border: 'border-destructive/30', icon: 'lucide:circle-alert', text: 'text-destructive' }
				: { border: 'border-border', icon: 'lucide:loader-circle', text: 'text-info' }
	);
</script>

<svelte:head><title>{done ? claim.doneTitle : claim.title}</title></svelte:head>

<Scroll as="section" name={kind} inset class="bg-background">
	<div class="grid min-h-full place-items-center py-10">
		<Stack
			gap="sm"
			align="center"
			class="w-full max-w-md rounded-xl border bg-card p-8 text-center shadow-sm {tone.border}"
		>
			<IconWrapper
				name={tone.icon}
				class="size-9 {tone.text} {settled ? '' : 'motion-safe:animate-spin'}"
			/>
			<h1 class="text-heading">{done ? claim.doneTitle : claim.title}</h1>
			<p
				role={done || !settled ? 'status' : 'alert'}
				class="max-w-sm text-sm leading-relaxed {done || !settled
					? 'text-muted-foreground'
					: 'text-destructive'}"
			>
				{copy}
			</p>
			{#if done && kind === 'invitation'}
				<Button href="/" class="mt-1">Open the workspace</Button>
			{/if}
		</Stack>
	</div>
</Scroll>
