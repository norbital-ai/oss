import type { AgentRow, PageAction } from '../../protocol/schema.ts';

export const CLIENT_NAVIGATION = Symbol('norbius-client-navigation');
export type ClientNavigation = { open(path: string, conversation: string): void };

export const CLIENT_PAGE_ACTION = Symbol('norbius-client-page-action');
export type ClientPageAction = {
	run(action: PageAction, conversation: string, step: string): void;
};

/** One ledger for the tab: several Agent components — and duplicate module copies — must not repeat an action. */
type Ledger = {
	conversation: string | null;
	seen: Set<string>;
	primed: boolean;
	started: Set<string>;
};
const LEDGER = Symbol.for('norbital.bolt.page-actions');
const ledger: Ledger = ((globalThis as { [LEDGER]?: Ledger })[LEDGER] ??= {
	conversation: null,
	seen: new Set(),
	primed: false,
	started: new Set()
});
/** A conversation this panel started: its first rows are live, never a transcript the panel merely opened. */
export function pageConversationStarted(id: string): void {
	ledger.started.add(id);
}
/** The first loaded transcript is history. Only page actions after the panel opened a conversation affect the tab. */
export function pageActions() {
	return (
		conversation: string | null,
		rows: readonly AgentRow[]
	): { key: string; id: string; action: PageAction }[] => {
		if (conversation === null) {
			ledger.conversation = null;
			ledger.seen.clear();
			ledger.primed = false;
			return [];
		}
		if (conversation !== ledger.conversation) {
			ledger.conversation = conversation;
			ledger.seen.clear();
			ledger.primed = false;
		}
		const actions = rows.flatMap((row) =>
			row.tool?.name === 'page_act' && row.tool.page !== undefined
				? [
						{
							key: `${row.id}:${JSON.stringify(row.tool.page)}`,
							id: row.id,
							action: row.tool.page
						}
					]
				: []
		);
		// the first rows of an opened conversation are its history; a conversation this panel started is live
		const history = !ledger.started.has(conversation) && !ledger.primed && rows.length > 0;
		if (rows.length > 0) ledger.primed = true;
		const fresh = actions.filter(
			(item) => !ledger.seen.has(item.key) && !history
		);
		for (const item of actions) ledger.seen.add(item.key);
		return fresh.map(({ key, id, action }) => ({ key, id, action }));
	};
}

/** The first loaded transcript is history. Only subsequent navigation results affect the active client. */
export function navigationEvents() {
	let current: string | null = null;
	let seen = new Set<string>();
	return (conversation: string | null, rows: readonly AgentRow[]): string[] => {
		const navigations = rows.flatMap((row) =>
			row.tool?.name === 'navigate' && row.tool.navigation !== undefined
				? [{ key: `${row.id}:${row.tool.navigation}`, path: row.tool.navigation }]
				: []
		);
		const fresh = conversation === current ? navigations.filter((item) => !seen.has(item.key)) : [];
		current = conversation;
		for (const item of navigations) seen.add(item.key);
		if (conversation === null) seen = new Set();
		return fresh.map((item) => item.path);
	};
}
