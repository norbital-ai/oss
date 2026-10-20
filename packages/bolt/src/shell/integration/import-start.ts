import type {
	ImportStart,
	ImportStartInput,
	ProviderChoice
} from '../../protocol/instance-status.ts';

const zone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
export const importDate = (at: string, timeZone: string): string => {
	const parts = new Intl.DateTimeFormat('en', {
		timeZone,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit'
	}).formatToParts(new Date(at));
	return ['year', 'month', 'day']
		.map((key) => parts.find((part) => part.type === key)?.value)
		.join('-');
};

/** Existing instances retain their saved boundary; only a new connection defaults to now. */
export const importStartDraft = (
	start: ImportStart | null | undefined,
	provider: ProviderChoice,
	fresh = false
): ImportStartInput => {
	if (provider.importStart?.kind === 'native')
		return {
			kind: 'native',
			provider: provider.id,
			values: {
				...Object.fromEntries(
					provider.importStart.fields.flatMap((field): [string, string][] =>
						field.options?.[0] === undefined ? [] : [[field.name, field.options[0].value]]
					)
				),
				...(start?.kind === 'native' && start.provider === provider.id ? start.values : {})
			}
		};
	if (start?.kind === 'since')
		return start.origin === 'now'
			? { kind: 'now', zone: start.zone }
			: { kind: 'since', date: importDate(start.at, start.zone), zone: start.zone };
	return fresh ? { kind: 'now', zone: zone() } : { kind: 'all' };
};

export const validImportStart = (input: ImportStartInput, provider: ProviderChoice): boolean => {
	if (input.kind === 'all') return true;
	if (input.kind === 'native')
		return (
			input.provider === provider.id &&
			provider.importStart?.kind === 'native' &&
			provider.importStart.fields.every(
				(field) =>
					field.optional === true ||
					(input.values[field.name] ?? field.options?.[0]?.value ?? '').trim() !== ''
			)
		);
	try {
		new Intl.DateTimeFormat('en', { timeZone: input.zone });
		return (
			input.kind === 'now' ||
			(/^\d{4}-\d{2}-\d{2}$/.test(input.date) &&
				new Date(`${input.date}T00:00:00Z`).toISOString().slice(0, 10) === input.date)
		);
	} catch {
		return false;
	}
};

export const importStartLabel = (
	start: ImportStart | null | undefined,
	t: (key: string) => string,
	locale = 'en'
): string => {
	if (start?.kind === 'native') return t('Provider import position');
	if (start?.kind !== 'since') return t('All available history');
	const at = new Intl.DateTimeFormat(locale, {
		timeZone: start.zone,
		year: 'numeric',
		month: 'short',
		day: 'numeric',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
		hourCycle: 'h23'
	}).format(new Date(start.at));
	return t('Since {at} ({zone})').replace('{at}', at).replace('{zone}', start.zone);
};
