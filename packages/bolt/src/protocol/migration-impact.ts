// What applying a release's pending migrations did, measured where it ran (a preview's fork): each step's rows and the
// whole migrate's duration, the expected downtime of the same merge on live. Plain words for Studio and Norbius.
import { Schema } from 'effect';

/** `rows`: written (INSERT/UPDATE/DELETE), held by what a destructive step drops, filled by a backfill, or checked. */
export const MigrationStepImpact = /*#__PURE__*/ Schema.Struct({
	id: Schema.String,
	hazard: Schema.String,
	rows: Schema.Number,
	summary: Schema.String
});
export type MigrationStepImpact = typeof MigrationStepImpact.Type;
export const MigrationImpact = /*#__PURE__*/ Schema.Struct({
	durationMs: Schema.Number,
	steps: Schema.Array(MigrationStepImpact)
});
export type MigrationImpact = typeof MigrationImpact.Type;

const fill = (template: string, values: Readonly<Record<string, string | number>>) =>
	template.replace(/\{(\w+)\}/g, (all, key: string) => String(values[key] ?? all));
/** A step in plain words, read from its generated id (`drop:column:contracts.bank`, `check:contracts.nationality`). */
export function impactText(
	step: Pick<MigrationStepImpact, 'id' | 'hazard' | 'rows'>,
	t: (key: string) => string = (key) => key
): string {
	const object = step.id.slice(step.id.lastIndexOf(':') + 1),
		dot = object.indexOf('.'),
		table = dot < 0 ? object : object.slice(0, dot),
		name = dot < 0 ? object : object.slice(dot + 1),
		values = { object, table, name, n: step.rows, rows: step.rows === 1 ? '1 row' : `${step.rows} rows`, id: step.id };
	switch (step.hazard) {
		case 'destructive':
			return fill(
				t(
					step.id.includes(':column:')
						? 'Drops column {object} — {rows} with a value'
						: step.id.includes(':table:')
							? 'Drops table {object} — {rows}'
							: 'Rebuilds {object} — {rows}'
				),
				values
			);
		case 'backfill':
			return fill(t('Fills {name} on {n} {table}'), values);
		case 'validating':
			return fill(t('Checks {name} on {n} {table}: 0 violations'), values);
		case 'rename':
			return fill(t('Renames {object}'), values);
		case 'additive':
			return fill(t('Adds {object}'), values);
		default:
			return fill(t('Writes {rows} ({id})'), values);
	}
}
/** What a person reads before merging: every step that touches data (additions are left out), then the downtime. */
export const impactLines = (
	impact: MigrationImpact,
	t: (key: string) => string = (key) => key
): readonly string[] => [
	...impact.steps.filter((step) => step.hazard !== 'additive').map((step) => impactText(step, t)),
	fill(t('Expected downtime about {s} s (measured on the preview)'), {
		s: Math.max(1, Math.round(impact.durationMs / 1000))
	})
];
