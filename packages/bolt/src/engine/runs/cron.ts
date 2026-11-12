import { Cron, Result } from 'effect';

const macros = new Map([
	['@yearly', '0 0 1 1 *'],
	['@annually', '0 0 1 1 *'],
	['@monthly', '0 0 1 * *'],
	['@weekly', '0 0 * * 0'],
	['@daily', '0 0 * * *'],
	['@hourly', '0 * * * *']
]);

/** The host schedules the five fields a workspace declared, with macros expanded. */
export function cronFields(input: string): string {
	const text = input.trim();
	return macros.get(text) ?? text;
}

/** Workspace schedules have minute resolution. The same parser checks and schedules them. */
export function parse_cron(
	input: string,
	tz?: string
): Result.Result<Cron.Cron, Cron.CronParseError> {
	const fields = cronFields(input);
	if (fields.split(/\s+/).length !== 5 || !/^[0-9*,/\s-]+$/.test(fields))
		return Result.fail(
			new Cron.CronParseError({ message: 'Expected five numeric cron fields or a macro.', input })
		);
	return Cron.parse(fields, tz);
}
