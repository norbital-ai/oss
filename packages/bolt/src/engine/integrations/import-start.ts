import { Effect } from 'effect';
import { localOf, utcOf } from '@norbital-ai/std/zone';
import { BoltError } from '../../protocol/errors.ts';
import type { ImportStart, ImportStartInput } from '../../protocol/schema.ts';

export const resolveImportStart = (
	input: ImportStartInput,
	now: number,
	precision?: 'second'
): Effect.Effect<ImportStart, BoltError> =>
	Effect.try({
		try: (): ImportStart => {
			if (input.kind === 'all') return input;
			if (input.kind === 'native') return { ...input, selectedAt: new Date(now).toISOString() };
			localOf(now, input.zone);
			if (input.kind === 'now')
				return {
					kind: 'since',
					at: new Date(precision === 'second' ? Math.floor(now / 1000) * 1000 : now).toISOString(),
					zone: input.zone,
					origin: 'now'
				};
			const parsed = Date.parse(`${input.date}T00:00:00.000Z`);
			if (
				!/^\d{4}-\d{2}-\d{2}$/.test(input.date) ||
				!Number.isFinite(parsed) ||
				new Date(parsed).toISOString().slice(0, 10) !== input.date
			)
				throw new Error('Choose a valid calendar date.');
			const at = utcOf(input.date, 0, input.zone);
			if (localOf(at, input.zone).date !== input.date)
				throw new Error('That calendar date does not exist in this time zone.');
			return { kind: 'since', at: new Date(at).toISOString(), zone: input.zone, origin: 'date' };
		},
		catch: () =>
			BoltError.make('invalidInput', 'admission', 'Choose a valid start date and IANA time zone.')
	});

/** Native positions are interpreted only by the provider that declared them. */
export const permitsImport = (
	start: ImportStart | null | undefined,
	at: string | undefined
): boolean =>
	start?.kind !== 'since' ||
	(at !== undefined && Number.isFinite(Date.parse(at)) && Date.parse(at) >= Date.parse(start.at));
