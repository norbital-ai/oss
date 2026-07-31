/**
 * What each drawn surface is, in one sentence.
 *
 * The layer list is the legend for the solid, and a legend that only names its
 * entries leaves you guessing which of two sand-coloured bodies is the fill and
 * which is the ground it was keyed into. Kept beside the viewer rather than in
 * the engine: these describe what is *drawn*, not what is measured.
 */
export const SURFACE_NOTE: Record<string, string> = {
	armor:
		'The rock armour blanket on the seaward face, drawn at the thickness the section dimensions, measured perpendicular to the slope.',
	crest: 'The perimeter bund crest between the armoured face and the platform behind it.',
	platform: 'The finished reclaimed surface, at the platform level the section gives.',
	skirt:
		'The face of the fill where it meets the existing ground — the closing wall between the design surface and the surveyed bed.',
	subgrade:
		'Ground excavated below the existing bed before any fill was placed: the key trenches the section drops beneath the seabed, which anchor the works rather than letting them rest on it.',
	seabed: 'The surveyed bed, drawn at the survey’s own resolution rather than decimated.',
	structure: 'A pre-existing structure standing inside the footprint, which displaces new fill.',
	lagoon: 'A containment pond still open inside the bund, carrying no fill.',
	existing_land: 'Land already in place adjoining the works.',
	context: 'Adjacent and future works, drawn for orientation and not measured.',
	sea: 'Still water level, for reference against Chart Datum.'
};
