import type { NorbitalManifest } from '@norbital-ai/platform-utils/manifest/types';
import type { PolicyReconcileClient } from './policy_reconcile.server.js';

/**
 * The workspace user a channel's agent acts as.
 *
 * A channel's whole point is that the person on the other end may have no user row — so the *agent*
 * needs one, because everything downstream of it is scoped by a requestor: the permission guard reads
 * `baseScope.requestor`, policy grants are resolved from the teams that requestor belongs to, and
 * `chat_session.user_id` is not nullable. Inventing a synthetic scope instead would mean a second,
 * unenforced path to the same data, which is exactly what a channel must not be.
 *
 * `.invalid` is the reserved TLD, so this address can never collide with a person's and can never
 * receive mail. `kind = 'agent'` is what keeps it off the seat census — a channel does not bill.
 */
export function channelPrincipalEmail(channelKey: string): string {
	return `channel.${channelKey}@channels.invalid`;
}

/** The team that carries the channel's declared policy. One per channel, never shared. */
export function channelPrincipalTeamName(channelKey: string): string {
	return `Channel: ${channelKey}`;
}

export type ChannelReconcileResult = {
	readonly created: number;
	readonly updated: number;
};

/**
 * Give every declared channel a principal to answer as.
 *
 * Runs where `reconcileDeclaredPolicies` runs and for the same reason: the declaration is the
 * authority, the rows it needs are ordinary tenant rows, and a deploy that changes one must change
 * the other in the same transaction. Doing it here rather than on the first inbound message also
 * removes a race — two messages arriving together would otherwise each try to create the team.
 *
 * A channel naming a policy that does not exist fails here, naming both. That is the only moment the
 * mistake is cheap: at delivery time it would surface as an agent that answers nothing, and the
 * silence is indistinguishable from a transport problem.
 */
export async function reconcileDeclaredChannels(
	client: PolicyReconcileClient,
	manifest: NorbitalManifest
): Promise<ChannelReconcileResult> {
	const declared = Object.values(manifest.channels ?? {});
	if (declared.length === 0) return { created: 0, updated: 0 };

	let created = 0;
	let updated = 0;
	for (const channel of declared) {
		const policy = await client.query(`SELECT norbital_id FROM policy WHERE key = $1 LIMIT 1`, [
			channel.policy
		]);
		const policyId = policy.rows[0]?.norbital_id;
		if (typeof policyId !== 'string') {
			throw new Error(
				`Channel "${channel.key}" answers under policy "${channel.policy}", which this workspace ` +
					'does not declare. Add `src/policies/+' +
					`${channel.policy}.policy.ts\` or point the channel at one that exists.`
			);
		}

		const user = await client.query(
			`INSERT INTO "user" (email, name, status, role, kind)
			      VALUES ($1, $2, 'active', 'basic', 'agent')
			 ON CONFLICT (email) DO UPDATE
			      SET name = EXCLUDED.name,
			          status = 'active',
			          kind = 'agent',
			          norbital_updated_at = CURRENT_TIMESTAMP
			   RETURNING norbital_id, (xmax = 0) AS inserted`,
			[channelPrincipalEmail(channel.key), `Channel ${channel.key}`]
		);
		const userId = user.rows[0]?.norbital_id;
		if (typeof userId !== 'string')
			throw new Error(`Channel principal for ${channel.key} has no id`);
		if (user.rows[0]?.inserted === true) created += 1;
		else updated += 1;

		// `team` has no unique key to conflict on, so this is a lookup and then one write. It is safe
		// here precisely because reconciliation is single-flight inside the migrate transaction.
		const existingTeam = await client.query(
			`SELECT norbital_id, policy_id FROM team WHERE name = $1 LIMIT 1`,
			[channelPrincipalTeamName(channel.key)]
		);
		let teamId = existingTeam.rows[0]?.norbital_id;
		if (typeof teamId === 'string') {
			// The declaration wins: repointing the channel at another policy in source has to move the
			// team with it, or the agent keeps answering under the permissions it used to have.
			if (existingTeam.rows[0]?.policy_id !== policyId) {
				await client.query(
					`UPDATE team SET policy_id = $2::uuid, norbital_updated_at = CURRENT_TIMESTAMP
					  WHERE norbital_id = $1::uuid`,
					[teamId, policyId]
				);
			}
		} else {
			const inserted = await client.query(
				`INSERT INTO team (name, description, is_active, kind, policy_id)
				      VALUES ($1, $2, TRUE, 'agent', $3::uuid)
				   RETURNING norbital_id`,
				[
					channelPrincipalTeamName(channel.key),
					`Permissions for the ${channel.key} channel agent`,
					policyId
				]
			);
			teamId = inserted.rows[0]?.norbital_id;
			if (typeof teamId !== 'string') throw new Error(`Channel team for ${channel.key} has no id`);
		}

		await client.query(
			`INSERT INTO team_members (user_id, team_id)
			 SELECT $1::uuid, $2::uuid
			  WHERE NOT EXISTS (
			        SELECT 1 FROM team_members WHERE user_id = $1::uuid AND team_id = $2::uuid
			  )`,
			[userId, teamId]
		);
		// These copied fields drive transcript visibility. Reconcile existing conversations as well as
		// new ones so changing a profile from authenticated to public closes member access at deploy.
		await client.query(
			`UPDATE channel_conversation
			    SET audience = $2, policy_key = $3, transport = $4,
			        norbital_updated_at = CURRENT_TIMESTAMP
			  WHERE channel_key = $1`,
			[channel.key, channel.audience, channel.policy, channel.transport]
		);
	}
	return { created, updated };
}
