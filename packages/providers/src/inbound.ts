// One inbound chat message as a chat provider hands it to the engine (a `messages` event, `decodeInbound` on the other
// side): what the provider read, with the `invocation` the engine routes it by derived here, once, for every provider.
import type { Attachment } from '@norbital-ai/bolt';

/** What a chat provider knows of one message. */
export type ChatMessage = {
	readonly id: string;
	readonly thread: string;
	readonly sent_at: string;
	readonly from: { readonly handle: string; readonly name: string | null };
	readonly text: string;
	readonly reply_to: string | null;
	readonly group: boolean;
	/** `bin`: the index of the file's bytes in the event's `bins`. */
	readonly attachments: readonly (Attachment & { readonly bin?: number })[];
	/** It names this link's account (an @-mention). */
	readonly mentioned: boolean;
	/** It answers a message this link's account sent. */
	readonly replied_to: boolean;
	/** The ids it named as mentions, as the provider sent them. */
	readonly mentions?: readonly string[];
	/** A group chat's own name, when the provider says it. */
	readonly title?: string | null;
	readonly participants?: readonly { readonly handle: string; readonly name: string | null }[];
	/** Edit order: an edited message's own instant. */
	readonly version?: string;
	/** The sender revoked it. */
	readonly deleted?: boolean;
};
export type Invocation = 'direct' | 'mention' | 'reply' | 'ambient';

/** A direct message always invokes; in a group, a mention or a reply to this account does, anything else is ambient. */
export const inbound = ({
	mentioned,
	replied_to,
	...message
}: ChatMessage): Omit<ChatMessage, 'mentioned' | 'replied_to'> & {
	readonly invocation: Invocation;
} => ({
	...message,
	invocation: !message.group ? 'direct' : mentioned ? 'mention' : replied_to ? 'reply' : 'ambient'
});
