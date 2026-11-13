import { DateTime, Effect, Option } from 'effect';
import { BoltError } from '../../protocol/errors.ts';
import type { ImportStart, ImportStartInput } from '../../protocol/schema.ts';

export const resolveImportStart = (
	input: ImportStartInput,
	now: number,
	precision?: 'second'
): Effect.Effect<ImportStart, BoltError> => {
	if (input.kind === 'all') return Effect.succeed(input);
	if (input.kind === 'native')
		return Effect.succeed({ ...input, selected_at: new Date(now).toISOString() });
	const refused = () =>
		BoltError.make('invalid_input', 'admission', 'Choose a valid start date and IANA time zone.');
	return Effect.gen(function* () {
		const zone = Option.getOrUndefined(DateTime.zoneMakeNamed(input.zone));
		if (zone === undefined) return yield* Effect.fail(refused());
		if (input.kind === 'now') {
			const since: ImportStart = {
				kind: 'since',
				at: new Date(precision === 'second' ? Math.floor(now / 1000) * 1000 : now).toISOString(),
				zone: input.zone,
				origin: 'now'
			};
			return since;
		}
		const parsed = Date.parse(`${input.date}T00:00:00.000Z`);
		if (
			!/^\d{4}-\d{2}-\d{2}$/.test(input.date) ||
			!Number.isFinite(parsed) ||
			new Date(parsed).toISOString().slice(0, 10) !== input.date
		)
			return yield* Effect.fail(refused());
		const at = DateTime.makeZonedUnsafe(`${input.date}T00:00:00`, { timeZone: zone, adjustForTimeZone: true, disambiguation: 'compatible' });
		if (DateTime.formatIsoDate(at) !== input.date) return yield* Effect.fail(refused());
		const since: ImportStart = { kind: 'since', at: DateTime.formatIso(at), zone: input.zone, origin: 'date' };
		return since;
	});
};

/** Native positions are interpreted only by the provider that declared them. */
export const permitsImport = (
	start: ImportStart | null | undefined,
	at: string | undefined
): boolean =>
	start?.kind !== 'since' ||
	(at !== undefined && Number.isFinite(Date.parse(at)) && Date.parse(at) >= Date.parse(start.at));
