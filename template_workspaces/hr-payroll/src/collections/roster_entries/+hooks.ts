import type { HookApi, Hooks } from './$types.js';

/**
 * The two arms of the union, enforced on the row as it will be stored.
 *
 * A working day without a shift has no hours, so nothing about it can be measured — the publication
 * check already refuses one, and catching it at the write means a month is not drafted for a fortnight
 * before anybody is told. A rest or off day WITH a shift is the older conflation this collection was
 * built on: it recorded a shift the person was not working, which is why a non-working day used to
 * look scheduled to every reader of the row. Neither is a shape the roster is allowed to be in.
 */
function assertDesignationArm(
	designation: string | null | undefined,
	shiftDefinitionId: string | null,
	workDate: string
): void {
	if (designation === 'WORK') {
		if (shiftDefinitionId != null) return;
		throw new Error(
			`${workDate} is rostered as a working day but names no shift, so its hours cannot be ` +
				'measured. Name the shift it is worked on, or mark the day REST or OFF.'
		);
	}
	if (shiftDefinitionId == null) return;
	throw new Error(
		`${workDate} is rostered as a ${designation ?? 'non-working'} day, which schedules no shift, ` +
			'so it cannot name one. Clear the shift, or mark the day WORK if it is worked. Hours ' +
			'actually worked on a rest or off day are measured from the punches, not from a shift ' +
			'nobody was scheduled on.'
	);
}

function dateKey(value: string | Date | null | undefined): string {
	if (value == null) return 'This entry';
	return typeof value === 'string' ? value.slice(0, 10) : value.toISOString().slice(0, 10);
}

/**
 * A published month is the roster the payroll engine reads, so its entries stop being editable.
 *
 * Without this, publication would be decoration: the statutory checks would pass at the moment of
 * publishing and the month could be edited into an unlawful shape immediately afterwards, with
 * nothing to catch it.
 */
async function assertRosterOpen(api: HookApi, rosterId: string | null | undefined): Promise<void> {
	if (rosterId == null) return;
	const roster = await api.db.query.rosters.findFirst({
		where: { norbital_id: { eq: rosterId } },
		columns: { month: true, published_at: true }
	});
	if (roster == null) return;
	if (roster.published_at != null) {
		throw new Error(
			`Roster ${roster.month} is published, so its entries are fixed. Re-open the month to change ` +
				'it — that way the change is deliberate and the month is re-validated when it is ' +
				'published again.'
		);
	}
}

export default {
	create: {
		before: {
			description:
				'Refuses a rostered day added to an already-published month, and requires a WORK day to name a shift while a REST or OFF day names none.',
			handler: async ({ input, api }) => {
				await assertRosterOpen(api, input.roster_id);
				assertDesignationArm(
					input.designation,
					input.shift_definition_id ?? null,
					dateKey(input.work_date)
				);
				return input;
			}
		}
	},
	update: {
		before: {
			description:
				'Refuses edits to a day in a published month, and judges the patched row so changing only the designation cannot leave a REST or OFF day still naming a shift, or a WORK day with none.',
			handler: async ({ input, existing, api }) => {
				await assertRosterOpen(api, existing.roster_id);
				if (input.roster_id != null && input.roster_id !== existing.roster_id) {
					await assertRosterOpen(api, input.roster_id);
				}
				// The patch is judged as the row it produces, not on its own: changing only the
				// designation of a day that still names a shift is exactly how the two arms drift apart.
				assertDesignationArm(
					input.designation ?? existing.designation,
					(input.shift_definition_id === undefined
						? existing.shift_definition_id
						: input.shift_definition_id) ?? null,
					dateKey(input.work_date ?? existing.work_date)
				);
				return input;
			}
		}
	},
	delete: {
		before: {
			description:
				'Refuses to remove a rostered day from a published month, so the schedule the payroll engine reads cannot lose a day underneath it.',
			handler: async ({ existing, api }) => {
				await assertRosterOpen(api, existing.roster_id);
			}
		}
	}
} satisfies Hooks;
