/**
 * Minimal DXF reader for survey deliverables.
 *
 * A DXF file is a flat stream of `(group code, value)` pairs. Only the entity
 * kinds that carry reclamation geometry are decoded: closed and open polylines,
 * lines, points, and single-line text. Blocks, splines, hatches, dimensions, and
 * 3D solids are ignored — an ignored entity is reported rather than guessed at,
 * so nothing silently disappears from the model.
 *
 * Native DWG is decoded by the server-side LibreDWG normaliser and then mapped
 * into this same entity model before extraction.
 */

export type DxfEntityType = 'LWPOLYLINE' | 'POLYLINE' | 'LINE' | 'POINT' | 'TEXT' | 'MTEXT';

export type DxfEntity = {
	readonly type: DxfEntityType;
	readonly layer: string;
	/** `[x, y, z]` triples; `z` is 0 when the entity carries no elevation. */
	readonly vertices: readonly (readonly [number, number, number])[];
	readonly closed: boolean;
	readonly text?: string;
};

export type DxfDocument = {
	readonly entities: readonly DxfEntity[];
	readonly layers: readonly string[];
	/** Entity types present in the file but not decoded, with counts. */
	readonly skipped: Readonly<Record<string, number>>;
	/** `$INSUNITS` header value; 6 = metres. */
	readonly insUnits: number | null;
};

const DECODED = new Set<string>(['LWPOLYLINE', 'POLYLINE', 'LINE', 'POINT', 'TEXT', 'MTEXT']);

type Pair = { readonly code: number; readonly value: string };

function toPairs(text: string): Pair[] {
	const lines = text.split(/\r\n|\r|\n/);
	const pairs: Pair[] = [];
	for (let index = 0; index + 1 < lines.length; index += 2) {
		const code = Number(lines[index].trim());
		if (!Number.isFinite(code)) continue;
		pairs.push({ code, value: lines[index + 1] ?? '' });
	}
	return pairs;
}

type EntityDraft = {
	type: string;
	layer: string;
	xs: number[];
	ys: number[];
	zs: number[];
	flags: number;
	text?: string;
};

function draftToEntity(draft: EntityDraft): DxfEntity | null {
	if (!DECODED.has(draft.type)) return null;
	const count = Math.max(draft.xs.length, draft.ys.length);
	const vertices: [number, number, number][] = [];
	for (let index = 0; index < count; index++) {
		const x = draft.xs[index];
		const y = draft.ys[index];
		if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
		vertices.push([x, y, Number.isFinite(draft.zs[index]) ? draft.zs[index] : 0]);
	}
	if (vertices.length === 0 && draft.type !== 'TEXT' && draft.type !== 'MTEXT') return null;
	return {
		type: draft.type as DxfEntityType,
		layer: draft.layer,
		vertices,
		closed: (draft.flags & 1) === 1,
		...(draft.text === undefined ? {} : { text: draft.text })
	};
}

/**
 * Decode a DXF file.
 *
 * `LINE` carries its second endpoint on codes 11/21/31, so those are appended as
 * a second vertex. `POLYLINE` stores its vertices in following `VERTEX` entities,
 * which are folded back into the owning polyline.
 */
