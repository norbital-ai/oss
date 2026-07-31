/**
 * Reading a section sheet.
 *
 * A tender drawing is a sheet, not a table of coordinates. Several sections sit
 * on one page, each plotted at its own scale, each placed wherever it fitted.
 * Nothing in the file says what a level is: the datum survives only in the
 * callout text a draughtsman put on the line — `FINAL PLATFORM LEVEL +5.5m CD`
 * sitting on the line it names — and in the figured dimensions.
 *
 * So this module works backwards from those conventions, per section:
 *
 *   1. group the geometry into sections;
 *   2. attach each section's own text — its title, its level callouts, its
 *      dimensions and its slope callouts;
 *   3. fit `level = a·y + b` to the callouts, by consensus rather than by
 *      averaging, because a sheet is full of notes that mention a level without
 *      being one;
 *   4. take the horizontal scale from a figured dimension if one is drawn, and
 *      otherwise from the vertical scale, which is right whenever the plot is
 *      isotropic — and say so when it is not;
 *   5. put station zero on the toe;
 *   6. check the result against every `1V:nH` callout on the sheet before
 *      handing it on.
 *
 * Nothing here knows a station, a level, or a section name in advance. A sheet
 * that carries no calibration at all is reported as such rather than guessed at,
 * and a drawing already authored in engineering coordinates simply calibrates to
 * the identity.
 */

import type { DxfDocument, DxfEntity } from './dxf.js';
import { canonicalRole } from './profile-layers.js';
import type { ProfilePoint } from './types.js';

/** Text that states a level: a figure in metres against a named datum. */
const LEVEL_TEXT = /([+-]?\d+(?:\.\d+)?)\s*m\s*(CD|HWM|LWM|MSL|PD|ACD|SHD|AD|LAT|MHWS)\b/i;
/** `SECTION 1 - 1`, `SEC A-A`, `SECTION 3 – 3`. */
const SECTION_TITLE = /\bSEC(?:TION)?\s+([A-Za-z0-9]+)\s*[-–—]\s*([A-Za-z0-9]+)/i;
/** `1V : 3H`, `1V:6H`. */
const SLOPE_TEXT = /(\d+(?:\.\d+)?)\s*V\s*:\s*(\d+(?:\.\d+)?)\s*H/i;
/** A bare figured dimension: `20.00m`, with no datum to make it a level. */
const DIMENSION_TEXT = /^(\d+(?:\.\d+)?)\s*m$/i;
/** Text that marks the origin of the station axis. */
const TOE_TEXT = /\bTOE\b/i;

const GEOMETRY_TYPES = new Set(['LINE', 'LWPOLYLINE', 'POLYLINE', 'POINT']);

/**
 * Layer names that hold drafting furniture rather than the works.
 *
 * Level leaders, dimension lines, grids, borders and title blocks are lines like
 * any other, and a reader that takes them for ground draws a section with a
 * sheet border across it. They are still kept — a dimension line is exactly what
 * fixes the horizontal scale — but on the calibration side, never as profile.
 */
const DRAFTING_LAYER_KEYWORDS = [
	'anno',
	'dim',
	'levl',
	'grid',
	'brdr',
	'border',
	'frame',
	'ttlb',
	'titleblock',
	'title',
	'shet',
	'sheet',
	'viewport',
	'defpoints',
	'hatch',
	'patt'
];

function isDraftingLayer(layer: string): boolean {
	const name = layer.trim().toLowerCase();
	return DRAFTING_LAYER_KEYWORDS.some((keyword) => name.includes(keyword));
}

export type SectionCalibration = {
	readonly id: string;
	readonly title?: string;
	/** Metres of level per drawing unit of y. */
	readonly metresPerUnitY: number;
	/** Metres of station per drawing unit of x. */
	readonly metresPerUnitX: number;
	/** `level = metresPerUnitY * y + datumOffsetM`. */
	readonly datumOffsetM: number;
	/** Drawing x that station zero sits on. */
	readonly stationOriginUnits: number;
	/** How many level callouts agreed with the fit, and how far off they were. */
	readonly calloutsUsed: number;
	readonly calloutsSeen: number;
	readonly residualM: number;
	readonly plottingScale?: number;
	readonly stationOrigin: 'toe-layer' | 'toe-note' | 'first-point';
	readonly isotropic: boolean;
	readonly notes: readonly string[];
};

