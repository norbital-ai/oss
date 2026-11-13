// The inbound trust boundary is shared by every conversation driver and custom conversation.
import { Effect, Option, Predicate, Schema } from 'effect';
import type { RowData } from '../contracts.ts';

const tolerant = <S extends Schema.Constraint>(schema: S) =>
	Schema.optionalKey(Schema.catchDecoding<S>(() => Effect.succeedNone)(schema));
const Attachment = Schema.Struct({
	id: Schema.optionalKey(Schema.NonEmptyString),
	name: Schema.NonEmptyString,
	mime: Schema.NonEmptyString,
	bytes: Schema.Natural,
	bin: Schema.optionalKey(Schema.Natural)
});
const Participant = Schema.Struct({ handle: Schema.NonEmptyString, name: tolerant(Schema.String) });
const From = Schema.Struct({
	address: tolerant(Schema.NonEmptyString),
	handle: tolerant(Schema.NonEmptyString),
	name: tolerant(Schema.NonEmptyString)
});
/** Provider input is decoded once at ingest; invalid optional metadata has the previous absent-field meaning. */
export const InboundMessage = Schema.Struct({
	id: Schema.NonEmptyString,
	sent_at: tolerant(Schema.NonEmptyString),
	source_at: tolerant(Schema.NonEmptyString),
	thread: tolerant(Schema.NonEmptyString),
	from: tolerant(From),
	text: tolerant(Schema.String),
	reply_to: tolerant(Schema.NonEmptyString),
	group: tolerant(Schema.Boolean),
	deleted: tolerant(Schema.Boolean),
	version: tolerant(Schema.NonEmptyString),
	invocation: tolerant(Schema.Literals(['direct', 'mention', 'reply', 'ambient'])),
	title: tolerant(Schema.NonEmptyString),
	attachments: tolerant(Schema.Array(Schema.Unknown)),
	participants: tolerant(Schema.Array(Schema.Unknown)),
	mentions: tolerant(Schema.Array(Schema.Unknown)),
	headers: tolerant(Schema.Record(Schema.String, Schema.Json))
});
const Normalized = Schema.Struct({
	id: Schema.String,
	thread: Schema.String,
	sent_at: Schema.String,
	source_at: Schema.NullOr(Schema.String),
	sender: Schema.String,
	sender_name: Schema.NullOr(Schema.String),
	text: Schema.String,
	reply_to: Schema.NullOr(Schema.String),
	group: Schema.Boolean,
	invocation: Schema.Literals(['direct', 'mention', 'reply', 'ambient']),
	version: Schema.String,
	deleted: Schema.Boolean,
	history: Schema.Boolean,
	attachments: Schema.Array(Attachment),
	mentions: Schema.Array(Schema.String),
	title: Schema.NullOr(Schema.String),
	participants: Schema.optionalKey(
		Schema.Array(Schema.Struct({ handle: Schema.String, name: Schema.NullOr(Schema.String) }))
	),
	email: Schema.NullOr(Schema.Record(Schema.String, Schema.Json)),
	references: Schema.Array(Schema.String)
});
export type Inbound = typeof Normalized.Type;
const iso = (value: string | undefined): string | null =>
	value === undefined || Number.isNaN(Date.parse(value)) ? null : new Date(value).toISOString();
const sourceInstant = (value: string | undefined): string | null => {
	if (value === undefined) return null;
	// a source instant names its zone or offset
	return /(Z|[+-]\d{2}:?\d{2})$/i.test(value) ? iso(value) : null;
};
const attachment = Schema.decodeUnknownOption(Attachment),
	participant = Schema.decodeUnknownOption(Participant);

/** Pure normalization uses the ingest instant for sparse provider revokes. */
export function normalizeInbound(
	kind: 'chat' | 'email',
	raw: typeof InboundMessage.Type,
	original: RowData,
	history: boolean,
	now: string
): Inbound | null {
	const sent_at = iso(raw.sent_at),
		thread = raw.thread ?? null;
	if (raw.deleted === true && (thread === null || sent_at === null))
		return {
			id: raw.id,
			thread: '',
			sent_at: sent_at ?? now,
			source_at: sourceInstant(raw.source_at),
			sender: '',
			sender_name: null,
			text: '',
			reply_to: null,
			group: false,
			invocation: 'ambient',
			version: sent_at ?? now,
			deleted: true,
			history,
			attachments: [],
			mentions: [],
			email: null,
			references: [],
			title: null
		};
	if (sent_at === null) return null;
	const attachments = (raw.attachments ?? []).flatMap((value) => Option.toArray(attachment(value)));
	const participants = raw.participants?.flatMap((value) =>
		Option.toArray(participant(value)).map((person) => ({
			handle: person.handle,
			name: person.name ?? null
		}))
	);
	const facts = {
		...(participants === undefined ? {} : { participants }),
		sent_at,
		source_at: sourceInstant(raw.source_at),
		version: iso(raw.version) ?? sent_at,
		deleted: raw.deleted === true,
		history,
		attachments
	};
	if (kind === 'email') {
		const address = raw.from?.address;
		if (address === undefined) return null;
		const headers = raw.headers ?? {},
			chain = String(headers['references'] ?? '')
				.split(/\s+/)
				.filter((value) => value !== '');
		const references = [
			...new Set([String(headers['in-reply-to'] ?? ''), ...chain].filter((value) => value !== ''))
		];
		const {
			attachments: _a,
			invocation: _i,
			version: _v,
			deleted: _d,
			history: _h,
			group: _g,
			...email
		} = original;
		return {
			id: raw.id,
			thread: thread ?? chain[0] ?? references[0] ?? raw.id,
			sender: address.toLowerCase(),
			sender_name: raw.from?.name ?? null,
			text: raw.text ?? '',
			reply_to: null,
			group: false,
			invocation: 'direct',
			email,
			references,
			mentions: [],
			title: null,
			...facts
		};
	}
	const sender = raw.from?.handle;
	if (sender === undefined || thread === null) return null;
	const group = raw.group === true,
		invocation = !group
			? 'direct'
			: raw.invocation === 'mention' || raw.invocation === 'reply'
				? raw.invocation
				: 'ambient';
	return {
		id: raw.id,
		thread,
		sender,
		sender_name: raw.from?.name ?? null,
		text: raw.text ?? '',
		reply_to: raw.reply_to ?? null,
		group,
		invocation,
		mentions: (raw.mentions ?? []).filter(Predicate.isString),
		email: null,
		references: [],
		title: group ? (raw.title ?? null) : null,
		...facts
	};
}
