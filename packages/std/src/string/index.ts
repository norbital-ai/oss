const INITIALISMS: Readonly<Record<string, string>> = {
	ai: 'AI',
	api: 'API',
	bca: 'BCA',
	bim: 'BIM',
	hr: 'HR',
	ui: 'UI'
};

export function humanize(str: string): string {
	return str
		.trim()
		.split(/[\s_-]+/)
		.filter(Boolean)
		.map((word) => {
			const lowercase = word.toLowerCase();
			return INITIALISMS[lowercase] ?? lowercase.charAt(0).toUpperCase() + lowercase.slice(1);
		})
		.join(' ');
}

/** Canonical user-entered search text shared by UI and server query handlers. */
export function normalizeSearchTerm(value: string): string {
	return value.trim().normalize('NFC');
}

function searchTokens(value: string): string[] {
	return value.match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** Levenshtein distance. Small inputs only — names, identifiers, search tokens. */
export function editDistance(left: string, right: string): number {
	const leftCharacters = [...left];
	const rightCharacters = [...right];
	let previous = Array.from({ length: rightCharacters.length + 1 }, (_, index) => index);
	for (const [leftIndex, leftCharacter] of leftCharacters.entries()) {
		const current = [leftIndex + 1];
		for (const [rightIndex, rightCharacter] of rightCharacters.entries()) {
			current.push(
				Math.min(
					(current[rightIndex] ?? 0) + 1,
					(previous[rightIndex + 1] ?? 0) + 1,
					(previous[rightIndex] ?? 0) + Number(leftCharacter !== rightCharacter)
				)
			);
		}
		previous = current;
	}
	return previous.at(-1) ?? rightCharacters.length;
}

function editDistanceAtMost(left: string, right: string, limit: number): boolean {
	if (Math.abs([...left].length - [...right].length) > limit) return false;
	return editDistance(left, right) <= limit;
}

/**
 * The candidate nearest to `value`, when one is close enough that a typo or a rename is the likely
 * cause — otherwise undefined.
 *
 * Shared so every "that is not a known X" diagnostic suggests names the same way: the compiler's
 * orphaned-role-directory check and the seed executor's unknown-column abort both read better as
 * "did you mean Y?" than as a bare rejection.
 */
export function nearestName(
	value: string,
	candidates: Iterable<string>,
	maxDistance = 2
): string | undefined {
	let best: { readonly name: string; readonly distance: number } | undefined;
	for (const candidate of candidates) {
		const distance = editDistance(value, candidate);
		if (!best || distance < best.distance) best = { name: candidate, distance };
	}
	return best && best.distance <= maxDistance ? best.name : undefined;
}

function searchTokenMatches(candidate: string, query: string): boolean {
	if (candidate.includes(query)) return true;
	const tolerance = query.length >= 8 ? 2 : query.length >= 4 ? 1 : 0;
	return tolerance > 0 && editDistanceAtMost(candidate, query, tolerance);
}

/** Literal contains search with bounded typo tolerance for human-entered text. */
export function textSearchMatches(value: string, search: string): boolean {
	const candidate = normalizeSearchTerm(value).toLocaleLowerCase();
	const query = normalizeSearchTerm(search).toLocaleLowerCase();
	if (!query || candidate.includes(query)) return true;
	const candidateTokens = searchTokens(candidate);
	const queryTokens = searchTokens(query);
	return (
		queryTokens.length > 0 &&
		queryTokens.every((queryToken) =>
			candidateTokens.some((candidateToken) => searchTokenMatches(candidateToken, queryToken))
		)
	);
}

/**
 * Build a literal PostgreSQL ILIKE contains pattern.
 *
 * PostgreSQL treats `\\`, `%`, and `_` specially in LIKE patterns, so escape them before adding
 * the two intentional contains wildcards.
 */
export function literalIlikeContainsPattern(value: string): string | undefined {
	const normalized = normalizeSearchTerm(value);
	if (!normalized) return undefined;
	return `%${normalized.replace(/[\\%_]/g, '\\$&')}%`;
}
