/**
 * The transcript follows its own tail.
 *
 * A conversation grows at the bottom while the reader looks at the bottom. Nothing in the sync
 * path or the projection moves the scrollport, so once the transcript is taller than the panel
 * every new row lands below the fold and the panel looks frozen. The rule is
 * the one every chat surface uses: a reader at the end stays at the end as content arrives; a reader
 * who scrolled up to reread is left alone until they return to the end, switch conversation, or
 * send a message of their own.
 */
import { Schema } from 'effect';
import type { PanelMessage } from './transcript.js';

/** What the follower reads of a scrollport, and the one thing it writes. */
export type Scrollport = Readonly<{
	scrollHeight: number;
	clientHeight: number;
}> & { scrollTop: number };

/**
 * How far above the end a reader still counts as reading the end. A fractional layout leaves
 * sub-pixel remainders, and a row's bottom margin is not "scrolled up".
 */
export const TAIL_SLACK_PX = 32;

export const atTail = (port: Scrollport): boolean =>
	port.scrollHeight - port.clientHeight - port.scrollTop <= TAIL_SLACK_PX;

export type TailFollower = Readonly<{
	/** Whether the next growth will be followed; read for tests and affordances. */
	readonly pinned: boolean;
	/** Records where the reader is. Wire it to the scrollport's scroll event. */
	observe: () => void;
	/** Pins the view to the end regardless of where the reader was: a conversation switch, an own send. */
	pin: () => void;
	/** Moves to the end when the reader was there before the content grew; otherwise does nothing. */
	follow: () => void;
}>;

export function createTailFollower(port: () => Scrollport | null): TailFollower {
	let pinned = true;
	return {
		get pinned() {
			return pinned;
		},
		observe: () => {
			const current = port();
			if (current !== null) pinned = atTail(current);
		},
		pin: () => {
			pinned = true;
		},
		follow: () => {
			const current = port();
			if (current === null || !pinned) return;
			current.scrollTop = current.scrollHeight;
		}
	};
}

const isString = Schema.is(Schema.String);

/**
 * A cheap fingerprint of the transcript's tail. It changes whenever something the reader would
 * want to see arrives: a new row, a new part on the streaming row, more text in the part being
 * written, a settled generation, or the reader's own pending submission.
 */
export const transcriptTailSignature = (
	messages: readonly PanelMessage[],
	pendingAdmission: boolean
): string => {
	const last = messages.at(-1);
	if (last === undefined) return `0:${pendingAdmission}`;
	const content = last.message.content;
	const shape = isString(content)
		? `s${content.length}`
		: `${content.length}:${content.reduce(
				(total, part) => total + ('text' in part ? part.text.length : 0),
				0
			)}`;
	const generation = last.annotation?.tag === 'generation' ? last.annotation.sequence : 'settled';
	return `${messages.length}:${last.key}:${shape}:${generation}:${pendingAdmission}`;
};
