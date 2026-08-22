/**
 * Chip colour palette for collection cards. The class shape mirrors `feature-colors`' `accentClass`
 * (`bg-<c>-50 text-<c>-700 ring-<c>-200` + a dark variant), so enum badges with explicit
 * colour hints render with the same tone everywhere.
 *
 * Keys are the bare colour names accepted by authored view-lane metadata. Unknown or absent colours
 * fall back to a neutral chip.
 * Class strings are spelled out in full so Tailwind's JIT scanner picks them up.
 */
const BADGE_COLOR_CLASSES: Record<string, string> = {
	slate:
		'border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-400/25 dark:bg-slate-400/12 dark:text-slate-200',
	gray: 'border-gray-200 bg-gray-50 text-gray-700 dark:border-gray-400/25 dark:bg-gray-400/12 dark:text-gray-200',
	red: 'border-red-200 bg-red-50 text-red-700 dark:border-red-400/25 dark:bg-red-400/12 dark:text-red-200',
	orange:
		'border-orange-200 bg-orange-50 text-orange-700 dark:border-orange-400/25 dark:bg-orange-400/12 dark:text-orange-200',
	amber:
		'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-400/25 dark:bg-amber-400/12 dark:text-amber-200',
	yellow:
		'border-yellow-200 bg-yellow-50 text-yellow-700 dark:border-yellow-400/25 dark:bg-yellow-400/12 dark:text-yellow-200',
	lime: 'border-lime-200 bg-lime-50 text-lime-700 dark:border-lime-400/25 dark:bg-lime-400/12 dark:text-lime-200',
	green:
		'border-green-200 bg-green-50 text-green-700 dark:border-green-400/25 dark:bg-green-400/12 dark:text-green-200',
	emerald:
		'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-400/25 dark:bg-emerald-400/12 dark:text-emerald-200',
	teal: 'border-teal-200 bg-teal-50 text-teal-700 dark:border-teal-400/25 dark:bg-teal-400/12 dark:text-teal-200',
	cyan: 'border-cyan-200 bg-cyan-50 text-cyan-700 dark:border-cyan-400/25 dark:bg-cyan-400/12 dark:text-cyan-200',
	sky: 'border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-400/25 dark:bg-sky-400/12 dark:text-sky-200',
	blue: 'border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-400/25 dark:bg-blue-400/12 dark:text-blue-200',
	indigo:
		'border-indigo-200 bg-indigo-50 text-indigo-700 dark:border-indigo-400/25 dark:bg-indigo-400/12 dark:text-indigo-200',
	violet:
		'border-violet-200 bg-violet-50 text-violet-700 dark:border-violet-400/25 dark:bg-violet-400/12 dark:text-violet-200',
	purple:
		'border-purple-200 bg-purple-50 text-purple-700 dark:border-purple-400/25 dark:bg-purple-400/12 dark:text-purple-200',
	fuchsia:
		'border-fuchsia-200 bg-fuchsia-50 text-fuchsia-700 dark:border-fuchsia-400/25 dark:bg-fuchsia-400/12 dark:text-fuchsia-200',
	pink: 'border-pink-200 bg-pink-50 text-pink-700 dark:border-pink-400/25 dark:bg-pink-400/12 dark:text-pink-200',
	rose: 'border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-400/25 dark:bg-rose-400/12 dark:text-rose-200',
	brand: 'border-brand/25 bg-brand/15 text-brand'
};

/** Neutral chip used when no colour (or an unknown colour) is supplied. */
const BADGE_COLOR_FALLBACK =
	'border-border bg-muted text-muted-foreground dark:bg-muted dark:text-muted-foreground';

export function badgeColorClass(color?: string): string {
	if (!color) return BADGE_COLOR_FALLBACK;
	return BADGE_COLOR_CLASSES[color] ?? BADGE_COLOR_FALLBACK;
}
