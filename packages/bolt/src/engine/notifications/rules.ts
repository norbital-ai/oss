// A collection's `notifications` rules (§3.3 "notifications"): the one path from a write or approval event to the notices
// of the statement that caused it (rule 47). Recipients are descriptors or a pure callback; fan-out stays transactional.
import { Effect, Schema } from 'effect';
import type { NotificationEvent } from '../../decl/collection.ts';
import type { Json } from '../../decl/values.ts';
import type { Bindings, EngineActor, NoticeRow, RowData } from '../contracts.ts';
import type { EngineManifest } from '../manifest.ts';
import type { GuestShape } from '../services.ts';
import { BoltError } from '../../protocol/errors.ts';
import { canonical } from '../write/sql.ts';
import { notificationRecipients } from './recipients.ts';

type Text = string | { one: string; many?: string };
const Descriptors = Schema.Array(
	Schema.Union([
		Schema.Literals(['requestor', 'step_approvers']),
		Schema.Record(Schema.String, Schema.NonEmptyString)
	])
);
const text = (t: Text, n: number) =>
	typeof t === 'string'
		? t
		: n > 1 && t.many !== undefined
			? t.many.replaceAll('{count}', String(n))
			: t.one;

export type NoticeEvent = {
	collection: string;
	event: NotificationEvent;
	/** The write's verb or the request's action; a rule's `on.action` filters on the record's own `action`. */
	records: readonly { id: string; values: RowData; action: string }[];
	/** The member who wrote or requested (`requestor`), the step's teams (`step_approvers`). */
	requestor: string | null;
	approvers: readonly string[];
	actor: EngineActor;
	bindings: Bindings;
	/** Each rule's notice id, also its `once` key. */
	id: (rule: number) => string;
	/** The record every notice links to (default: the one record, when one). */
	link?: { collection: string; id: string };
	/** An action's own event, by its name: only rules whose `on.action` names it fire, with or without records (its
	 * generated writes notify as writes). */
	named?: string;
};

/** The notices `e.event` raises through `collection`'s rules for it. */
export const collectionNotices = Effect.fn('Bolt.collectionNotices')(function* (
	guest: GuestShape | undefined,
	m: EngineManifest,
	e: NoticeEvent
) {
	const rules = m.collections[e.collection]?.notifications?.[e.event] ?? [];
	const notices: (NoticeRow & { id: string })[] = [];
	for (const [index, rule] of rules.entries()) {
		const hit =
			e.named === undefined
				? e.records.filter((x) => rule.on?.action?.includes(x.action) ?? true)
				: rule.on?.action?.includes(e.named)
					? e.records
					: null;
		if (hit === null || (e.named === undefined && hit.length === 0)) continue;
		const id = e.id(index);
		const to =
			rule.to === true || typeof rule.to === 'function'
				? yield* notificationRecipients(
						guest,
						m,
						{
							id,
							target: `${e.collection}.${e.event}.${index}`,
							ctx: {
								actor: e.actor,
								now: e.bindings.now,
								today: e.bindings.today,
								tz: e.bindings.tz,
								seed: id
							}
						},
						{
							event: e.event,
							collection: e.collection,
							action: e.named ?? hit[0]?.action ?? '',
							requestor: e.requestor,
							approvers: e.approvers,
							records: hit.map(({ id, values }) => ({ id, values }))
						}
					)
				: [
						...new Map(
							(yield* Schema.decodeUnknownEffect(Descriptors)(rule.to).pipe(
								Effect.mapError((error) =>
									BoltError.make('invalidSpec', 'decode', error.message, error)
								)
							))
								.flatMap((t): Json[] =>
									t === 'requestor'
										? e.requestor === null
											? []
											: [{ user: e.requestor }]
										: t === 'step_approvers'
											? e.approvers.map((team) => ({ team }))
											: 'user' in t
												? hit.flatMap((x) =>
														typeof x.values[t['user']!] === 'string'
															? [{ user: x.values[t['user']!]! }]
															: []
													)
												: [t]
								)
								.map((x) => [canonical(x), x])
						).values()
					];
		const link =
			e.link ?? (hit.length === 1 ? { collection: e.collection, id: hit[0]!.id } : undefined);
		notices.push({
			id,
			once: id,
			to: { channel: rule.channel ?? 'inbox', recipients: to },
			title: text(rule.title, hit.length),
			...(rule.body === undefined ? {} : { body: text(rule.body, hit.length) }),
			...(link === undefined ? {} : { link })
		});
	}
	return notices;
});
