/**
 * Component entries — the only door money enters payroll through.
 *
 * An entry's `amount` is always a **magnitude**. Direction comes from the component type's nature
 * and from the treatment grid, and taking money back is an entry whose `origin.kind` is `REVERSAL`,
 * never a negative number. That is what keeps "is this figure a credit or a debit?" answerable from
 * the type alone.
 *
 * ## The reversal-sign bug this fixes
 *
 * The engine of record computes the sign as a single flip — `reverses_entry_id ? -1 : 1`. That is
 * not transitive: reversing a reversal yields −1 again, so instead of restoring the original it
 * **doubles the negative**, silently. Nobody has done it yet, which is the only reason it has never
 * cost anyone money.
 *
 * Here the chain is walked to its root and the sign is `(−1)^depth`, so a reversal of a reversal
 * restores the original exactly. The walk is bounded and detects a cycle, because an entry that
 * reverses itself would otherwise hang a payroll run (decision L41 / risk register #12).
 */

import type { WorkspaceRow } from '../$types.js';
import { dateKey, type IsoDate } from './dates.js';
import { defaultPayPeriod } from './period.js';

export type ComponentEntry = WorkspaceRow<'component_entries'>;

const MAX_REVERSAL_DEPTH = 32;

/**
 * `+1` for an entry that pays, `−1` for one that takes back, `+1` again for a reversal of a
 * reversal.
 */
export function entrySign(
	entry: ComponentEntry,
	byId: ReadonlyMap<string, ComponentEntry>
): number {
	let current = entry;
	let depth = 0;
	const seen = new Set<string>([entry.norbital_id]);
	while (current.origin?.kind === 'REVERSAL') {
		depth += 1;
		if (depth > MAX_REVERSAL_DEPTH)
			throw new Error(
				`Component entry ${entry.norbital_id} sits on a reversal chain more than ` +
					`${MAX_REVERSAL_DEPTH} deep. That is a data fault, not a correction.`
			);
		const target = byId.get(current.origin.reverses_entry_id);
		if (!target)
			throw new Error(
				`Component entry ${current.norbital_id} reverses ${current.origin.reverses_entry_id}, ` +
					'which is not in this run. A reversal must name an entry payroll can see.'
			);
		if (seen.has(target.norbital_id))
			throw new Error(
				`Component entries ${[...seen].join(', ')} form a reversal cycle and cannot be signed.`
			);
		seen.add(target.norbital_id);
		current = target;
	}
	return depth % 2 === 0 ? 1 : -1;
}

/**
 * The entry the sign chain ultimately points at.
 *
 * A reversal inherits its subject's economics — a cancelled December claim consumes December's cap,
 * not January's — so cap membership and the event date follow the root, while run membership
 * follows the reversal's own `pay_period` (decision L16 / L20).
 */
export function rootEntry(
	entry: ComponentEntry,
	byId: ReadonlyMap<string, ComponentEntry>
): ComponentEntry {
	let current = entry;
	let depth = 0;
	while (current.origin?.kind === 'REVERSAL' && depth < MAX_REVERSAL_DEPTH) {
		const target = byId.get(current.origin.reverses_entry_id);
		if (!target) return current;
		current = target;
		depth += 1;
	}
	return current;
}

/** Which run an entry settles in. The stored `pay_period` wins; the cutoff supplies the default. */
export function entryPayPeriod(entry: ComponentEntry, cutoffDay: number): string {
	if (entry.pay_period != null && entry.pay_period !== '') return entry.pay_period;
	const eventDate = dateKey(entry.event_date);
	if (eventDate == null)
		throw new Error(`Component entry ${entry.norbital_id} has no event date to settle by.`);
	return defaultPayPeriod(eventDate, cutoffDay);
}

/** The date an entry's economics belong to — its own, or its subject's when it is a reversal. */
export function entryEventDate(
	entry: ComponentEntry,
	byId: ReadonlyMap<string, ComponentEntry>
): IsoDate {
	const root = rootEntry(entry, byId);
	const date = dateKey(root.event_date);
	if (date == null) throw new Error(`Component entry ${root.norbital_id} has no event date.`);
	return date;
}

/** A standing entry's own effective range, which prorates it independently of the employment. */
export function standingRange(
	entry: ComponentEntry
): { readonly start: IsoDate; readonly end: IsoDate | null } | null {
	if (entry.origin?.kind !== 'STANDING') return null;
	const range = entry.origin.effective_range;
	return {
		start: String(range.start).slice(0, 10),
		end: range.end == null ? null : String(range.end).slice(0, 10)
	};
}

/**
 * Whether an entry prorates.
 *
 * Only a standing entry does. A claim, a bonus, an instalment and an arrears payment are each whole
 * amounts for a moment in time, and dividing them by the days of a month would be meaningless.
 */
export function prorates(entry: ComponentEntry): boolean {
	return entry.origin?.kind === 'STANDING';
}
