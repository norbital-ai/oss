type AppMetadata = Readonly<{
	readonly title: string | null;
	readonly description: string | null;
	readonly icon: string | null;
	readonly thumbnail: string | null;
	readonly banner: string | null;
}>;

const HTML_ENTITIES: Readonly<Record<string, string>> = {
	amp: '&',
	lt: '<',
	gt: '>',
	quot: '"',
	apos: "'"
};

/** Decodes the HTML entities Svelte emits in static `<title>` text. */
const decodeHtmlEntities = (value: string | null): string | null => {
	if (value === null) return null;
	return value.replaceAll(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
		if (entity.startsWith('#x') || entity.startsWith('#X')) {
			const code = Number.parseInt(entity.slice(2), 16);
			return Number.isFinite(code) ? String.fromCodePoint(code) : match;
		}
		if (entity.startsWith('#')) {
			const code = Number.parseInt(entity.slice(1), 10);
			return Number.isFinite(code) ? String.fromCodePoint(code) : match;
		}
		return HTML_ENTITIES[entity.toLowerCase()] ?? match;
	});
};

const taggedMeta = (source: string, name: string): string | null => {
	const tag = source.match(new RegExp(`<meta\\b[^>]*\\bname=["']bolt:${name}["'][^>]*>`, 'i'))?.[0];
	if (tag === undefined) return null;
	return tag.match(/\bcontent=["']([^"']+)["']/)?.[1]?.trim() ?? null;
};

const namedMeta = (source: string, name: string): string | null => {
	const tag = source.match(new RegExp(`<meta\\b[^>]*\\bname=["']${name}["'][^>]*>`, 'i'))?.[0];
	if (tag === undefined) return null;
	return tag.match(/\bcontent=["']([^"']+)["']/)?.[1]?.trim() ?? null;
};

/** Reads static app identity from `<svelte:head>`. */
export const extractAppMetadata = (source: string): AppMetadata => ({
	title: decodeHtmlEntities(source.match(/<title>([^<]*)<\/title>/i)?.[1]?.trim() ?? null),
	description: namedMeta(source, 'description'),
	icon: taggedMeta(source, 'icon'),
	thumbnail: taggedMeta(source, 'thumbnail'),
	banner: taggedMeta(source, 'banner')
});

type GroupMetadata = Readonly<{
	readonly label: string | null;
	readonly description: string | null;
	readonly icon: string | null;
	readonly defaultChild: string | null;
}>;

const quotedField = (source: string, name: string): string | null =>
	source.match(new RegExp(`${name}\\s*:\\s*['"]([^'"]+)['"]`))?.[1]?.trim() ?? null;

/** Reads `group({ label, icon, defaultChild })` from an authored `+group.ts`. */
export const extractGroupMetadata = (source: string): GroupMetadata => ({
	label: quotedField(source, 'label'),
	// A group declares a description and this dropped it, so a group heading on the overview had a
	// title and nothing under it while `+group.ts` had said exactly what the group is for.
	description: quotedField(source, 'description'),
	icon: quotedField(source, 'icon'),
	defaultChild: quotedField(source, 'defaultChild')
});
