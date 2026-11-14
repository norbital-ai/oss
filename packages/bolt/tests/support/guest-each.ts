// A fake guest's `invokeEach`: each part through its own `invoke`, as one invocation per target would run.
import { Effect } from 'effect';
import type { GuestShape } from '../../src/engine/services.ts';

export const with_each = (guest: Omit<GuestShape, 'invokeEach'>): GuestShape => ({
	...guest,
	invokeEach: (invocation, parts, bridge) =>
		Effect.forEach(parts, (part) =>
			guest.invoke({ ...invocation, ...part, id: `${invocation.id}:${part.target}` }, bridge)
		)
});
