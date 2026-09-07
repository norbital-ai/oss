/**
 * The composer's `/` command menu, kept as pure functions so the keyboard flow can be tested
 * without a DOM.
 *
 * A command is only ever the first thing in a draft: `/plan` and `/compact` are parsed off the
 * start by `parseTaskSlashCommand`, so a `/` anywhere else is prose and opens nothing. The menu is
 * a static list with one row per command; selecting one leaves `/plan ` in the draft and closes.
 */
import type { MentionMenuItem } from './mention-sources.js';

export const COMPOSER_COMMANDS = ['plan', 'compact'] as const;
export type ComposerCommand = (typeof COMPOSER_COMMANDS)[number];

const WHITESPACE = /\s/;

/** Longest name still read as a command search; past it the `/` is prose. */
const COMMAND_QUERY_LIMIT = 12;

/**
 * The `/` trigger owning the caret, if any.
 *
 * Only a `/` at index 0 counts, and only while the caret sits directly after the name being typed:
 * a space after the name means the command is complete and the writer is on to the message, and a
 * caret elsewhere in the draft is editing prose.
 */
export function findCommandTrigger(draft: string, caret: number): { query: string } | null {
	if (draft.charAt(0) !== '/') return null;
	if (caret < 1 || caret > draft.length) return null;
	const query = draft.slice(1, caret);
	if (query.length > COMMAND_QUERY_LIMIT || WHITESPACE.test(query)) return null;
	return { query };
}

/** The static rows for the typed prefix; an empty list means the menu has nothing to offer. */
export function commandMenuItems(query: string): readonly MentionMenuItem[] {
	const needle = query.toLowerCase();
	return COMPOSER_COMMANDS.filter((command) => command.startsWith(needle)).map((command) => ({
		kind: 'composer-command',
		command
	}));
}

/**
 * Replace the live `/query` with the chosen command and one trailing space, so the message that
 * follows keeps its word boundary. Text after the caret is preserved.
 */
export function insertCommand(
	draft: string,
	trigger: { readonly query: string },
	command: ComposerCommand
): { draft: string; caret: number } {
	const after = draft.slice(1 + trigger.query.length);
	const inserted = `/${command} `;
	const rest = after.startsWith(' ') ? after.slice(1) : after;
	return { draft: `${inserted}${rest}`, caret: inserted.length };
}
