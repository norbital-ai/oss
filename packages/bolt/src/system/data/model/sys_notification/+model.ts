// A notice (L-BOLT-354/356): one row per inbox member it reaches, or one per notice on another channel. `once`
// dedupes (an `on conflict` arbiter). The delivery and push triggers are the engine's (`engine/schema/engine.ts`).
// A member's inbox; written by the `bolt.notify` run and `ctx.notify`.
import { bind_model } from '../../../../declarations.ts';

export default bind_model('sys_notification')({
	description:
		'A notification: its recipient, title, body, attachments and link, and when its member read it.',
	record_label: 'record.title',
	fields: {
		recipient: { kind: 'json' },
		title: { kind: 'text' },
		body: { kind: 'text', optional: true },
		link: { kind: 'json', optional: true },
		/** Its files: `FileRef`s, and documents (`{ document, to, name }`) converted at delivery. */
		attachments: { kind: 'json', default: [] },
		once: { kind: 'text', optional: true, unique: true },
		at: { kind: 'instant' },
		member: { kind: 'text', optional: true },
		read_at: { kind: 'instant', optional: true }
	},
	table: {
		primary: 'text'
	},
	outputs: { default: { fields: 'all' } },
	indexes: { by_member_at: { on: ['member', 'at'], where: { member: { is_null: false } } } }
});
