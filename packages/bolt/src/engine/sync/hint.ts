// The sync inbox (spec §3.1 "Webhooks need no code"): what reaches a remote sync's next `read` as `deliveries` — a
// verified webhook delivery, an inbound message of a conversation instance, or a provider's report on a message a sync's
// `write` sent — is stored as `sys_inbox` rows, one per read sync over the instance's definition, deduplicated by the
// delivery id (a delivery sent twice is stored once), and is a hint: the statement that stores it queues one read of each
// such sync for the instance, debounced (a queued one absorbs the rest of a burst). The read consumes the rows in the act
// that commits its page. A lost webhook is caught up by the next scheduled read; webhooks only make it sooner.
import { Clock, Effect } from 'effect';
import type { WebhookDelivery } from '../../decl/runtime/integration.ts';
import { BoltError } from '../../protocol/errors.ts';
import type { EngineManifest } from '../manifest.ts';
import { enqueue } from '../runs/queue.ts';
import { iso } from '../runs/time.ts';
import { Chain } from '../write/sql.ts';
import { instancesOf } from '../integrations/instances.ts';
import { syncsOf, type SyncEngine } from './index.ts';

/** How long a hint waits for the rest of its burst before its read runs. */
const DEBOUNCE_MS = 2_000;
/** The read syncs over `definition`, by run name. */
const readers = (m: EngineManifest, definition: string): readonly string[] =>
	[...syncsOf(m).values()].filter((s) => s.read && s.definition === definition).map((s) => s.name);
/** The debounced read of each sync the CTE `stored` (column `sync`) stored a new delivery for. */
const readSoon = (c: Chain, stored: string, instance: string, now: string) => {
	const input = `jsonb_build_object('instance', ${c.p(instance)}::text)`;
	enqueue(c, {
		select: `SELECT DISTINCT x.sync AS automation, ${input} AS input, ${c.p(iso(Date.parse(now) + DEBOUNCE_MS))}::timestamptz AS due_at,
			'provider'::text AS cause, 0 AS depth FROM ${stored} x
		WHERE NOT EXISTS (SELECT 1 FROM sys_run r WHERE r.automation = x.sync AND r.state = 'queued' AND r.input = ${input})`
	});
};
/**
 * The statement piece that stores deliveries for `instance` of `definition`: `source` selects `(delivery text, body
 * jsonb)` rows; each read sync over the definition gets its own copy. Build it only when a read sync needs it, so a
 * skipped piece allocates no statement parameters. `name` names the piece's CTE.
 */
export function inboxPiece(
	m: EngineManifest,
	c: Chain,
	name: string,
	instance: string,
	definition: string,
	source: () => string,
	now: string
): void {
	const syncs = readers(m, definition);
	if (syncs.length === 0) return;
	const rows = source();
	readSoon(
		c,
		c.cte(
			name,
			`INSERT INTO sys_inbox (id, sync, instance, delivery, received_at, body)
			SELECT gen_random_uuid(), s.sync, ${c.p(instance)}, d.delivery, ${c.p(now)}::timestamptz, d.body
			FROM jsonb_array_elements_text(${c.p(syncs)}::jsonb) AS s(sync) CROSS JOIN (${rows}) d
			ON CONFLICT (sync, instance, delivery) DO NOTHING RETURNING sync`
		),
		instance,
		now
	);
}
/**
 * A provider's report (`event`, a `DeliveryEvent` of `kind`) on message `message` of `instance`: stored for each read sync whose
 * `write` sent that message (its id map holds it as the remote id).
 */
export function reportRowsPiece(
	m: EngineManifest,
	c: Chain,
	source: () => string,
	now: string
): void {
	const syncs = [...syncsOf(m).values()].filter((s) => s.read && s.write).map((s) => s.name);
	if (syncs.length === 0) return;
	const rows = source();
	const stored = c.cte(
		'report_inbox',
		`INSERT INTO sys_inbox (id, sync, instance, delivery, received_at, body)
		SELECT gen_random_uuid(), r.sync, r.instance, d.delivery, ${c.p(now)}::timestamptz, d.body
		FROM (${rows}) d JOIN sys_sync_row r ON r.instance = d.instance AND r.remote_id = d.message
		WHERE r.sync IN (SELECT jsonb_array_elements_text(${c.p(syncs)}::jsonb))
		ON CONFLICT (sync, instance, delivery) DO NOTHING RETURNING sync, instance`
	);
	enqueue(c, {
		select: `SELECT DISTINCT x.sync AS automation, jsonb_build_object('instance', x.instance) AS input,
		${c.p(iso(Date.parse(now) + DEBOUNCE_MS))}::timestamptz AS due_at, 'provider'::text AS cause, 0 AS depth FROM ${stored} x
		WHERE NOT EXISTS (SELECT 1 FROM sys_run r WHERE r.automation = x.sync AND r.state = 'queued' AND r.input = jsonb_build_object('instance', x.instance))`
	});
}
export function makeHint(e: SyncEngine) {
	return {
		/** A verified webhook delivery for `instance`: stored and hinted in one statement, then the wake. */
		hint: Effect.fn('Syncs.hint')(function* (instance: string, delivery: WebhookDelivery) {
			const [inst] = yield* instancesOf(e.manifest, e.db, { ids: [instance] });
			if (inst === undefined)
				return yield* Effect.fail(
					BoltError.make('notFound', 'decode', `No integration instance '${instance}'.`)
				);
			const now = iso(yield* Clock.currentTimeMillis),
				c = new Chain();
			inboxPiece(
				e.manifest,
				c,
				'hint_inbox',
				instance,
				inst.integration,
				() => `SELECT ${c.p(delivery.id)}::text AS delivery, ${c.p(delivery)}::jsonb AS body`,
				now
			);
			// health compares hints with what reads find ("webhooks quiet while reads find changes")
			c.cte(
				'hinted',
				`UPDATE sys_sync SET last_hint_at = ${c.p(now)}::timestamptz WHERE instance = ${c.p(instance)}
				AND sync IN (SELECT jsonb_array_elements_text(${c.p(readers(e.manifest, inst.integration))}::jsonb)) RETURNING 1`
			);
			yield* e.db.write(c.sql('NULL AS outcome'));
			yield* e.announce(iso(Date.parse(now) + DEBOUNCE_MS));
		})
	};
}
