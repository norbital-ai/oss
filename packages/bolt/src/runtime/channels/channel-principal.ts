import { Effect } from 'effect';
import type { Identity } from '../identity/identity.js';
import { EffectId } from '@norbital-ai/bolt-protocol';
import type { ChannelDeclaration, WorkspaceDefinition } from '../../authoring/workspace-schema.js';
import { Database } from '../facilities/database.js';

/**
 * Who a channel's turns run as, and — the part that matters — what they may reach while doing it.
 *
 * A channel is a way for someone outside the workspace to make an agent act inside it. The agent
 * needs authority to be useful and must not have more than the workspace declared, so the whole
 * question is where that authority comes from. There is exactly one answer in this runtime:
 * `AccessControl` resolves policies from a subject's `teamPath` through `+teams.ts`, and nothing
 * else confers anything. A subject with an empty path holds nothing at all.
 *
 * So a channel principal is a service row in a team, and the team is chosen from the *declaration* —
 * never created with authority attached. A row that granted a policy would be privilege escalation
 * performed with an `insert`, in a place no diff and no type check can see, which is precisely the
 * arrangement `+teams.ts` exists to prevent. What activation reconciles here is plumbing: the team
 * row, and the account that sits in it. What it may do was decided in source, by a person, in a
 * commit.
 */

/**
 * The address that identifies one channel's principal, and the reason it cannot be delivered to.
 *
 * A principal is a row in the same table people are in, and `email` is the column that table is
 * looked up by — so the principal needs one, and it must be an address that can never collide with a
 * person's and can never receive mail. `.invalid` is reserved by RFC 2606 for exactly this: it is
 * guaranteed never to resolve, so a misconfiguration that tried to mail a principal fails at DNS
 * rather than at somebody's inbox.
 *
 * `kind: 'service'` is what actually says this is not a person; the address only has to be unique
 * and undeliverable.
 */
export const channelPrincipalEmail = (channelName: string): string =>
	`channel+${channelName}@channels.invalid`;

/**
 * The team a channel's principal belongs to: the one the release declares as holding exactly this
 * channel's policy, and nothing besides.
 *
 * **Exactly, not merely including.** A team holding the channel's policy alongside others would hand
 * every turn on the channel the others too — `policiesHeldByTeam` returns the union of a team's
 * holdings, and `rowPredicate` unions the `where` of every matching grant, so one unconditional
 * grant sitting beside a narrowed one collapses the predicate to `true`. `+teams.ts` in
 * field-operations spells this hazard out for `Contractor (Controller)`. Picking a superset team
 * here would reproduce it silently, on a surface reachable by anyone who can message a phone number.
 *
 * Returning nothing is a real and correct outcome, not a fallback to be papered over. A workspace
 * that declares a channel and no team for its policy has not said what the channel may do, and the
 * only safe reading of that is refusal — `Channels.receive` reports it and runs no model. The
 * alternative this replaces is what field-operations actually shipped: a channel whose declared
 * ceiling resolved to nothing, running against no ceiling at all.
 *
 * Ties broken lexically so two runs of the same release choose the same team. A tie means two teams
 * are the same authority under two names, so which one wins changes nothing about capability.
 */
export const channelPrincipalTeam = (
	definition: WorkspaceDefinition,
	channel: Pick<ChannelDeclaration, 'policy'>
): string | undefined => {
	const wanted = channel.policy.toLocaleLowerCase();
	return Object.entries(definition.teams ?? {})
		.filter(([, policies]) => {
			const held = policies.map((policy) => policy.toLocaleLowerCase());
			return held.length === 1 && held[0] === wanted;
		})
		.map(([name]) => name)
		.toSorted((left, right) => left.localeCompare(right))[0];
};

/**
 * Make sure every declared channel has a team row and an account in it.
 *
 * Its temperament is `reconcileApproverTeams`', deliberately and for the same reason: this binds two
 * sides that move independently, so a fault here reports itself and is stepped over rather than
 * taking a release down. A channel left without a principal is not silently degraded — it refuses
 * inbound messages by name — so failing the activation would cost the workspace its other channels
 * and its web app to fix nothing.
 *
 * The team row is created empty-of-authority in the only sense that matters: its policies come from
 * `+teams.ts`, which already named it, and this insert adds no capability that the release did not
 * already declare. It exists because `bolt_auth_user.team_id` must point at a row.
 */
