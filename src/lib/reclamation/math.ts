/**
 * Pure geometry operators. No DOM, no THREE, no I/O.
 *
 * Everything here is project-agnostic: the operators take numbers that came out
 * of a document and never contain a site dimension, a slope multiplier, or a
 * level of their own.
 */

import type { Point2, SeabedGrid, SlopeRatio } from './types.js';

/** Parse `1V:3H`, `1:3`, `1v:4h`, or an already-structured ratio. */
export function parseSlopeRatio(input: string | SlopeRatio): SlopeRatio {
	if (typeof input === 'object' && input !== null) {
		const v = Number(input.v);
		const h = Number(input.h);
		if (!Number.isFinite(v) || !Number.isFinite(h) || v === 0) {
			throw new Error(`Invalid slope ratio: ${JSON.stringify(input)}`);
		}
		return { v, h };
	}
	const text = String(input).trim();
	const match = text.match(/^(\d+(?:\.\d+)?)\s*[Vv]?\s*:\s*(\d+(?:\.\d+)?)\s*[Hh]?$/);
	if (!match) throw new Error(`Unrecognised slope "${text}" (expected e.g. "1V:3H")`);
	const v = Number(match[1]);
	const h = Number(match[2]);
	if (v === 0) throw new Error(`Slope vertical component cannot be 0: "${text}"`);
	return { v, h };
}

export function formatSlopeRatio(ratio: SlopeRatio | undefined): string {
	if (!ratio) return 'not stated';
	const h = ratio.h / ratio.v;
	return `1V:${Number(h.toFixed(3))}H`;
}

/** Horizontal run covered by a vertical rise on ratio `v:h` → `rise * h / v`. */
export function horizontalRun(riseM: number, ratio: SlopeRatio): number {
	return riseM * (ratio.h / ratio.v);
}

/** Vertical rise covered by a horizontal run on ratio `v:h` → `run * v / h`. */
export function verticalRise(runM: number, ratio: SlopeRatio): number {
	if (ratio.h === 0) throw new Error('Slope horizontal component cannot be 0');
	return runM * (ratio.v / ratio.h);
}

/**
 * Vertical thickness of a layer whose thickness is measured perpendicular to a
 * face of slope `v:h`: `t_vertical = t_perpendicular * hypot(v, h) / h`.
 *
 * Rock armour is specified perpendicular to the face; volume integration happens
 * in vertical columns, so the conversion has to be explicit.
 */
export function verticalThicknessOnSlope(
	perpendicularM: number,
	ratio: SlopeRatio | undefined
): number {
	if (!ratio || ratio.h === 0) return perpendicularM;
	return (perpendicularM * Math.hypot(ratio.v, ratio.h)) / ratio.h;
}

/** Slant length of a face rising `rise` on ratio `v:h`. */
export function slantLength(riseM: number, ratio: SlopeRatio): number {
	return Math.hypot(riseM, horizontalRun(riseM, ratio));
}

/** Shoelace area (m²) of a closed polygon given in plan metres. */
export function polygonArea(points: readonly Point2[]): number {
	if (points.length < 3) return 0;
	let sum = 0;
	for (let index = 0; index < points.length; index++) {
		const [x0, y0] = points[index];
		const [x1, y1] = points[(index + 1) % points.length];
		sum += x0 * y1 - x1 * y0;
	}
	return Math.abs(sum) / 2;
}

export function polylineLength(points: readonly Point2[]): number {
	let total = 0;
	for (let index = 0; index < points.length - 1; index++) {
		total += Math.hypot(
			points[index + 1][0] - points[index][0],
			points[index + 1][1] - points[index][1]
		);
	}
	return total;
}

/** Even-odd point-in-polygon test. Boundary membership is not guaranteed. */
export function pointInPolygon(x: number, y: number, polygon: readonly Point2[]): boolean {
	let inside = false;
	for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
		const [xi, yi] = polygon[i];
		const [xj, yj] = polygon[j];
		const intersects = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
		if (intersects) inside = !inside;
	}
	return inside;
}

export function boundingBox(points: readonly Point2[]): {
	minX: number;
	maxX: number;
	minY: number;
	maxY: number;
} {
	let minX = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;
	for (const [x, y] of points) {
		if (x < minX) minX = x;
		if (x > maxX) maxX = x;
		if (y < minY) minY = y;
		if (y > maxY) maxY = y;
	}
	return { minX, maxX, minY, maxY };
}

/** Signed shortest distance from a point to a polygon edge chain, unsigned. */
export function distanceToPolyline(x: number, y: number, points: readonly Point2[]): number {
	let best = Number.POSITIVE_INFINITY;
	for (let index = 0; index < points.length - 1; index++) {
		const [ax, ay] = points[index];
		const [bx, by] = points[index + 1];
		const dx = bx - ax;
		const dy = by - ay;
		const lengthSquared = dx * dx + dy * dy;
		const t =
			lengthSquared === 0
				? 0
				: Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / lengthSquared));
		best = Math.min(best, Math.hypot(x - (ax + t * dx), y - (ay + t * dy)));
	}
	return best;
}

/**
 * Sample a polyline that is single-valued in X, returning its Y at `x`.
 * Used for the toe line and the landward platform limit so a curved plan edge is
 * followed instead of being replaced by one constant offset.
 */
export function sampleYAlongX(points: readonly Point2[], x: number): number | undefined {
	if (points.length === 0) return undefined;
	if (points.length === 1) return points[0][1];
	const ordered = [...points].sort((a, b) => a[0] - b[0]);
	if (x <= ordered[0][0]) return ordered[0][1];
	if (x >= ordered[ordered.length - 1][0]) return ordered[ordered.length - 1][1];
	for (let index = 0; index < ordered.length - 1; index++) {
		const [x0, y0] = ordered[index];
		const [x1, y1] = ordered[index + 1];
		if (x >= x0 && x <= x1) {
			if (x1 === x0) return Math.max(y0, y1);
			const t = (x - x0) / (x1 - x0);
			return y0 + t * (y1 - y0);
		}
	}
	return ordered[ordered.length - 1][1];
}

/** Bilinear sample of the survey height field, clamped at the grid edge. */
export function sampleSeabed(grid: SeabedGrid, x: number, y: number): number {
	const { x0, y0, dx, dy, nx, ny, z } = grid;
	if (nx === 0 || ny === 0) return Number.NaN;
	if (nx === 1 || ny === 1) return z[0];
	const fx = (x - x0) / dx;
	const fy = (y - y0) / dy;
	const ix = Math.max(0, Math.min(nx - 2, Math.floor(fx)));
	const iy = Math.max(0, Math.min(ny - 2, Math.floor(fy)));
	const tx = Math.max(0, Math.min(1, fx - ix));
	const ty = Math.max(0, Math.min(1, fy - iy));
	const z00 = z[iy * nx + ix];
	const z10 = z[iy * nx + ix + 1];
	const z01 = z[(iy + 1) * nx + ix];
	const z11 = z[(iy + 1) * nx + ix + 1];
	return (z00 * (1 - tx) + z10 * tx) * (1 - ty) + (z01 * (1 - tx) + z11 * tx) * ty;
}

export function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

export function lerp(a: number, b: number, t: number): number {
	return a + (b - a) * t;
}

/** Round to a fixed number of decimals; keeps persisted JSON small and stable. */
export function round(value: number, decimals = 4): number {
	if (!Number.isFinite(value)) return 0;
	const factor = 10 ** decimals;
	return Math.round(value * factor) / factor;
}