export type SheetReading = {
	readonly profiles: Record<string, ProfilePoint[]>;
	readonly annotations: string[];
	readonly calibrations: readonly SectionCalibration[];
	/** True when the sheet carried enough text to place at least one section. */
	readonly calibrated: boolean;
};

type Box = { minX: number; minY: number; maxX: number; maxY: number };

/** Overall size of the drawing, used to scale every proximity rule to the sheet. */
type Extent = { x: number; y: number; diagonal: number };

type Group = {
	id: string;
	title?: string;
	/** The works: the lines that become profile points. */
	entities: DxfEntity[];
	/** Drafting furniture near this section, used only to calibrate it. */
	drafting: DxfEntity[];
	box: Box;
	texts: { text: string; x: number; y: number }[];
};

function boxOf(entity: DxfEntity): Box | null {
	if (entity.vertices.length === 0) return null;
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const [x, y] of entity.vertices) {
		if (x < minX) minX = x;
		if (x > maxX) maxX = x;
		if (y < minY) minY = y;
		if (y > maxY) maxY = y;
	}
	return { minX, minY, maxX, maxY };
}

function merge(a: Box, b: Box): Box {
	return {
		minX: Math.min(a.minX, b.minX),
		minY: Math.min(a.minY, b.minY),
		maxX: Math.max(a.maxX, b.maxX),
		maxY: Math.max(a.maxY, b.maxY)
	};
}

function gapTo(box: Box, x: number, y: number): number {
	const dx = Math.max(box.minX - x, 0, x - box.maxX);
	const dy = Math.max(box.minY - y, 0, y - box.maxY);
	return Math.hypot(dx, dy);
}

function gapBetween(a: Box, b: Box): number {
	const dx = Math.max(a.minX - b.maxX, b.minX - a.maxX, 0);
	const dy = Math.max(a.minY - b.maxY, b.minY - a.maxY, 0);
	return Math.hypot(dx, dy);
}

/**
 * Split a layer name into the section it belongs to and the role it plays.
 *
 * `SECTION_1-1__crest_seaward` is the explicit form. A layer that carries no
 * section is still a role — many drawing offices name layers by material alone
 * and separate the sections on the sheet instead, which is what the spatial
 * grouping below is for.
 */
export function splitLayer(layer: string): { section?: string; role: string } {
	const authored = layer
		.trim()
		.match(/^(?:SECTION|SEC)[ _:-]*([A-Za-z0-9]+(?:[-–][A-Za-z0-9]+)?)__(.+)$/i);
	if (authored) {
		return { section: authored[1].replace('–', '-'), role: canonicalRole(authored[2]) };
	}
	return { role: layer.trim() ? canonicalRole(layer) : 'grade' };
}

/**
 * Group geometry into sections.
 *
 * Layers that name their section are believed. Anything else is grouped by
 * touching: entities of one section are drawn as connected chains, and separate
 * sections are separated by clear paper. The gap that counts as "clear" scales
 * with the sheet, so the same rule works on an A1 sheet in millimetres and on a
 * drawing authored in metres.
 */
