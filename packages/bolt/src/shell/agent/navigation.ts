import type { AgentRow } from '../../protocol/schema.ts';

export const CLIENT_NAVIGATION = Symbol('norbius-client-navigation');
export type ClientNavigation = { open(path: string, conversation: string): void };

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
