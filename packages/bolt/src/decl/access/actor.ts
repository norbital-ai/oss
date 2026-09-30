// `Actor` (§3.9): who a request runs as. Members hold their teams' and assignments' policies; the others are static.
import type { AppName, AutomationName, ChannelName, CollectionName, EnvoyName, TeamName } from '../names.ts';
import type { Id, RecordRef } from '../values.ts';

/** A transport address of an outside sender (a phone number, a Telegram id, an email address). */
export type Handle = string;
// ponytail: the platform automations named in §4.5 and §5.11.3; the runs area owns the closed list.
/**
 * A platform automation a `system` actor can run as: resuming and discarding held writes, notification delivery, membership sync and embedding.
 */
export type PlatformAutomation = 'collections.resume' | 'collections.discard' | 'notifications.deliver' | 'bolt.membership' | 'bolt.embed';

/**
 * Who a request runs as (§3.9), discriminated by `kind`: a `member` (with teams and admin), an `envoy` answering a channel sender,
 * a public `visitor` of an app, an `apiKey`, or the `system` running an automation, integration or platform run.
 */
export type Actor =
	| { kind: 'member'; id: Id<'sys_user'>; email: string | null; phone: string | null; external: boolean; teams: readonly Id<'sys_team'>[];
		teamPath: readonly TeamName[]; admin: boolean; party: RecordRef | null }
	| { kind: 'envoy'; envoy: EnvoyName; channel: ChannelName; sender: Handle; member: Id<'sys_user'> | null } // P32: the linked sender, either audience
	| { kind: 'visitor'; app: AppName; visitor: string }
	| { kind: 'apiKey'; key: Id<'sys_api_key'> }
	| { kind: 'system'; run: Id<'sys_run'>;
		by: { automation: AutomationName } | { integration: CollectionName } | { platform: PlatformAutomation } };