function groupGeometry(entities: readonly DxfEntity[], extent: Extent): Group[] {
	const geometry = entities.filter(
		(entity) => GEOMETRY_TYPES.has(entity.type) && !isDraftingLayer(entity.layer)
	);
	const byLayerSection = new Map<string, DxfEntity[]>();
	const loose: DxfEntity[] = [];
	for (const entity of geometry) {
		const { section } = splitLayer(entity.layer);
		if (section) byLayerSection.set(section, [...(byLayerSection.get(section) ?? []), entity]);
		else loose.push(entity);
	}

	const groups: Group[] = [];
	const build = (id: string, members: DxfEntity[]): void => {
		let box: Box | null = null;
		for (const entity of members) {
			const entityBox = boxOf(entity);
			if (!entityBox) continue;
			box = box ? merge(box, entityBox) : entityBox;
		}
		if (box) groups.push({ id, entities: members, drafting: [], box, texts: [] });
	};
	for (const [section, members] of byLayerSection) build(section, members);

	if (loose.length > 0) {
		// Connected components over bounding boxes. The sheet frame and any other
		// entity that spans the whole drawing is dropped first: it touches
		// everything, and would fuse every section into one.
		const boxes = loose.map(boxOf);
		const keep = loose.map((entity, index) => {
			const box = boxes[index];
			if (!box) return false;
			// Measured against each axis separately: a landscape sheet border is
			// nearly the full width but only ever part of the diagonal, so one
			// combined threshold lets the frame through and fuses the whole sheet.
			return !(box.maxX - box.minX > extent.x * 0.7 && box.maxY - box.minY > extent.y * 0.7);
		});
		const gap = extent.diagonal * 0.02;
		const parent = loose.map((_, index) => index);
		const find = (index: number): number => {
			let root = index;
			while (parent[root] !== root) root = parent[root];
			while (parent[index] !== root) [index, parent[index]] = [parent[index], root];
			return root;
		};
		for (let i = 0; i < loose.length; i++) {
			if (!keep[i]) continue;
			for (let j = i + 1; j < loose.length; j++) {
				if (!keep[j]) continue;
				if (gapBetween(boxes[i] as Box, boxes[j] as Box) > gap) continue;
				parent[find(i)] = find(j);
			}
		}
		const components = new Map<number, DxfEntity[]>();
		for (let i = 0; i < loose.length; i++) {
			if (!keep[i]) continue;
			const root = find(i);
			components.set(root, [...(components.get(root) ?? []), loose[i]]);
		}
		let index = 0;
		for (const members of components.values()) {
			if (members.length < 2) continue;
			build(`cluster-${++index}`, members);
		}
	}

	return groups;
}

/** Give every text entity to the section whose geometry it sits nearest. */
function attachText(groups: Group[], entities: readonly DxfEntity[], extent: Extent): string[] {
	const annotations: string[] = [];
	for (const entity of entities) {
		if (entity.type !== 'TEXT' && entity.type !== 'MTEXT') continue;
		const text = (entity.text ?? '').trim();
		if (!text) continue;
		annotations.push(text);
		const at = entity.vertices[0];
		if (!at || groups.length === 0) continue;
		let best: Group | undefined;
		let bestGap = Infinity;
		for (const group of groups) {
			const distance = gapTo(group.box, at[0], at[1]);
			if (distance < bestGap) {
				bestGap = distance;
				best = group;
			}
		}
		// A note in the margin belongs to the sheet, not to a section.
		if (!best || bestGap > extent.diagonal * 0.12) continue;
		best.texts.push({ text, x: at[0], y: at[1] });
	}

	for (const entity of entities) {
		if (!GEOMETRY_TYPES.has(entity.type) || !isDraftingLayer(entity.layer)) continue;
		const box = boxOf(entity);
		if (!box || groups.length === 0) continue;
		let best: Group | undefined;
		let bestGap = Infinity;
		for (const group of groups) {
			const distance = gapBetween(group.box, box);
			if (distance < bestGap) {
				bestGap = distance;
				best = group;
			}
		}
		if (best && bestGap <= extent.diagonal * 0.12) best.drafting.push(entity);
	}
	return annotations;
}

type LevelFit = { a: number; b: number; used: number; residual: number };

/**
 * Fit `level = a·y + b` to the level callouts by consensus.
 *
 * Least squares is wrong here. A sheet carries notes that state a level without
 * being drawn at it — "or higher than -17.0m CD as stipulated" is a sentence,
 * not a level line — and one such note drags a least-squares fit off the datum.
 * Every pair of callouts is therefore tried as a candidate, and the candidate
 * that the most other callouts agree with wins.
 */
function fitLevels(points: readonly { y: number; level: number }[]): LevelFit | null {
	if (points.length < 2) return null;
	const tolerance = 0.15;
	let best: LevelFit | null = null;
	for (let i = 0; i < points.length; i++) {
		for (let j = i + 1; j < points.length; j++) {
			const dy = points[i].y - points[j].y;
			if (Math.abs(dy) < 1e-9) continue;
			const a = (points[i].level - points[j].level) / dy;
			if (!Number.isFinite(a) || a === 0) continue;
			const b = points[i].level - a * points[i].y;
			const inliers = points.filter(
				(point) => Math.abs(a * point.y + b - point.level) <= tolerance
			);
			if (inliers.length < 2) continue;
			// Refit on the agreeing set so the answer uses all of them, not just
			// the two that proposed it.
			const meanY = inliers.reduce((sum, point) => sum + point.y, 0) / inliers.length;
			const meanLevel = inliers.reduce((sum, point) => sum + point.level, 0) / inliers.length;
			let numerator = 0;
			let denominator = 0;
			for (const point of inliers) {
				numerator += (point.y - meanY) * (point.level - meanLevel);
				denominator += (point.y - meanY) ** 2;
			}
			const slope = denominator > 1e-12 ? numerator / denominator : a;
			const intercept = meanLevel - slope * meanY;
			const residual = Math.max(
				...inliers.map((point) => Math.abs(slope * point.y + intercept - point.level))
			);
			const candidate = { a: slope, b: intercept, used: inliers.length, residual };
			if (
				!best ||
				candidate.used > best.used ||
				(candidate.used === best.used && candidate.residual < best.residual)
			) {
				best = candidate;
			}
		}
	}
	return best;
}

