// A verified webhook delivery (spec §3): a hint that a sync's next read has news, or the data itself for a provider with
// no list API; passed to the sync's `read` as a delivery and marked consumed by the act that read it. Deduplicated by the
// provider's delivery id per instance, so a delivery sent twice is stored once. Engine only: not exposed.
import { model } from '../../../../decl/model.ts';

export default model('sys_inbox', {
	description: "A webhook delivery received for an integration instance, awaiting its sync's read.",
	label: 'delivery',
	fields: {
		sync: { kind: 'text' },
		instance: { kind: 'ref', to: 'sys_integration', onDelete: 'cascade' },
		/** The provider's delivery id (`webhook-id`, `svix-id`, …). */
		delivery: { kind: 'text' },
		received_at: { kind: 'instant' },
		headers: { kind: 'json', optional: true },
		body: { kind: 'json', optional: true },
		consumed_at: { kind: 'instant', optional: true }
	},
	unique: [{ fields: ['sync', 'instance', 'delivery'] }],
	table: {
		primary: 'uuid',
		indexes: [{ on: ['sync', 'instance', 'received_at'], where: { consumed_at: { isNull: true } } }]
	}
});
