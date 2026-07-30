export function assertNotificationChannelSupport(
	requested: readonly string[],
	supported: readonly string[]
): void {
	const available = new Set(supported);
	const unavailable = requested.filter((channel) => !available.has(channel));
	if (unavailable.length === 0) return;
	throw new Error(
		`The active host does not provide notification channel${unavailable.length === 1 ? '' : 's'}: ${unavailable.join(', ')}`
	);
}
