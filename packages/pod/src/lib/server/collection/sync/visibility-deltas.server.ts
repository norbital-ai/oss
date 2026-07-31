/**
 * Announce records that became visible without themselves changing.
 *
 * The change feed carries rows that were *written*. Policy visibility does not work that way: a
 * payroll run's payslips become readable the moment the run is approved, and not one of those
 * payslip rows is touched by the approval. Nothing in the feed describes them, so a client holding
 * the collection never learns they exist.
 *
 * The client used to compensate by re-reading collections after every approval — originally all of
 * them, later only the related ones. Both are scans: work proportional to the collection, done by
 * every connected client, to discover a handful of rows. And both are guesses, because the client
 * cannot know which rows changed side.
 *
 * The server can. When an approval releases a record, the records that point at it are exactly the
 * ones whose visibility may have flipped, and the manifest already says which those are. Emitting a
 * feed entry per affected record turns the whole thing back into ordinary delta sync: `buildDiff`
 * re-evaluates each one against each client's own policy and sends `insert` to whoever can now see
 * it and `leave` to whoever cannot. No client scans anything, and no client has to be told to.
 */
import type { ProvisionedContext } from '$lib/server/bootstrap/workspace_store.js';
import { SYSTEM_COLUMN_NAMES } from '@norbital-ai/platform-utils/system/column_names';
import { emitSyncOutboxRow } from './sync-outbox.server.js';
import { quoteSqlIdentifier } from '../sql-identifier.server.js';

/**
 * Most rows a single release may announce.
 *
 * A release that would announce more than this is a schema shape the feed is the wrong tool for —
 * better that those clients re-read the collection than that one approval writes a hundred
 * thousand feed rows and stalls the transaction it is part of. Hitting it is logged rather than
 * silent, because a silent cap is indistinguishable from correct behaviour.
 */
const MAX_ANNOUNCED_PER_RELEASE = 5_000;


/**
 * Every record whose visibility may have changed because `recordId` in `collection` was released,
 * announced on the change feed.
 *
 * Both directions of a relationship count. A payslip points at its run, so releasing the run
 * affects the payslips; a run's rollup can equally be gated on a child, so releasing the child
 * affects the parent. Which side actually flips is a policy question, and `buildDiff` answers it
 * per client — this only has to name the candidates.
 */
export async function announceVisibilityChange(
	ctx: ProvisionedContext,
	collection: string,
	recordId: string
): Promise<number> {
	const pkey = SYSTEM_COLUMN_NAMES.PKEY;
	let announced = 0;

	for (const { rel } of ctx.manifestCtx.getRelationshipsForCollection(collection)) {
		// The related collection, and the column on it that points back at us.
		const related =
			rel.from === collection
				? { table: rel.to, joinColumn: rel.to_fields?.[0], localField: rel.from_fields?.[0] }
				: { table: rel.from, joinColumn: rel.from_fields?.[0], localField: rel.to_fields?.[0] };
		if (!related.table || !related.joinColumn || !related.localField) continue;
		if (related.table === collection) continue; // self-relations announce themselves already

		if (announced >= MAX_ANNOUNCED_PER_RELEASE) break;

		// Rows on the other side joined to this record. `localField` is read off the released row
		// rather than assumed to be its primary key: a relationship may join on any column.
		const affected = await ctx.tenantDb
			.query<{ id: string; version: number | null }>(
				`SELECT other.${quoteSqlIdentifier(pkey)}::text AS id,
				        other.${quoteSqlIdentifier(SYSTEM_COLUMN_NAMES.ROW_VERSION)} AS version
				   FROM ${quoteSqlIdentifier(related.table)} other
				   JOIN ${quoteSqlIdentifier(collection)} released
				     ON other.${quoteSqlIdentifier(related.joinColumn)} = released.${quoteSqlIdentifier(related.localField)}
				  WHERE released.${quoteSqlIdentifier(pkey)} = $1::uuid
				  LIMIT $2`,
				[recordId, MAX_ANNOUNCED_PER_RELEASE - announced]
			)
			.catch(() => ({ rows: [] as { id: string; version: number | null }[] }));

		for (const row of affected.rows) {
			// `update` rather than `insert`: the row existed all along, only its visibility moved.
			// `buildDiff` turns it into whichever of insert/update/leave each client should see.
			await emitSyncOutboxRow(ctx.tenantDb, related.table, 'update', row.id, row.version);
			announced += 1;
		}
	}

	if (announced >= MAX_ANNOUNCED_PER_RELEASE) {
		console.warn(
			`[sync] visibility announcement for ${collection}/${recordId} hit the ${MAX_ANNOUNCED_PER_RELEASE}-row cap; ` +
				`clients holding the affected collections will see the remainder on their next full catch-up`
		);
	}
	return announced;
}
