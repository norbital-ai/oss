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

function editDistanceAtMost(left: string, right: string, limit: number): boolean {
	const leftCharacters = [...left];
	const rightCharacters = [...right];
	if (Math.abs(leftCharacters.length - rightCharacters.length) > limit) return false;
	let previous = Array.from({ length: rightCharacters.length + 1 }, (_, index) => index);
	for (const [leftIndex, leftCharacter] of leftCharacters.entries()) {
		const current = [leftIndex + 1];
		let rowMinimum = current[0] ?? 0;
		for (const [rightIndex, rightCharacter] of rightCharacters.entries()) {
			const insertion = (current[rightIndex] ?? 0) + 1;
			const deletion = (previous[rightIndex + 1] ?? 0) + 1;
			const substitution = (previous[rightIndex] ?? 0) + Number(leftCharacter !== rightCharacter);
			const distance = Math.min(insertion, deletion, substitution);
			current.push(distance);
			rowMinimum = Math.min(rowMinimum, distance);
		}
		if (rowMinimum > limit) return false;
		previous = current;
	}
	return (previous.at(-1) ?? limit + 1) <= limit;
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
