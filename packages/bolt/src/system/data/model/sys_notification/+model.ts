// A notice (L-BOLT-354/356): one row per inbox member it reaches, or one per notice on another channel. `once`
// dedupes (an `on conflict` arbiter). The delivery and push triggers are the engine's (`engine/schema/engine.ts`).
import { model } from '../../../../decl/model.ts';

export default model({
	description: 'A notification: its recipient, title, body and link, and when its member read it.',
	label: 'title',
	fields: {
		recipient: { kind: 'json' },
		title: { kind: 'text' },
		body: { kind: 'text', optional: true },
		link: { kind: 'json', optional: true },
		once: { kind: 'text', optional: true, unique: true },
		at: { kind: 'instant' },
		member: { kind: 'text', optional: true },
		read_at: { kind: 'instant', optional: true },
	},
	table: { primary: 'text', indexes: [{ on: ['member', 'at'], where: { member: { isNull: false } } }] },
});
