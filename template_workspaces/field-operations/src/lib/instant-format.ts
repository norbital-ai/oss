export function formatSingaporeInstant(value: string | Date | null | undefined): string {
	if (!value) return 'Not recorded';
	return new Intl.DateTimeFormat('en-SG', {
		dateStyle: 'medium',
		timeStyle: 'short',
		timeZone: 'Asia/Singapore'
	}).format(new Date(value));
}