export const reconcileChannelPrincipals = Effect.fn('Bolt.reconcileChannelPrincipals')(function* (
	effectId: EffectId,
	definition: WorkspaceDefinition,
	tenantId: string
) {
	const database = yield* Database.Service;
	const created: Array<string> = [];
	for (const channel of definition.channels) {
		const team = channelPrincipalTeam(definition, channel);
		if (team === undefined) {
			yield* Effect.logWarning(
				`activation: channel "${channel.name}" declares policy "${channel.policy}", and no team in +teams.ts holds ` +
					`exactly that policy. The channel has no principal and will refuse inbound messages until one team ` +
					`declares ["${channel.policy}"] and nothing else.`
			);
			continue;
		}
		const email = channelPrincipalEmail(channel.name);
		const outcome = yield* database
			.execute(EffectId.make(`${effectId}:channel-principal:${channel.name}`), {
				_tag: 'Query',
				/**
				 * Team row then account, in one statement, so a principal never exists in a half-state
				 * where the account is placed in a team that is not there.
				 *
				 * The team is guarded by a folded `not exists` for the reason `reconcileApproverTeams`
				 * gives: the unique index on `name` is case-sensitive while every team comparison in this
				 * runtime is folded, so `on conflict` would let two spellings mint two rows and make which
				 * one a subject resolved to an accident of typing.
				 *
				 * The team insert names `norbital_id` and `name` and nothing else. It named `inherits`
				 * too until that column was dropped, when descent became unconditional — so the whole
				 * statement failed, the `catch` below turned it into a log line, and every channel in
				 * every workspace silently refused inbound messages. Raw SQL is invisible to the
				 * typechecker, so dropping a column means grepping for its name.
				 *
				 * The account conflicts on `email`, which is unique, so re-activating is a no-op. It does
				 * *not* update `team_id` on conflict: an operator who deliberately moved a principal has
				 * made a decision, and a deploy silently moving it back is the kind of correction nobody
				 * asked for. The team is set when the row is minted and belongs to whoever holds it after.
				 */
				sql: `with placed as (
				        insert into bolt_team ("norbital_id", "name")
				        select gen_random_uuid(), $1::text
				         where not exists (select 1 from bolt_team where lower("name") = lower($1::text))
				     returning "norbital_id"
				      ), resolved as (
				        select "norbital_id" from placed
				         union all
				        select "norbital_id" from bolt_team where lower("name") = lower($1::text)
				         limit 1
				      )
				      insert into bolt_auth_user ("name", "email", "emailVerified", "kind", "status", "tenantId", "team_id")
				      select $2::text, $3::text, false, 'service', 'normal', $4::text, (select "norbital_id" from resolved)
				      on conflict ("email") do nothing
				  returning "norbital_id"`,
				parameters: [team, `${channel.name} channel agent`, email, tenantId]
			})
			.pipe(
				Effect.catch((failure) =>
					Effect.logWarning(
						`activation: could not reconcile the principal for channel "${channel.name}": ${failure.message}. ` +
							'The channel will refuse inbound messages until it has one.'
					).pipe(Effect.as(undefined))
				)
			);
		if (outcome !== undefined && outcome.rows[0] !== undefined) {
			created.push(channel.name);
			yield* Effect.logInfo(
				`activation: created the principal for channel "${channel.name}" in team "${team}", holding policy "${channel.policy}"`
			);
		}
	}
	return created;
});

export * as ChannelPrincipal from './channel-principal.js';

/**
 * The subject one channel turn runs as, given the channel's principal and whoever the sender
 * turned out to be.
 *
 * This is the whole of the rule, in one place, because it is the rule that must not be got wrong:
 *
 * - **Capability is the principal's, always.** `team` and `teamPath` are the only fields
 *   `AccessControl` resolves policies from, and they are copied from the principal whether or not a
 *   sender was matched. That is what makes the channel's declared `policy` the ceiling for
 *   everybody — a linked contractor who administers the web app reaches exactly what an anonymous
 *   sender reaches, no more.
 * - **Identity is the sender's, and only narrows.** `userId` becomes the matched account's, so a
 *   grant carrying `${requestor.norbital_id}` resolves to that person and returns *their* rows where
 *   the bare principal would match none. A narrowing, never a widening.
 * - **`admin` is dropped.** `AccessControl` short-circuits on `subject.admin` before it consults a
 *   single policy, so carrying an administrator's flag across would make their phone a skeleton key
 *   for the channel — the one field that could defeat both rules above in a single hop.
 *
 * Extracted from `Channels.receive` rather than left inline so it can be asserted on directly. An
 * invariant that can only be tested by running an agent turn is an invariant that gets tested once.
 */
export const channelSubject = (
	principal: Identity.Subject,
	linked: Readonly<{ readonly userId: string; readonly email?: string }> | undefined
): Identity.Subject =>
	linked === undefined
		? principal
		: {
				...principal,
				userId: linked.userId,
				admin: false,
				...(linked.email === undefined ? {} : { email: linked.email })
			};
