// An administrator's paged view of an integration instance's messages and delivery timeline.
import { Effect } from 'effect';
import type { Authority } from '../../engine/contracts.ts';
import type { TenantDbShape } from '../../engine/db/tenant-db.ts';
import { readInstanceMessages } from '../../engine/conversations/history.ts';
import { requireAdmin } from '../../engine/identity/session.ts';

/**
 * An instance's raw messages: every inbound and outbound `sys_message` on it, newest first, a page of
 * 100 before `seq`; an administrator's, like the rest of Settings.
 */
export const instance_messages = Effect.fn('shell.instance_messages')(function* (
	db: TenantDbShape,
	auth: Authority,
	instance: string,
	before?: string
) {
	yield* requireAdmin(auth);
	return yield* readInstanceMessages(db, instance, before);
});
