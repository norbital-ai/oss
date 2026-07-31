import { and, eq, getColumns, inArray, lte, or, sql } from 'drizzle-orm';
import { notification_outbox } from '@norbital-ai/platform-utils/system/workspace-schema';
import { getWorkspace } from '$lib/server/bootstrap/workspace_store.js';

const CLAIM_LEASE_MS = 5 * 60 * 1000;

export type NotificationOutboxRequest =
	| { readonly kind: 'notification'; readonly action: 'claim'; readonly limit?: number }
	| { readonly kind: 'notification'; readonly action: 'delivered'; readonly ids: readonly string[] }
	| {
			readonly kind: 'notification';
			readonly action: 'failed';
			readonly ids: readonly string[];
			readonly error: string;
			readonly retryAt: string;
	  };

export async function runNotificationOutbox(request: NotificationOutboxRequest) {
	const db = getWorkspace({ provision: true }).drizzleDb;
	if (!db) throw new Error('Tenant database is not provisioned');
	const columns = getColumns(notification_outbox);
	if (request.action === 'claim') {
		const limit = Math.min(Math.max(request.limit ?? 50, 1), 200);
		// Due-ness is the database's clock, not this process's.
		//
		// `available_at` defaults to the database's `now()`, so comparing it against a `Date` minted
		// here hides a freshly queued row for however far the two clocks disagree — measured at ~130ms
		// between a container and its host. The drain is continuous, so the row went out a tick later
		// and nothing was lost; but "delivered once the clocks agree" is not a property worth keeping
		// when one side of the comparison is all it takes to be rid of it.
		const dbNow = sql`now()`;
		const leaseExpired = sql`now() - make_interval(secs => ${CLAIM_LEASE_MS / 1000})`;
		return db.transaction(async (tx) => {
			const rows = await tx
				.select()
				.from(notification_outbox)
				.where(
					or(
						and(inArray(columns.status, ['pending', 'failed']), lte(columns.available_at, dbNow)),
						and(eq(columns.status, 'processing'), lte(columns.claimed_at, leaseExpired))
					)
				)
				.orderBy(columns.available_at)
				.limit(limit)
				.for('update', { skipLocked: true });
			if (rows.length === 0) return [];
			const ids = rows.map((row) => row.norbital_id);
			await tx
				.update(notification_outbox)
				.set({
					status: 'processing',
					claimed_at: dbNow,
					attempts: sql`${columns.attempts} + 1`
				})
				.where(inArray(columns.norbital_id, ids));
			return rows;
		});
	}
	if (request.ids.length === 0) return { updated: 0 };
	if (request.action === 'delivered') {
		const rows = await db
			.update(notification_outbox)
			.set({ status: 'delivered', delivered_at: new Date(), last_error: null })
			.where(and(inArray(columns.norbital_id, [...request.ids]), eq(columns.status, 'processing')))
			.returning({ id: columns.norbital_id });
		return { updated: rows.length };
	}
	const rows = await db
		.update(notification_outbox)
		.set({
			status: sql`case when ${columns.attempts} >= 10 then 'dead_letter' else 'failed' end`,
			available_at: new Date(request.retryAt),
			last_error: request.error,
			claimed_at: null
		})
		.where(and(inArray(columns.norbital_id, [...request.ids]), eq(columns.status, 'processing')))
		.returning({ id: columns.norbital_id });
	return { updated: rows.length };
}
