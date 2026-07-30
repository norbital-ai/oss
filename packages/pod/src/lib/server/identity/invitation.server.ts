import { getWorkspace } from '$lib/server/bootstrap/workspace_store.js';
import { createRecord } from '$lib/server/collection/collection_ops.server.js';
import { hashToken, mintToken } from '$lib/host/session.js';
import { requireRuntimeFacility } from '$lib/server/run/facilities.js';
import { UserRoleSchema } from '@norbital-ai/platform-utils/system/types';

const DEFAULT_TTL_HOURS = 72;

export type MintedInvitation = {
	readonly invitationId: string;
	/** The absolute accept URL. Returned so a caller can send it; never persisted. */
	readonly acceptUrl: string;
};

function acceptUrl(publicUrl: string, token: string): string {
	const base = publicUrl.replace(/\/+$/, '');
	return `${base}/accept-invite?token=${encodeURIComponent(token)}`;
}

/**
 * Create a pending invitation and return its one-time accept URL.
 *
 * Only the digest is stored, so the plaintext exists in exactly one place — the message this returns
 * a link for. That is also why the URL is returned rather than written anywhere: a caller that logs
 * it has re-created the credential the hash was meant to remove.
 */
export async function mintInvitation(input: {
	readonly email: string;
	readonly role?: string;
	readonly invitedByUserId?: string | null;
	readonly publicUrl: string;
	readonly ttlHours?: number;
}): Promise<MintedInvitation> {
	const ctx = getWorkspace({ provision: true });
	const email = input.email.trim().toLowerCase();
	if (!email) throw new Error('An invitation requires an email address');
	const role = UserRoleSchema.safeParse(input.role ?? 'basic').success
		? (input.role ?? 'basic')
		: 'basic';

	const { token, hash } = mintToken();
	const expiresAt = new Date(
		Date.now() + (input.ttlHours ?? DEFAULT_TTL_HOURS) * 60 * 60 * 1000
	).toISOString();

	const record = await createRecord(
		ctx,
		'invitation',
		{
			email,
			token_hash: hash,
			role,
			invited_by_user_id: input.invitedByUserId ?? null,
			expires_at: expiresAt
		},
		{ isElevated: true }
	);
	const invitationId = record.norbital_id;
	if (typeof invitationId !== 'string') throw new Error('Created invitation has no id');

	return { invitationId, acceptUrl: acceptUrl(input.publicUrl, token) };
}

/**
 * Look up the address a token belongs to, without consuming it.
 *
 * Consumption happens in `resolveSubjectToUser`, which claims the row conditionally so concurrent
 * accepts settle to one user. Splitting lookup from claim keeps this callable from the accept page,
 * which needs to know whose invitation it is before asking anyone to prove the address.
 */
export async function inviteeEmailForToken(token: string): Promise<string | null> {
	const ctx = getWorkspace({ provision: true });
	const result = await ctx.tenantDb.query<{ email: string }>({
		text: `SELECT email FROM invitation
		        WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > now()
		        LIMIT 1`,
		values: [hashToken(token)]
	});
	return result.rows[0]?.email ?? null;
}

/**
 * The founding invitation for a freshly provisioned tenant.
 *
 * Called once by the provisioning host over the private control plane. It deliberately creates an
 * invitation and **no user**: an invitation is a claim, not an identity, so a provisioned-but-unclaimed
 * tenant admits nobody. That is what makes it safe for the host to provision without verifying the
 * address it was given.
 *
 * Idempotent by the live-email unique index — a retried provision reuses the pending row rather than
 * minting a second token, so a duplicated call cannot hand out two valid credentials.
 */
export async function provisionFoundingInvitation(input: {
	readonly adminEmail: string;
	readonly publicUrl: string;
}): Promise<{ readonly delivered: boolean }> {
	const ctx = getWorkspace({ provision: true });
	const email = input.adminEmail.trim().toLowerCase();

	const existing = await ctx.tenantDb.query<{ norbital_id: string }>({
		text: `SELECT norbital_id FROM invitation
		        WHERE lower(email) = $1 AND consumed_at IS NULL AND expires_at > now()
		        LIMIT 1`,
		values: [email]
	});
	if (existing.rows[0]) return { delivered: false };

	const invitation = await mintInvitation({
		email,
		role: 'admin',
		publicUrl: input.publicUrl
	});

	// Required, not best-effort: a founding invitation nobody receives leaves a tenant that can never
	// be entered, so a missing messaging facility must fail provisioning loudly.
	const messaging = requireRuntimeFacility('notifications');
	const result = await messaging.send({
		organizationId: ctx.baseScope.organization.norbital_id,
		channel: messaging.channels[0] ?? 'email',
		recipientUserId: email,
		subject: `Your ${ctx.baseScope.organization.name} workspace is ready`,
		message: `Open your workspace to finish setting it up: ${invitation.acceptUrl}`,
		cta: { label: 'Accept invitation', url: invitation.acceptUrl }
	});
	if (!result.sent) {
		throw new Error(
			`Founding invitation could not be delivered: ${result.reason ?? 'provider refused'}`
		);
	}
	return { delivered: true };
}
