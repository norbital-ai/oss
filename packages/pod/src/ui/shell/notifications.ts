/**
 * What the notification bell renders, and how a replica row becomes it.
 *
 * Separate from the component because this is the only part with an answer worth checking, and
 * there is no browser runner in this package to check it through the component.
 */
export type NotificationRow = {
	readonly norbital_id: string;
	readonly subject: string;
	readonly message: string;
	readonly cta_label: string | null;
	readonly cta_url: string | null;
	readonly notification_category: string | null;
	readonly read_at: string | null;
	readonly norbital_created_at: string;
};

/**
 * Narrow one replica record to a notification, or to nothing.
 *
 * A cast would do the same thing while promising more than the wire can keep: these rows arrive
 * from a local SQL replica whose columns were introspected at runtime, so "it has a subject" is a
 * fact to read, not one to assert. A record missing either is dropped rather than rendered as a
 * row of `undefined`.
 */
export function toNotificationRow(record: Readonly<Record<string, unknown>>): NotificationRow[] {
	const id = record.norbital_id;
	const subject = record.subject;
	if (typeof id !== 'string' || typeof subject !== 'string') return [];
	/** Reads an optional string column, or null when the replica omitted it. */
	// stupidity:allow Q4 -- named helper
	const optional = (field: string): string | null => {
		const value = record[field];
		return typeof value === 'string' ? value : null;
	};
	return [
		{
			norbital_id: id,
			subject,
			message: typeof record.message === 'string' ? record.message : '',
			cta_label: optional('cta_label'),
			cta_url: optional('cta_url'),
			notification_category: optional('notification_category'),
			read_at: optional('read_at'),
			norbital_created_at: optional('norbital_created_at') ?? ''
		}
	];
}

/**
 * How many unread the badge admits to.
 *
 * Capped, and deliberately a lower bound: the list is one page, so a count past it is not one this
 * surface can see. `9+` is true whether there are ten or a thousand, which an exact number taken
 * from a page would not be.
 */
// stupidity:allow Q4 -- named helper
export function unreadBadge(unread: number): string {
	if (unread <= 0) return '';
	return unread > 9 ? '9+' : String(unread);
}
