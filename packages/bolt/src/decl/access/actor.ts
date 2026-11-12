// `Actor` (§3.9): who a request runs as. Members hold their authored team policies; the others are static.
import type { AppName, AutomationName, TeamName } from '../names.ts';
import type { Id, RecordRef } from '../values.ts';

/** A transport address of an outside sender (a phone number, a Telegram id, an email address). */
export type Handle = string;
// ponytail: the platform automations named in §4.5 and §5.11.3; the runs area owns the closed list.
/**
 * A platform automation a `system` actor can run as: notification delivery,
 * membership sync, embedding and pure index backfill.
 */
export type PlatformAutomation =
	'notifications.deliver' | 'bolt.membership' | 'bolt.embed' | 'bolt.index';

type Member = {
	kind: 'member';
	id: Id<'sys_user'>;
	email: string | null;
	phone: string | null;
	external: boolean;
	teams: readonly TeamName[];
	team_path: readonly string[];
	admin: boolean;
	party: RecordRef | null;
};

/**
 * Who a request runs as (§3.9), discriminated by `kind`: a `member` (with teams and admin), an `envoy` answering a sender on
 * the instance it is deployed on, a public `visitor` of an app, an `api_key`, or the `system` running an automation, a
 * remote sync's read or write for one instance (`'<model>.sync.<sync>'`: the engine never sends a sync's own writes back
 * through it), or a platform run. `system` is the one reserved identity of the platform's own work: an automation run is
 * it, holding the automation's `policies` whoever started it (who did is the run's `trigger`, `ctx.run.trigger`), and
 * its `requestor.*` operands name no member, party or team, so a requestor-scoped grant matches nothing.
 */
export type Actor =
	| Member
	| {
			kind: 'envoy';
			envoy: Id<'sys_envoy'>;
			instance: Id<'sys_integration'>;
			sender: Handle;
			member: Id<'sys_user'> | null;
			linked?: Member;
	  } // P32: the linked sender, either audience
	| { kind: 'visitor'; app: AppName; visitor: string; anonymous?: true }
	| { kind: 'api_key'; key: Id<'sys_api_key'> }
	| {
			kind: 'system';
			run: Id<'sys_run'>;
			by:
				| { automation: AutomationName }
				| { platform: PlatformAutomation }
				| { sync: `${string}.sync.${string}`; instance: Id<'sys_integration'> };
	  };
