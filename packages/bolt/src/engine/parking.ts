import { Deferred, Effect } from 'effect';

/** Work that stops at a boundary for a planned close: `park` holds new work out and answers once none is inside. */
export const makeParking = () => {
	const inside = new Set<string>();
	let idle: Deferred.Deferred<void> | null = null;
	const settled = () => {
		if (idle !== null && inside.size === 0) Deferred.doneUnsafe(idle, Effect.void);
	};
	return {
		get parked() {
			return idle !== null;
		},
		enter: (id: string) => void inside.add(id),
		leave: (id: string) => {
			inside.delete(id);
			settled();
		},
		park: Effect.suspend(() => {
			idle ??= Deferred.makeUnsafe<void>();
			settled();
			return Deferred.await(idle);
		})
	};
};
