<script lang="ts">
	import { Button } from '@norbital-ai/ui/button';
	import { Cluster, Inline, Stack } from '@norbital-ai/ui/layout';
	import { invitationStatusAt, isActionableInvitation, type InvitationRow } from './rows.js';

	let {
		invitations = [],
		busy = false,
		now = new Date(),
		oninvite,
		onrevoke,
		onresend
	}: {
		invitations?: ReadonlyArray<InvitationRow>;
		busy?: boolean;
		/** Injected so the expiry rendering is assertable without waiting for a clock. */
		now?: Date;
		oninvite?: () => void;
		onrevoke?: (invitationId: string) => void;
		onresend?: (invitationId: string) => void;
	} = $props();

	/**
	 * The expiry date, or nothing at all.
	 *
	 * Distinct from the audit log's formatter, which falls back to the raw string: an invitation with
	 * no deadline and one with an unreadable deadline both mean "no expiry to show", and printing a
	 * broken value beside a live Revoke button would read as a deadline the reader could act on.
	 */
	const formatExpiry = (invitation: InvitationRow): string | undefined => {
		if (invitation.expiresAt === undefined) return undefined;
		const at = Date.parse(invitation.expiresAt);
		return Number.isNaN(at) ? undefined : new Date(at).toLocaleDateString();
	};
</script>

<Stack as="section" gap="md" aria-busy={busy}>
	<!--
		The invite action sits on this section, not on the surface header: it creates an invitation,
		which is the only thing this section is about. Hanging it off the page title put the control a
		full screen away from the list it changes.
	-->
	<Cluster gap="md" align="end" justify="between">
		<Stack as="header" gap="xs">
			<h2 class="text-heading">Pending invitations</h2>
			<p class="text-sm text-muted-foreground">
				Seats that have been offered and not yet taken up.
			</p>
		</Stack>
		{#if oninvite}
			<Button type="button" size="sm" disabled={busy} onclick={oninvite}>Invite member</Button>
		{/if}
	</Cluster>
	{#if invitations.length === 0}
		<div class="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
			No pending invitations.
		</div>
	{:else}
		<Stack as="ul" gap="md" aria-label="Invitations" class="m-0 list-none p-0">
			{#each invitations as invitation (invitation.id)}
				{@const status = invitationStatusAt(invitation, now)}
				{@const expiry = formatExpiry(invitation)}
				<Cluster
					as="li"
					gap="md"
					align="start"
					justify="between"
					class="rounded-lg border bg-card p-4"
				>
					<Stack gap="xs">
						<h3 class="font-medium">{invitation.email}</h3>
						<p class="text-meta">
							{invitation.role}{#if invitation.invitedBy}
								· invited by {invitation.invitedBy}{/if}{#if expiry}
								· expires {expiry}{/if}
						</p>
					</Stack>
					<Inline gap="sm" shrink={false}>
						<span class="rounded-full border px-2 py-0.5 text-meta" data-testid="invitation-status"
							>{status}</span
						>
						{#if isActionableInvitation(invitation, now)}
							{#if onresend}
								<Button
									type="button"
									variant="outline"
									size="sm"
									disabled={busy}
									onclick={() => onresend?.(invitation.id)}
								>
									Resend
								</Button>
							{/if}
							{#if onrevoke}
								<Button
									type="button"
									variant="outline"
									size="sm"
									disabled={busy}
									onclick={() => onrevoke?.(invitation.id)}
								>
									Revoke
								</Button>
							{/if}
						{/if}
					</Inline>
				</Cluster>
			{/each}
		</Stack>
	{/if}
</Stack>