/** The drawing x of the toe, which is where the station axis starts. */
function stationOrigin(group: Group): {
	units: number;
	source: SectionCalibration['stationOrigin'];
} {
	let toeX: number | undefined;
	let toeY = Infinity;
	for (const entity of group.entities) {
		const { role } = splitLayer(entity.layer);
		if (!/(^|_)toe(_|$)|quay_crest/.test(role)) continue;
		for (const [x, y] of entity.vertices) {
			if (y < toeY) {
				toeY = y;
				toeX = x;
			}
		}
	}
	if (toeX !== undefined) return { units: toeX, source: 'toe-layer' };
	const note = group.texts.find((entry) => TOE_TEXT.test(entry.text));
	if (note) return { units: note.x, source: 'toe-note' };
	return { units: group.box.minX, source: 'first-point' };
}

/**
 * Horizontal scale from a figured dimension.
 *
 * A dimension is a figure beside a line whose length it states. Finding the line
 * the figure belongs to is a proximity question, so the nearest roughly
 * horizontal line to the text wins, and the scale is the figure over its length.
 */
function horizontalScale(group: Group, fallback: number): { scale: number; note?: string } {
	for (const entry of group.texts) {
		const match = entry.text.trim().match(DIMENSION_TEXT);
		if (!match) continue;
		const metres = Number(match[1]);
		if (!Number.isFinite(metres) || metres <= 0) continue;
		let bestLength: number | undefined;
		let bestGap = Infinity;
		for (const entity of [...group.drafting, ...group.entities]) {
			for (let index = 0; index < entity.vertices.length - 1; index++) {
				const [x0, y0] = entity.vertices[index];
				const [x1, y1] = entity.vertices[index + 1];
				if (Math.abs(y1 - y0) > Math.abs(x1 - x0) * 0.05) continue;
				const length = Math.abs(x1 - x0);
				if (length <= 1e-6) continue;
				const distance = Math.hypot((x0 + x1) / 2 - entry.x, (y0 + y1) / 2 - entry.y);
				if (distance < bestGap) {
					bestGap = distance;
					bestLength = length;
				}
			}
		}
		if (bestLength === undefined) continue;
		const scale = metres / bestLength;
		const drift = Math.abs(scale - fallback) / fallback;
		if (drift <= 0.02) return { scale: fallback };
		return {
			scale,
			note:
				`the "${entry.text.trim()}" dimension makes the horizontal scale ${(drift * 100).toFixed(0)}% ` +
				'different from the vertical, so the section is plotted with a distorted aspect and the two axes are read separately'
		};
	}
	return { scale: fallback };
}

/** Check the recovered frame against the slope callouts drawn on the section. */
function checkSlopes(
	group: Group,
	metresPerUnitX: number,
	metresPerUnitY: number
): string | undefined {
	const called: number[] = [];
	for (const entry of group.texts) {
		const match = entry.text.match(SLOPE_TEXT);
		if (!match) continue;
		const rise = Number(match[1]);
		const run = Number(match[2]);
		if (rise > 0 && run > 0) called.push(run / rise);
	}
	if (called.length === 0) return undefined;
	const drawn: number[] = [];
	for (const entity of group.entities) {
		for (let index = 0; index < entity.vertices.length - 1; index++) {
			const [x0, y0] = entity.vertices[index];
			const [x1, y1] = entity.vertices[index + 1];
			const rise = Math.abs((y1 - y0) * metresPerUnitY);
			const run = Math.abs((x1 - x0) * metresPerUnitX);
			if (rise < 0.5 || run < 0.5) continue;
			drawn.push(run / rise);
		}
	}
	if (drawn.length === 0) return undefined;
	const matched = called.filter((ratio) =>
		drawn.some((value) => Math.abs(value - ratio) <= Math.max(0.05, ratio * 0.02))
	);
	if (matched.length > 0) return undefined;
	return `no drawn face matches the ${called.map((r) => `1V:${r.toFixed(1)}H`).join(', ')} callout(s) after calibration`;
}

