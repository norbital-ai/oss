// A message (§5.9 "messages are rows"): the transcript, the queue and an integration instance's history are these rows.
// `seq` is the database's order; the inbound (provider_id … addressed) and outbound (status … epoch) columns are the
// conversations area's. An outbound rule's row (`rule` `<definition>.<rule>`, `record`) is keyed once per record and
// version (`key`), and records the payload hash it sent (`hash`): a `message` to a conversation or a `command`.
import { model } from '../../../decl/model.ts';

export default model({
	description:
		'A message in a conversation: a transcript step, a queued input, or an integration message in or out.',
	label: 'preview',
	fields: {
		created_at: { kind: 'instant', default: { now: '' } },
		conversation: { kind: 'text', optional: true },
		seq: { kind: 'int' },
		role: { kind: 'text', optional: true },
		content: { kind: 'json', optional: true },
		preview: { kind: 'text', optional: true },
		text: { kind: 'text', optional: true },
		state: { kind: 'text', optional: true },
		mode: { kind: 'text', optional: true },
		as: { kind: 'json', optional: true },
		author: { kind: 'text', optional: true },
		meta: { kind: 'json', optional: true },
		supersedes: { kind: 'text', optional: true },
		turn: { kind: 'text', optional: true },
		read_by: { kind: 'text', optional: true },
		delivered_turn: { kind: 'text', optional: true },
		about: { kind: 'json', optional: true },
		direction: { kind: 'text', optional: true },
		origin: { kind: 'text', optional: true },
		provider_id: { kind: 'text', optional: true },
		version: { kind: 'text', optional: true },
		sender: { kind: 'text', optional: true },
		sender_name: { kind: 'text', optional: true },
		sent_at: { kind: 'instant', optional: true },
		/** Provider-authoritative receive/source instant, independent of a message's authored date. */
		source_at: { kind: 'instant', optional: true },
		invocation: { kind: 'text', optional: true },
		addressed: { kind: 'bool', optional: true },
		refused: { kind: 'text', optional: true },
		email: { kind: 'json', optional: true },
		reply_to: { kind: 'text', optional: true },
		deleted_at: { kind: 'instant', optional: true },
		edited_at: { kind: 'instant', optional: true },
		status: { kind: 'text', optional: true },
		attempts: { kind: 'int', default: 0 },
		next_attempt_at: { kind: 'instant', optional: true },
		claimed_at: { kind: 'instant', optional: true },
		error: { kind: 'text', optional: true },
		record: { kind: 'json', optional: true },
		rule: { kind: 'text', optional: true },
		key: { kind: 'text', optional: true, unique: true },
		hash: { kind: 'text', optional: true },
		class: { kind: 'enum', values: ['message', 'command'], optional: true },
		message: { kind: 'json', optional: true },
		thread: { kind: 'text', optional: true },
		epoch: { kind: 'text', optional: true },
		/** The delivery timeline (§5.9): `DeliveryEntry[]`, oldest first. */
		delivery: { kind: 'json', default: [] },
		/** When a sent message with no report yet counts as delivered, presumed (the provider's quiet window). */
		presume_at: { kind: 'instant', optional: true }
	},
	index: [
		['conversation', 'seq'],
		['integration', 'provider_id']
	],
	table: {
		primary: 'text',
		identity: 'seq',
		indexes: [
			{ on: ['conversation'], where: { state: { eq: 'queued' } } },
			{ on: ['conversation'], where: { state: { eq: 'pending' } } },
			{ on: ['seq'], where: { status: { in: ['queued', 'sending'] } } }
		]
	}
});
