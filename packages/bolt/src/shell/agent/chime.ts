import type { AgentRow } from '../../protocol/schema.ts';

import type { SoundKind } from '../sounds.ts';

export function runTransitions() {
	let prior = new Map<string, string>();
	return (
		rows: readonly { id: string; status: string; integration: string | null }[]
	): string[] => {
		const ended = rows
			.filter(
				(row) =>
					row.integration === null && row.status === 'idle' && prior.get(row.id) === 'running'
			)
			.map((row) => row.id);
		prior = new Map(rows.map((row) => [row.id, row.status]));
		return ended;
	};
}

/** Only new events sound: opening history, switching chats and reconnecting never replay a chime. */
export function attention() {
	let previous: { conversation: string; running: boolean; pending: Set<string> } | undefined;
	return (
		conversation: string | null,
		status: string,
		rows: readonly AgentRow[]
	): SoundKind | null => {
		if (conversation === null) {
			previous = undefined;
			return null;
		}
		const pending = new Set(
			rows
				.filter((row) => row.state === 'confirm' || row.tool?.approval !== undefined)
				.map((row) => row.id)
		);
		const before = previous;
		previous = { conversation, running: status === 'running', pending };
		if (before?.conversation !== conversation) return null;
		if ([...pending].some((id) => !before.pending.has(id))) return 'approval';
		return before.running && status === 'idle' ? 'complete' : null;
	};
}
