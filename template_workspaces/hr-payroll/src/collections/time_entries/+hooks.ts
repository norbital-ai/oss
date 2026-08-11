import { refuse } from '@norbital-ai/pod/authoring';
import type { Hooks } from './$types.js';

function toMillis(value: unknown): number | null {
	if (value == null) return null;
	if (value instanceof Date) {
		const milliseconds = value.getTime();
		return Number.isNaN(milliseconds) ? null : milliseconds;
	}
	if (typeof value === 'string' || typeof value === 'number') {
		const milliseconds = new Date(value).getTime();
		return Number.isNaN(milliseconds) ? null : milliseconds;
	}
	return null;
}

/** A closed clock has both stamps and runs forwards; an open one may still be missing its close. */
function assertClock(row: Record<string, unknown>): void {
	const clockIn = row.clock_in ?? null;
	const clockOut = row.clock_out ?? null;

	if (row.state === 'CLOSED' && (clockIn == null || clockOut == null)) {
		refuse(
			'A CLOSED time entry must have both clock_in and clock_out. Leave it OPEN until the clock stops.'
		);
	}

	if (clockIn == null || clockOut == null) return;

	const startedAt = toMillis(clockIn);
	const endedAt = toMillis(clockOut);
	if (startedAt == null || endedAt == null) {
		refuse('clock_in and clock_out must be valid timestamps.');
	}
	if (endedAt <= startedAt) {
		refuse(
			'clock_out must be later than clock_in. A shift crossing midnight still ends on a later instant.'
		);
	}
}

/**
 * The dedicated overtime punch is a pair or it is nothing: one stamp alone cannot say how long
 * overtime ran, and for the populations that use this punch it is the ONLY thing that earns
 * overtime, so half a pair would silently pay zero rather than fail.
 */
function assertOvertimePunch(row: Record<string, unknown>): void {
	const overtimeIn = row.overtime_in ?? null;
	const overtimeOut = row.overtime_out ?? null;

	if ((overtimeIn == null) !== (overtimeOut == null)) {
		refuse(
			'overtime_in and overtime_out must be given together. Leave both empty where overtime is not punched separately.'
		);
	}
	if (overtimeIn == null || overtimeOut == null) return;

	const startedAt = toMillis(overtimeIn);
	const endedAt = toMillis(overtimeOut);
	if (startedAt == null || endedAt == null) {
		refuse('overtime_in and overtime_out must be valid timestamps.');
	}
	if (endedAt <= startedAt) {
		refuse('overtime_out must be later than overtime_in.');
	}
}

export default {
	create: {
		before: {
			description:
				'Requires a CLOSED time entry to carry both clock_in and clock_out with the clock running forwards, and the separate overtime punch to be given as a pair or not at all.',
			handler: async ({ input }) => {
				assertClock({ ...input });
				assertOvertimePunch({ ...input });
				return input;
			}
		}
	},
	update: {
		before: {
			description:
				'Judges the patched time entry as the row it becomes, so closing a shift or amending one stamp cannot leave a clock that ends before it starts or half an overtime punch.',
			handler: async ({ input, existing }) => {
				assertClock({ ...existing, ...input });
				assertOvertimePunch({ ...existing, ...input });
				return input;
			}
		}
	}
} satisfies Hooks;
