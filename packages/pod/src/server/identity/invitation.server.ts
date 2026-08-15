import { getWorkspace } from '$lib/server/bootstrap/workspace_store.js';
import { createRecord } from '$lib/server/collection/collection_ops.server.js';
import { inviteeEmailForTokenOnDb } from '$lib/host/directory.js';
import { hashToken, mintToken } from '$lib/host/session.js';
import { requireRuntimeFacility } from '$lib/server/facilities.js';
import { serverI18n } from '$lib/i18n/index.js';
import { UserRoleSchema } from '@norbital-ai/platform-utils/system/types';

const DEFAULT_TTL_HOURS = 72;

export type MintedInvitation = {
	readonly invitationId: string;
	/**
	 * The accept path, origin-relative: `/accept-invite?token=…`.
	 *
	 * Relative rather than absolute because minting does not know the origin and should not have to
	 * guess. Inside a tenant isolate the request URL is `http://tenant.local/…`, and behind a proxy
	 * the bound port is not the public address either — so the only honest answers are "the host told
	 * us" or "whoever is going to send this knows". A caller that needs an absolute link either has a
	 * configured `publicUrl` (see `absoluteAcceptUrl`) or is a browser, which knows its own origin
	 * better than any configuration does.
	 *
	 * Carries the plaintext token, so it is returned and never persisted: a caller that logs it has
	 * re-created the credential the stored digest exists to remove.
	 */
	readonly acceptPath: string;
};

/**
 * Absolute link, for a sender with no browser — an email has no `location.origin`.
 *
 * `publicUrl` is the host's claim about where this workspace is reachable, so this is only correct
 * where such a claim exists. Anything rendered to the person who asked should compose the origin on
 * the client instead.
 */
export function absoluteAcceptUrl(publicUrl: string, acceptPath: string): string {
	return `${publicUrl.replace(/\/+$/, '')}${acceptPath}`;
}

/**
 * Create a pending invitation and return its one-time accept path.
 *
 * Only the digest is stored, so the plaintext exists in exactly one place — the message this returns
 * a link for.
 */
export async function mintInvitation(input: {
	readonly email: string;
	readonly role?: string;
	readonly invitedByUserId?: string | null;
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

	return { invitationId, acceptPath: `/accept-invite?token=${encodeURIComponent(token)}` };
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
	return inviteeEmailForTokenOnDb(
		{
			query: (sql, values) =>
				ctx.tenantDb.query({ text: sql, values: values ? [...values] : [] })
		},
		hashToken(token)
	);
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
	/** The recipient-side language signal, when the provisioning caller has one (`?lang=` etc.). */
	readonly locale?: string | null;
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

	const invitation = await mintInvitation({ email, role: 'admin' });
	// The one caller that genuinely needs an absolute link: this one arrives by email, and an email
	// has no origin to compose against. `publicUrl` is the provisioning host's own claim, which is why
	// it is required here and nowhere else.
	const acceptUrl = absoluteAcceptUrl(input.publicUrl, invitation.acceptPath);

	// Required, not best-effort: a founding invitation nobody receives leaves a tenant that can never
	// be entered, so a missing messaging facility must fail provisioning loudly.
	const messaging = requireRuntimeFacility('messaging');
	const channels = await messaging.listChannels();
	const workspaceName = ctx.baseScope.organization.name;
	const i18n = serverI18n(input.locale ?? null);
	const result = await messaging.send({
		organizationId: ctx.baseScope.organization.norbital_id,
		channel: channels[0] ?? 'email',
		recipientUserId: email,
		subject: i18n.t('pod.email.readySubject', { workspace: workspaceName }),
		message: i18n.t('pod.email.readyBody', { url: acceptUrl }),
		cta: { label: i18n.t('pod.email.inviteCta'), url: acceptUrl }
	});
	if (!result.sent) {
		throw new Error(
			`Founding invitation could not be delivered: ${result.reason ?? 'provider refused'}`
		);
	}
	return { delivered: true };
}
