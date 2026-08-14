/**
 * Turning the composer's "@" references into context the model can see.
 *
 * Each reference is fetched as the requestor — never elevated — so referencing a record is a
 * faster hand on the same read the person could take themselves, not a wider one. What the policy
 * hides, the mention does not surface.
 *
 * The fallback is quiet by design. A record that is gone, invisible to the requestor, or in a
 * collection this run cannot name produces a `status` attribute and nothing else: the `@label`
 * the writer typed is still in the message text, so the model keeps the name and can look for it
 * with its own tools. A bad reference degrades to prose, never to a failed turn.
 */
import { getTenantManifest } from '$lib/server/bootstrap/tenant_workspace.server.js';
import type { ProvisionedContext } from '$lib/server/bootstrap/workspace_store.js';
import { findMany } from '$lib/server/collection/collection_ops.server.js';
import type { MentionRecordHit } from '$lib/shared/agent/mention.js';

export type AgentMentionInput = MentionRecordHit;

/** One record snapshot is capped so a wide row cannot eat the window by itself. */
const SNAPSHOT_LIMIT = 8_000;

function escapeAttribute(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

/**
 * The `<attached-records>` block for this turn's window, or `null` when nothing was referenced.
 *
 * Per-turn context, deliberately: the transcript stores the clean message the person typed, and a
 * later turn that still needs the record can read it through `read_collection` — the label in the
 * replayed history says which one.
 */
export async function composeMentionContext(
	ctx: ProvisionedContext,
	mentions: readonly AgentMentionInput[]
): Promise<string | null> {
	if (mentions.length === 0) return null;
	const manifestCollections = getTenantManifest().collections;
	const blocks: string[] = [];
	for (const mention of mentions) {
		const attributes =
			`collection="${escapeAttribute(mention.collection)}" ` +
			`id="${escapeAttribute(mention.recordId)}" ` +
			`label="${escapeAttribute(mention.label)}"`;
		const metadata = manifestCollections[mention.collection];
		// System plumbing stays out of the model's window. People and teams are the allowlisted
		// exception — `@` can pin a user or a team the requestor can already read.
		const mentionableSystem = mention.collection === 'user' || mention.collection === 'team';
		if (!metadata || (metadata.system === true && !mentionableSystem)) {
			blocks.push(`<record ${attributes} status="unavailable" />`);
			continue;
		}
		try {
			const rows = await findMany(ctx, mention.collection, {
				where: { norbital_id: mention.recordId },
				limit: 1
			} as never);
			const row = rows[0];
			if (!row) {
				blocks.push(`<record ${attributes} status="not-found" />`);
				continue;
			}
			let snapshot = JSON.stringify(row);
			if (snapshot.length > SNAPSHOT_LIMIT) snapshot = `${snapshot.slice(0, SNAPSHOT_LIMIT)}…`;
			blocks.push(`<record ${attributes}>\n${snapshot}\n</record>`);
		} catch {
			blocks.push(`<record ${attributes} status="unavailable" />`);
		}
	}
	return `<attached-records>\n${blocks.join('\n')}\n</attached-records>`;
}
