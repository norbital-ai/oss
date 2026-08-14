/**
 * An invitation as an administrator may see it. Deliberately not the row — `token_hash` never
 * leaves the server, so both the settings surface and the identity endpoints share this projection.
 */
export type WorkspaceInvitation = {
	readonly norbital_id: string;
	readonly email: string;
	readonly role: string;
	readonly status: 'pending' | 'accepted' | 'expired';
	readonly created_at: string;
	readonly expires_at: string;
};
