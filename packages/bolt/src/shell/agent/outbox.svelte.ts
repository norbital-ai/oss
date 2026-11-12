import type { AgentRow } from '../../protocol/wire.ts';

export type OutboxRow = AgentRow & { readonly stored?: string };

/** Optimistic messages stay until their actual stored rows arrive; cancellation can precede the post answer. */
export function message_outbox() {
	let rows = $state<OutboxRow[]>([]);
	const cancelled = new Set<string>();
	return {
		get rows() { return rows; },
		add(row: OutboxRow): void { rows.push(row); },
		remove(id: string): void { cancelled.delete(id); rows = rows.filter((row) => row.id !== id); },
		clear(): void { rows = []; },
		arrived(stored: readonly AgentRow[]): void {
			if (rows.some((item) => item.stored !== undefined && stored.some((row) => row.id === item.stored)))
				rows = rows.filter((item) => item.stored === undefined || !stored.some((row) => row.id === item.stored));
		},
		acknowledge(local: string, stored: string | null, live: readonly AgentRow[]): boolean {
			rows = stored === null || stored === '' || live.some((row) => row.id === stored)
				? rows.filter((item) => item.id !== local)
				: rows.map((item) => item.id === local ? { ...item, stored } : item);
			return cancelled.delete(local) && stored !== null && stored !== '';
		},
		cancel(row: OutboxRow): void {
			if (row.stored === undefined) cancelled.add(row.id);
			rows = rows.filter((item) => item.id !== row.id);
		}
	};
}
