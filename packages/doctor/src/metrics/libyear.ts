/**
 * libyear: dependency age, expressed in years of staleness.
 *
 * Freshness has better units than version numbers. libyear sums, per dependency, how much older
 * the installed release is than the newest known one — `age(current) − age(latest)` — so a
 * package updated yesterday contributes ~0 regardless of its version, while a two-year-old
 * pin on a fast-moving library confesses itself. Ages use 365.25-day years to absorb leap days
 * without letting calendars leak into arithmetic.
 *
 * Everything ambient arrives injected: the resolver maps a package to whatever registry view
 * answers `releaseDateOf(version)` (ISO strings), with the `'latest'` sentinel asking for the
 * dist-tag date, and `now` comes in as a parameter because a metric that reads the wall clock
 * cannot be tested, only observed. Rows the resolver cannot date are skipped silently — a
 * private package with no public metadata is not stale, it is unmeasurable. Duplicate
 * declarations across manifests collapse to their first appearance, walking dependencies before
 * devDependencies per manifest.
 *
 * `parseRange` strips the caret/tilde/comparison noise down to the base version. It is purely
 * textual on purpose: semver ranges like `1.x` or `*` have no single base worth inventing, and
 * they come back undefined rather than guessed.
 */

export type LibyearManifest = Readonly<{
	name: string;
	dependencies?: Record<string, string> | undefined;
	devDependencies?: Record<string, string> | undefined;
}>;

export type RegistryView = Readonly<{
	releaseDateOf: (version: string) => string | undefined;
}>;

export type LibyearRow = Readonly<{
	pkg: string;
	current: string;
	latest: string | null;
	libyears: number;
}>;

export type LibyearReport = Readonly<{
	rows: ReadonlyArray<LibyearRow>;
	totals: Readonly<{ libyears: number; stalest: string | null }>;
}>;

const YEAR_MS = 365.25 * 24 * 60 * 60 * 1000;
const LATEST_SENTINEL = 'latest';

/** Base version of a range specifier: prefixes stripped, prerelease/build dropped. */
export function parseRange(version: string): string | undefined {
	const unprefixed = version.trim().replace(/^[~^<>=!*]+/, '').replace(/^v/i, '');
	const base = unprefixed.split('-')[0]?.trim();
	if (base === undefined || base === '') return undefined;
	return base;
}

function ageInYears(isoDate: string, now: Date): number | undefined {
	const time = Date.parse(isoDate);
	if (!Number.isFinite(time)) return undefined;
	return (now.getTime() - time) / YEAR_MS;
}

function collectWanted(
	manifests: ReadonlyArray<LibyearManifest>
): ReadonlyMap<string, string> {
	const wanted = new Map<string, string>();
	for (const entry of manifests.flatMap((manifest) => [
		...(manifest.dependencies === undefined ? [] : Object.entries(manifest.dependencies)),
		...(manifest.devDependencies === undefined ? [] : Object.entries(manifest.devDependencies))
	])) {
		const [pkg, version] = entry;
		if (!wanted.has(pkg)) wanted.set(pkg, version);
	}
	return wanted;
}

export async function computeLibyear(
	manifests: ReadonlyArray<LibyearManifest>,
	resolve: (pkg: string) => Promise<RegistryView | undefined>,
	now: Date
): Promise<LibyearReport> {
	const wanted = collectWanted(manifests);

	const rows: Array<LibyearRow> = [];
	for (const [pkg, current] of [...wanted].sort(([left], [right]) =>
		left.localeCompare(right)
	)) {
		
		// repository-health:allow A6 -- registry views are resolved one dependency at a time;
		// a single unstable snapshot serves the whole report.
const registry = await resolve(pkg);
		if (registry === undefined) continue;
		const currentDate = registry.releaseDateOf(current);
		const latestDate = registry.releaseDateOf(LATEST_SENTINEL);
		if (currentDate === undefined || latestDate === undefined) continue;
		const currentAge = ageInYears(currentDate, now);
		const latestAge = ageInYears(latestDate, now);
		if (currentAge === undefined || latestAge === undefined) continue;
		rows.push({
			pkg,
			current,
			latest: latestDate,
			libyears: currentAge - latestAge
		});
	}

	const totals = rows.reduce((sum, row) => sum + row.libyears, 0);
	const stalest = rows.reduce<LibyearRow | null>(
		(worst, row) => (worst === null || row.libyears > worst.libyears ? row : worst),
		null
	);
	return {
		rows,
		totals: { libyears: totals, stalest: stalest?.pkg ?? null }
	};
}