/** Read a section sheet into profiles on station and level. */
export function readSectionSheet(document: DxfDocument): SheetReading {
	const extentBox = document.entities
		.map(boxOf)
		.filter((box): box is Box => box !== null)
		.reduce<Box | null>((total, box) => (total ? merge(total, box) : box), null);
	const width = extentBox ? extentBox.maxX - extentBox.minX : 1;
	const height = extentBox ? extentBox.maxY - extentBox.minY : 1;
	const extent: Extent = {
		x: Math.max(width, 1e-6),
		y: Math.max(height, 1e-6),
		diagonal: Math.max(width, height, 1e-6)
	};

	const groups = groupGeometry(document.entities, extent);
	const annotations = attachText(groups, document.entities, extent);

	// A section's own title renames the group; a group with no title keeps the
	// name its layers gave it.
	for (const group of groups) {
		for (const entry of group.texts) {
			const match = entry.text.match(SECTION_TITLE);
			if (!match) continue;
			group.title = entry.text.trim();
			group.id = `${match[1]}-${match[2]}`;
			break;
		}
	}

	const profiles: Record<string, ProfilePoint[]> = {};
	const calibrations: SectionCalibration[] = [];
	let calibrated = false;

	for (const group of groups) {
		const callouts: { y: number; level: number }[] = [];
		for (const entry of group.texts) {
			const match = entry.text.match(LEVEL_TEXT);
			if (!match) continue;
			const level = Number(match[1]);
			if (Number.isFinite(level)) callouts.push({ y: entry.y, level });
		}
		const fit = fitLevels(callouts);
		const notes: string[] = [];

		// No callouts at all: the drawing is taken to be in engineering
		// coordinates already, which is the identity calibration.
		const metresPerUnitY = fit ? fit.a : 1;
		const datumOffsetM = fit ? fit.b : 0;
		if (fit) calibrated = true;
		else
			notes.push(
				'no level callout was found, so the section is read as already being on station and level'
			);

		const horizontal = horizontalScale(group, Math.abs(metresPerUnitY));
		if (horizontal.note) notes.push(horizontal.note);
		const metresPerUnitX = fit ? horizontal.scale : 1;

		const origin = fit ? stationOrigin(group) : { units: 0, source: 'first-point' as const };
		if (origin.source === 'first-point' && fit) {
			notes.push(
				'no toe is labelled, so station zero was put on the seaward-most point drawn rather than on a marked toe'
			);
		}

		const slopeNote = checkSlopes(group, metresPerUnitX, metresPerUnitY);
		if (slopeNote) notes.push(slopeNote);

		const points: ProfilePoint[] = (profiles[group.id] ??= []);
		for (const [entityIndex, entity] of group.entities.entries()) {
			const { role } = splitLayer(entity.layer);
			for (const [x, y] of entity.vertices) {
				points.push({
					stationM: (x - origin.units) * metresPerUnitX,
					zCdM: metresPerUnitY * y + datumOffsetM,
					layer: role,
					segmentId: `sheet-${group.id}-${entityIndex}`
				});
			}
		}

		const plottingScale =
			fit && metresPerUnitY !== 0 ? Math.round(1000 * metresPerUnitY) : undefined;
		calibrations.push({
			id: group.id,
			...(group.title ? { title: group.title } : {}),
			metresPerUnitY,
			metresPerUnitX,
			datumOffsetM,
			stationOriginUnits: origin.units,
			calloutsUsed: fit?.used ?? 0,
			calloutsSeen: callouts.length,
			residualM: fit?.residual ?? 0,
			...(plottingScale && plottingScale > 1 ? { plottingScale } : {}),
			stationOrigin: origin.source,
			isotropic: Math.abs(metresPerUnitX - Math.abs(metresPerUnitY)) < 1e-9,
			notes
		});
	}

	for (const points of Object.values(profiles)) {
		points.sort((a, b) => a.stationM - b.stationM || a.zCdM - b.zCdM);
	}

	return { profiles, annotations, calibrations, calibrated };
}
