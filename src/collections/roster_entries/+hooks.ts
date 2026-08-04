import type { HookApi, Hooks } from './$types.js';

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
		before: async ({ input, api }) => {
			await assertRosterOpen(api, input.roster_id);
			return input;
		}
	},
	update: {
		before: async ({ input, existing, api }) => {
			await assertRosterOpen(api, existing.roster_id);
			if (input.roster_id != null && input.roster_id !== existing.roster_id) {
				await assertRosterOpen(api, input.roster_id);
			}
			return input;
		}
	},
	delete: {
		before: async ({ existing, api }) => {
			await assertRosterOpen(api, existing.roster_id);
		}
	}
} satisfies Hooks;
