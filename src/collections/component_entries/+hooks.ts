import { refuse } from '@norbital-ai/pod/authoring';
import type { Hooks } from './$types.js';

/**
 * Amounts are magnitudes. Direction comes from the component type's nature and from the treatment,
 * and a correction is an entry whose `origin.kind` is `REVERSAL` — never a negative number.
 */
function assertMagnitude(value: unknown): void {
	if (value == null) return;
	const amount = Number(value);
	if (!Number.isFinite(amount)) {
		refuse('Amount must be a number.');
	}
	if (amount < 0) {
		refuse(
			'Amount is a magnitude and can never be negative. To take money back, record an entry whose origin is { kind: "REVERSAL", reverses_entry_id, reason }.'
		);
	}
}

export default {
	create: {
		before: async ({ input }) => {
			assertMagnitude(input.amount);
			return input;
		}
	},
	update: {
		before: async ({ input }) => {
			assertMagnitude(input.amount);
			return input;
		}
	}
} satisfies Hooks;
