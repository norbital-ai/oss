// `channel()` (§3.3.8, rule 61): a transport plus an address. Record-driven outbound and delivery events are pure
// functions of their argument, typed from the `from` collection and the transport.
import type { Handle } from '../access/actor.ts';
import type { Patch } from '../ctx.ts';
import type { CollectionName, PolicyName, Row } from '../names.ts';
import type { FileRef, Id, Instant, RecordRef } from '../values.ts';
import type { Transport } from './names.ts';

export type Attachment = { readonly file: FileRef; readonly fileName: string; readonly mimeType: string; readonly byteLength: number };
type Address = { readonly address: string; readonly name: string | null };
/** An inbound email (GAP-C1: the full text and headers). */
export type InboundMail = {
	readonly id: string; readonly thread: string | null; readonly sentAt: Instant; readonly from: Address; readonly replyTo: Address | null;
	readonly to: readonly Address[]; readonly cc: readonly Address[]; readonly subject: string; readonly text: string;
	readonly html: string | null; readonly headers: { readonly [name: string]: string }; readonly attachments: readonly Attachment[];
};
/** An inbound WhatsApp or Telegram message. `thread` is the chat; `replyTo` the message it answers. */
export type InboundChat = {
	readonly id: string; readonly thread: string; readonly sentAt: Instant; readonly from: { readonly handle: Handle; readonly name: string | null };
	readonly replyTo: string | null; readonly text: string; readonly attachments: readonly Attachment[];
};
export type Inbound<T> = T extends 'email' ? InboundMail : T extends 'whatsapp' | 'telegram' ? InboundChat : never;

type Common = { replyTo?: string; about?: RecordRef };
/** What `ctx.send` and an `outbound.message` produce for a transport. `inbox` takes notices (`ctx.notify`), not messages. */
export type OutboundFor<T> = T extends 'email'
	? Common & { to: readonly string[]; cc?: readonly string[]; subject: string; html?: string; text?: string;
		/** The correlation id replies are matched back to. */ thread?: string;
		attachments?: readonly (FileRef | { name: string; mime: string; base64: string })[] }
	: T extends 'whatsapp' | 'telegram' ? Common & { to: Handle | Id<'sys_conversation'>; text: string; attachments?: readonly FileRef[] }
	: never;

export type DeliveryKind = 'sent' | 'delivered' | 'opened' | 'bounced' | 'failed' | 'replied';
/**
 * What a channel's delivery handler receives for event `E`: when, which message, and a bounce reason or the reply.
 */
export type DeliveryEvent<E, T = 'email'> = { readonly at: Instant; readonly message: Id<'sys_message'> }
	& (E extends 'bounced' | 'failed' ? { readonly reason: string }
		: E extends 'replied' ? T extends 'email' ? { readonly mail: InboundMail } : { readonly reply: Inbound<T> } : {});

// Callbacks sit inside this literal, so it is typed by inference sites (the transport `T`, each outbound's `from`
// collection in `O`), never by a `Checked` wrapper: a wrapper would hide the contextual type from the callbacks.
type Outbound<T, O> = { [N in keyof O]: { from: O[N]; on: 'create'; message: (x: { record: Row<O[N]> }) => OutboundFor<T> } };
type Events<T, C> = [C] extends [never] ? 'error: events are mapped onto rows `outbound` sends; declare outbound'
	: { [E in DeliveryKind]?: (e: DeliveryEvent<E, T>) => Patch<C> };
export type ChannelSpec<T = Transport, O = {}> = {
	transport: T;
	/** email: the local part on the workspace domain. */
	address?: string;
	/** The authority of the channel's own writes (delivery events, inbound rows). */
	policies?: readonly PolicyName[];
	outbound?: Outbound<T, O>;
	/** Mapped back onto the sending row through its collection's pipeline, as the channel's actor. */
	events?: Events<T, O[keyof O]>;
};

/**
 * `src/channel/+<c>.channel.ts`: a messaging channel on a transport (`email`, `whatsapp`, `telegram`), with optional
 * collection-backed `outbound` messages and delivery `events`. Envoys answer on it; notifications may be sent through it.
 * @example
 * export default channel({ transport: 'telegram' });
 */
export function channel<const T extends Transport, const O extends { readonly [name: string]: CollectionName } = {}>(spec: ChannelSpec<T, O>): ChannelSpec<T, O> {
	return spec;
}
