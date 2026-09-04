/**
 * Identity-only snapshots for delete concurrency and history.
 *
 * A cascade delete walks every owned child. Putting `to_jsonb(record)` and
 * `jsonb_agg(to_jsonb(child))` into the same facility Transaction is how a one-id payroll-run
 * delete became a 20 MB payload and tripped Colony's 16 MiB ceiling. Membership and existence
 * are identities. The fat columns stay in the database.
 */

export const membershipIdentitySnapshot = (
	rows: ReadonlyArray<Readonly<Record<string, unknown>>>
): string =>
	JSON.stringify(
		rows
			.map((row) => row['id'])
			.filter((id): id is string => typeof id === 'string' && id.length > 0)
			.toSorted((left, right) => left.localeCompare(right))
	);

export const deleteHistoryIdentity = (
	previous: Readonly<Record<string, unknown>> | undefined
): Readonly<Record<string, string>> => {
	const id = previous?.['id'];
	return typeof id === 'string' && id.length > 0 ? { id } : {};
};
