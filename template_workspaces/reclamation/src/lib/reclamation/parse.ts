/**
 * Document decoders: raw uploaded bytes → tabular or point data.
 *
 * These functions never interpret engineering meaning. They only turn a file
 * into numbers; `extract.ts` decides what those numbers are.
 */

import type { Point2, SeabedGrid } from './types.js';

export type Xyz = { readonly x: number; readonly y: number; readonly z: number };

const DELIMITER = /[\s,;\t]+/;

export function decodeText(bytes: Uint8Array): string {
	return new TextDecoder('utf-8', { fatal: false }).decode(bytes).replace(/^﻿/, '');
}

function isNumeric(token: string | undefined): boolean {
	return token !== undefined && token !== '' && Number.isFinite(Number(token));
}

/** Parse an `x y z` / `x,y,z` survey file. Header and comment lines are skipped. */
export function parseXyz(text: string): Xyz[] {
	const points: Xyz[] = [];
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (line === '' || line.startsWith('#') || line.startsWith('//')) continue;
		const tokens = line.split(DELIMITER);
		if (tokens.length < 3) continue;
		if (!isNumeric(tokens[0]) || !isNumeric(tokens[1]) || !isNumeric(tokens[2])) continue;
		points.push({ x: Number(tokens[0]), y: Number(tokens[1]), z: Number(tokens[2]) });
	}
	return points;
}

/** Median of the positive gaps between sorted unique values. */
function medianSpacing(values: readonly number[]): number {
	const unique = [...new Set(values.map((value) => Number(value.toFixed(4))))].sort(
		(a, b) => a - b
	);
	if (unique.length < 2) return 1;
	const gaps: number[] = [];
	for (let index = 1; index < unique.length; index++) {
		const gap = unique[index] - unique[index - 1];
		if (gap > 1e-6) gaps.push(gap);
	}
	if (gaps.length === 0) return 1;
	gaps.sort((a, b) => a - b);
	return gaps[Math.floor(gaps.length / 2)];
}

export type GridOptions = {
	/** Upper bound on grid cells, so a dense multibeam file cannot stall the hook. */
	readonly maxCells: number;
	/** Elevation used where no survey point supports a cell after hole filling. */
	readonly fallbackZ: number;
};

export type GriddedSurvey = {
	readonly grid: SeabedGrid;
	readonly pointCount: number;
	readonly filledCells: number;
	readonly requestedSpacingM: number;
	readonly appliedSpacingM: number;
};

/**
 * Resample a scattered survey onto a regular height field.
 *
 * Cells receive the mean of the points that fall inside them. Empty cells are
 * filled from their eight neighbours over three passes, then from `fallbackZ`.
 * No constant elevation is ever invented outside that documented fallback.
 */
export function griddedSurveyFromPoints(
	points: readonly Xyz[],
	options: GridOptions
): GriddedSurvey {
	if (points.length === 0) throw new Error('Bathymetry document contained no readable x y z rows.');

	let minX = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;
	for (const point of points) {
		if (point.x < minX) minX = point.x;
		if (point.x > maxX) maxX = point.x;
		if (point.y < minY) minY = point.y;
		if (point.y > maxY) maxY = point.y;
	}

	const requestedSpacing = Math.max(
		medianSpacing(points.map((point) => point.x)),
		medianSpacing(points.map((point) => point.y))
	);
	const width = Math.max(maxX - minX, requestedSpacing);
	const height = Math.max(maxY - minY, requestedSpacing);
	const cellsAtRequested = (width / requestedSpacing + 1) * (height / requestedSpacing + 1);
	const scale =
		cellsAtRequested > options.maxCells ? Math.sqrt(cellsAtRequested / options.maxCells) : 1;
	const spacing = requestedSpacing * scale;

	const nx = Math.max(2, Math.round(width / spacing) + 1);
	const ny = Math.max(2, Math.round(height / spacing) + 1);
	const sums = new Float64Array(nx * ny);
	const counts = new Uint32Array(nx * ny);

	for (const point of points) {
		const ix = Math.round((point.x - minX) / spacing);
		const iy = Math.round((point.y - minY) / spacing);
		if (ix < 0 || iy < 0 || ix >= nx || iy >= ny) continue;
		const index = iy * nx + ix;
		sums[index] += point.z;
		counts[index] += 1;
	}

	const z = new Array<number>(nx * ny).fill(Number.NaN);
	for (let index = 0; index < z.length; index++) {
		if (counts[index] > 0) z[index] = sums[index] / counts[index];
	}

	let filledCells = 0;
	for (let pass = 0; pass < 3; pass++) {
		const snapshot = [...z];
		for (let iy = 0; iy < ny; iy++) {
			for (let ix = 0; ix < nx; ix++) {
				const index = iy * nx + ix;
				if (Number.isFinite(snapshot[index])) continue;
				let sum = 0;
				let count = 0;
				for (let dy = -1; dy <= 1; dy++) {
					for (let dx = -1; dx <= 1; dx++) {
						if (dx === 0 && dy === 0) continue;
						const nyi = iy + dy;
						const nxi = ix + dx;
						if (nxi < 0 || nyi < 0 || nxi >= nx || nyi >= ny) continue;
						const value = snapshot[nyi * nx + nxi];
						if (Number.isFinite(value)) {
							sum += value;
							count += 1;
						}
					}
				}
				if (count > 0) {
					z[index] = sum / count;
					filledCells += 1;
				}
			}
		}
	}
	for (let index = 0; index < z.length; index++) {
		if (!Number.isFinite(z[index])) {
			z[index] = options.fallbackZ;
			filledCells += 1;
		}
	}

	return {
		grid: { x0: minX, y0: minY, dx: spacing, dy: spacing, nx, ny, z },
		pointCount: points.length,
		filledCells,
		requestedSpacingM: requestedSpacing,
		appliedSpacingM: spacing
	};
}

/** Read a closed or open ring of `[x, y]` pairs out of arbitrary JSON. */
export function coercePolygon(value: unknown): Point2[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const points: Point2[] = [];
	for (const entry of value) {
		if (!Array.isArray(entry) || entry.length < 2) continue;
		const x = Number(entry[0]);
		const y = Number(entry[1]);
		if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
		points.push([x, y]);
	}
	return points.length >= 2 ? points : undefined;
}

export function parseJson(text: string): Record<string, unknown> {
	const value: unknown = JSON.parse(text);
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new Error('Expected a JSON object at the document root.');
	}
	return value as Record<string, unknown>;
}