export function parseDxf(text: string): DxfDocument {
	const pairs = toPairs(text);
	const entities: DxfEntity[] = [];
	const layers = new Set<string>();
	const skipped: Record<string, number> = {};

	let insUnits: number | null = null;
	let section: string | null = null;
	let tableName: string | null = null;
	let draft: EntityDraft | null = null;
	let polyline: EntityDraft | null = null;
	let headerVariable: string | null = null;

	const flush = (): void => {
		if (!draft) return;
		if (draft.type === 'VERTEX') {
			if (polyline) {
				polyline.xs.push(draft.xs[0]);
				polyline.ys.push(draft.ys[0]);
				polyline.zs.push(draft.zs[0]);
			}
			draft = null;
			return;
		}
		if (draft.type === 'SEQEND') {
			if (polyline) {
				const entity = draftToEntity(polyline);
				if (entity) entities.push(entity);
				polyline = null;
			}
			draft = null;
			return;
		}
		if (draft.type === 'POLYLINE') {
			polyline = draft;
			draft = null;
			return;
		}
		const entity = draftToEntity(draft);
		if (entity) entities.push(entity);
		else if (section === 'ENTITIES') {
			// Only real drawing entities count as skipped; table and header records
			// are structure, not lost geometry.
			skipped[draft.type] = (skipped[draft.type] ?? 0) + 1;
		}
		draft = null;
	};

	for (const { code, value } of pairs) {
		if (code === 0) {
			flush();
			const type = value.trim().toUpperCase();
			if (type === 'SECTION' || type === 'ENDSEC' || type === 'EOF') {
				if (type !== 'SECTION') section = null;
				draft = { type, layer: '0', xs: [], ys: [], zs: [], flags: 0 };
				continue;
			}
			if (type === 'TABLE' || type === 'ENDTAB') {
				if (type === 'ENDTAB') tableName = null;
				draft = { type, layer: '0', xs: [], ys: [], zs: [], flags: 0 };
				continue;
			}
			draft = { type, layer: '0', xs: [], ys: [], zs: [], flags: 0 };
			continue;
		}
		if (code === 2) {
			if (draft?.type === 'SECTION') {
				section = value.trim().toUpperCase();
				draft = null;
				continue;
			}
			if (draft?.type === 'TABLE') {
				tableName = value.trim().toUpperCase();
				draft = null;
				continue;
			}
			if (draft?.type === 'LAYER' && tableName === 'LAYER') {
				layers.add(value.trim());
				continue;
			}
		}
		if (section === 'HEADER') {
			if (code === 9) {
				headerVariable = value.trim().toUpperCase();
				continue;
			}
			if (headerVariable === '$INSUNITS' && code === 70) {
				insUnits = Number(value);
				headerVariable = null;
				continue;
			}
		}
		if (!draft) continue;
		switch (code) {
			case 8:
				draft.layer = value.trim();
				layers.add(draft.layer);
				break;
			case 10:
				draft.xs.push(Number(value));
				break;
			case 20:
				draft.ys.push(Number(value));
				break;
			case 30:
				draft.zs.push(Number(value));
				break;
			case 11:
				draft.xs.push(Number(value));
				break;
			case 21:
				draft.ys.push(Number(value));
				break;
			case 31:
				draft.zs.push(Number(value));
				break;
			case 70:
				draft.flags = Number(value) || 0;
				break;
			case 1:
				draft.text = value;
				break;
			case 3:
				draft.text = `${draft.text ?? ''}${value}`;
				break;
			default:
				break;
		}
	}
	flush();
	if (polyline) {
		const entity = draftToEntity(polyline);
		if (entity) entities.push(entity);
	}

	return {
		entities,
		layers: [...layers].sort(),
		skipped,
		insUnits
	};
}

/** Entities on one layer, matched case-insensitively. */
export function entitiesOnLayer(
	document: DxfDocument,
	layer: string,
	types?: readonly DxfEntityType[]
): readonly DxfEntity[] {
	const target = layer.trim().toLowerCase();
	return document.entities.filter(
		(entity) =>
			entity.layer.trim().toLowerCase() === target && (!types || types.includes(entity.type))
	);
}

/** Elevation callouts such as `FINAL PLATFORM +5.5m CD` → `5.5`. */
export function readLevelAnnotation(text: string): number | null {
	const match = text.match(/([+-]?\d+(?:\.\d+)?)\s*m(?:\s*(?:CD|AD|ACD|MSL))?/i);
	if (!match) return null;
	const value = Number(match[1]);
	return Number.isFinite(value) ? value : null;
}

/** Slope callouts such as `1V:3H` anywhere in an annotation. */
export function readSlopeAnnotation(text: string): string | null {
	const match = text.match(/\d+(?:\.\d+)?\s*[Vv]\s*:\s*\d+(?:\.\d+)?\s*[Hh]/);
	return match ? match[0] : null;
}
