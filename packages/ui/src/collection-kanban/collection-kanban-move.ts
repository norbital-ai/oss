/**
 * The update payload for the default kanban move (RFC V.3c): write the destination lane into the
 * groupBy field. Pure so the default-move behaviour is unit-testable without a data client.
 */
export function laneMoveUpdate(groupBy: string, toLane: string): Record<string, string> {
	return { [groupBy]: toLane };
}

export interface OptimisticKanbanMove {
	apply: () => void;
	commit: () => Promise<void>;
	refresh: () => Promise<void>;
	rollback: () => void;
}

/**
 * Keeps the visual move immediate while preserving the query as the source of truth.
 * A failed mutation or refresh restores the record to its server-backed lane.
 */
export async function runOptimisticKanbanMove(move: OptimisticKanbanMove): Promise<void> {
	move.apply();
	try {
		await move.commit();
		await move.refresh();
	} catch (cause) {
		move.rollback();
		throw cause;
	}
}
