/**
 * Server-side driver for the reconstruction.
 *
 * Kept free of generated types so it can be reasoned about (and unit tested) on
 * its own: the hook supplies an asset reader, a reader for previous runs, and a
 * writer, and this module decides whether a stitch is needed and what to record.
 */

import type { RawDocument, StitchOverrides } from '../../../lib/reclamation/extract.js';
import { sha256Hex } from '../../../lib/reclamation/hash.js';
import { DEFAULT_STITCH_SETTINGS, stitch } from '../../../lib/reclamation/stitch.js';
import type { DocumentKind, StitchSettings } from '../../../lib/reclamation/types.js';

export type ProjectDocumentFields = {
	readonly norbital_id: string;
	readonly floor_plan_document?: string | null;
	readonly bathymetry_document?: string | null;
	readonly cross_section_document?: string | null;
	readonly interpolation?: string | null;
	readonly integration_cell_m?: number | null;
	readonly render_cell_m?: number | null;
	readonly stitch_overrides?: string | null;
};

export type FileAsset = {
	readonly id: string;
	readonly name: string;
	readonly mimeType: string | null;
	readonly size: number;
	readonly bytes: Uint8Array;
};

/** A `project_documents` row that the stitch is allowed to read. */
export type ExtraDocument = {
	readonly norbital_id: string;
	readonly document_file?: string | null;
	readonly document_role?: string | null;
	readonly title?: string | null;
};

export type PreviousRun = {
	readonly revision?: number | null;
	readonly report_json?: string | null;
	readonly status?: string | null;
};

export type StitchDriver = {
	readonly readFileAsset: (assetId: string) => Promise<FileAsset>;
	readonly previousRuns: (projectId: string) => Promise<readonly PreviousRun[]>;
	readonly writeReconstruction: (payload: Record<string, unknown>) => Promise<unknown>;
	/** Reconstruction-category documents attached to the project, if any. */
	readonly extraDocuments?: (projectId: string) => Promise<readonly ExtraDocument[]>;
};

const DOCUMENT_FIELD: Record<DocumentKind, keyof ProjectDocumentFields> = {
	floor_plan: 'floor_plan_document',
	bathymetry: 'bathymetry_document',
	cross_section: 'cross_section_document'
};

/** Parse the project's override blob, rejecting anything that is not an object. */
export function parseOverrides(raw: string | null | undefined): StitchOverrides {
	if (raw == null || raw.trim() === '') return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new Error(
			`Stitch overrides must be valid JSON: ${error instanceof Error ? error.message : String(error)}`
		);
	}
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		throw new Error('Stitch overrides must be a JSON object.');
	}
	return parsed as StitchOverrides;
}

export function resolveSettings(project: ProjectDocumentFields): StitchSettings {
	const interpolation =
		project.interpolation === 'prismatic' || project.interpolation === 'morph'
			? project.interpolation
			: DEFAULT_STITCH_SETTINGS.interpolation;
	const clampCell = (value: number | null | undefined, fallback: number): number =>
		typeof value === 'number' && Number.isFinite(value) && value > 0
			? Math.max(0.5, Math.min(100, value))
			: fallback;
	return {
		...DEFAULT_STITCH_SETTINGS,
		interpolation,
		integrationCellM: clampCell(
			project.integration_cell_m,
			DEFAULT_STITCH_SETTINGS.integrationCellM
		),
		renderCellM: clampCell(project.render_cell_m, DEFAULT_STITCH_SETTINGS.renderCellM)
	};
}

/**
 * Identity of the inputs a run was built from.
 *
 * `update.after` does not receive the previous row, so the cheapest correct test
 * for "does this need re-stitching?" is to compare this fingerprint against the
 * one recorded on the last run.
 */
export async function inputFingerprint(
	project: ProjectDocumentFields,
	extras: readonly ExtraDocument[] = []
): Promise<string> {
	const settings = resolveSettings(project);
	const overridesDigest = (await sha256Hex(project.stitch_overrides ?? '')).slice(0, 16);
	const extraKey = extras
		.map((entry) => `${entry.document_role ?? ''}:${entry.document_file ?? ''}`)
		.sort()
		.join(',');
	return [
		project.floor_plan_document ?? '',
		project.bathymetry_document ?? '',
		project.cross_section_document ?? '',
		settings.interpolation,
		settings.integrationCellM,
		settings.renderCellM,
		overridesDigest,
		(await sha256Hex(extraKey)).slice(0, 16)
	].join('|');
}

function fingerprintOfRun(run: PreviousRun): string | null {
	if (!run.report_json) return null;
	try {
		const report: unknown = JSON.parse(run.report_json);
		if (typeof report !== 'object' || report === null) return null;
		const value = (report as { inputFingerprint?: unknown }).inputFingerprint;
		return typeof value === 'string' ? value : null;
	} catch {
		return null;
	}
}

export function missingDocuments(project: ProjectDocumentFields): DocumentKind[] {
	return (Object.keys(DOCUMENT_FIELD) as DocumentKind[]).filter((kind) => {
		const value = project[DOCUMENT_FIELD[kind]];
		return typeof value !== 'string' || value.trim() === '';
	});
}

async function loadDocuments(
	project: ProjectDocumentFields,
	driver: StitchDriver
): Promise<Record<DocumentKind, RawDocument>> {
	const kinds = Object.keys(DOCUMENT_FIELD) as DocumentKind[];
	const loaded = await Promise.all(
		kinds.map(async (kind) => {
			const assetId = project[DOCUMENT_FIELD[kind]] as string;
			const asset = await driver.readFileAsset(assetId);
			const document: RawDocument = {
				kind,
				assetId: asset.id,
				fileName: asset.name,
				mimeType: asset.mimeType,
				bytes: asset.bytes,
				sha256: await sha256Hex(asset.bytes)
			};
			return [kind, document] as const;
		})
	);
	return Object.fromEntries(loaded) as Record<DocumentKind, RawDocument>;
}

/**
 * Load the reconstruction-category attachments.
 *
 * Only the two roles the engine can act on are read. A `supporting` document is
 * filed with the reconstruction set for the record and never parsed, because
 * guessing at an unlabelled attachment is exactly what this engine does not do.
 */
async function loadExtras(
	extras: readonly ExtraDocument[],
	driver: StitchDriver
): Promise<{ sections: RawDocument[]; bathymetry: RawDocument[] }> {
	const sections: RawDocument[] = [];
	const bathymetry: RawDocument[] = [];
	for (const entry of extras) {
		const assetId = entry.document_file;
		if (typeof assetId !== 'string' || assetId === '') continue;
		const kind: DocumentKind =
			entry.document_role === 'additional_bathymetry' ? 'bathymetry' : 'cross_section';
		if (
			entry.document_role !== 'additional_bathymetry' &&
			entry.document_role !== 'additional_sections'
		) {
			continue;
		}
		const asset = await driver.readFileAsset(assetId);
		const document: RawDocument = {
			kind,
			assetId: asset.id,
			fileName: asset.name,
			mimeType: asset.mimeType,
			bytes: asset.bytes,
			sha256: await sha256Hex(asset.bytes)
		};
		(kind === 'bathymetry' ? bathymetry : sections).push(document);
	}
	return { sections, bathymetry };
}

function quantityOf(
	quantities: readonly { substrate: string; quantity: number }[],
	substrate: string
): number {
	return quantities.find((entry) => entry.substrate === substrate)?.quantity ?? 0;
}

/**
 * Stitch a project and append a reconstruction revision.
 *
 * A failed run is recorded rather than thrown away: an engineer needs to see
 * *why* three uploaded documents did not produce a solid. Nothing here mutates
 * the project row, so a stitch can never re-enter the project hooks.
 */
export async function runStitchForProject(
	project: ProjectDocumentFields,
	driver: StitchDriver,
	options: { readonly force?: boolean } = {}
): Promise<'stitched' | 'skipped' | 'failed'> {
	const missing = missingDocuments(project);
	if (missing.length > 0) return 'skipped';

	const extras = (await driver.extraDocuments?.(project.norbital_id)) ?? [];
	const previous = await driver.previousRuns(project.norbital_id);
	const fingerprint = await inputFingerprint(project, extras);
	const latest = previous[0];
	if (
		options.force !== true &&
		latest &&
		latest.status === 'ready' &&
		fingerprintOfRun(latest) === fingerprint
	) {
		return 'skipped';
	}
	const revision =
		previous.reduce((highest, run) => Math.max(highest, Number(run.revision ?? 0)), 0) + 1;
	const stitchedAt = new Date().toISOString();

	let documents: Record<DocumentKind, RawDocument>;
	let additional: { sections: RawDocument[]; bathymetry: RawDocument[] };
	try {
		documents = await loadDocuments(project, driver);
		additional = await loadExtras(extras, driver);
	} catch (error) {
		await driver.writeReconstruction({
			project_id: project.norbital_id,
			revision,
			status: 'failed',
			stitched_at: stitchedAt,
			failure_reason: `Could not read an uploaded document: ${message(error)}`,
			report_json: JSON.stringify({ inputFingerprint: fingerprint })
		});
		return 'failed';
	}

	try {
		const result = stitch({
			documents,
			additional,
			overrides: parseOverrides(project.stitch_overrides),
			settings: resolveSettings(project)
		});

		await driver.writeReconstruction({
			project_id: project.norbital_id,
			revision,
			status: 'ready',
			stitched_at: stitchedAt,
			engine_version: result.report.engineVersion,

			platform_area_m2: result.metrics.platformAreaM2,
			works_footprint_m2: result.metrics.worksFootprintM2,
			armor_face_area_m2: result.metrics.armorFaceAreaM2,
			shoreline_length_m: result.metrics.shorelineLengthM,
			mean_fill_depth_m: result.metrics.meanFillDepthM,
			max_fill_depth_m: result.metrics.maxFillDepthM,
			integration_cell_m: result.metrics.integrationCellM,
			structure_displacement_m3: result.metrics.structureDisplacementM3,
			excavation_m3: result.metrics.excavationM3,
			placed_volume_m3: result.metrics.placedVolumeM3,

			rock_armor_m3: quantityOf(result.quantities, 'rock_armor'),
			geofabric_m2: quantityOf(result.quantities, 'geofabric'),
			dredged_rock_m3: quantityOf(result.quantities, 'dredged_rock'),
			sand_key_m3: quantityOf(result.quantities, 'sand_key'),
			sand_fill_m3: quantityOf(result.quantities, 'sand_fill'),
			dredged_fill_m3: quantityOf(result.quantities, 'dredged_fill'),

			assumption_count: result.report.assumptions.length,
			warning_count: result.report.warnings.length,

			model_json: JSON.stringify(result.model),
			quantities_json: JSON.stringify(result.quantities),
			report_json: JSON.stringify({ ...result.report, inputFingerprint: fingerprint })
		});
		return 'stitched';
	} catch (error) {
		await driver.writeReconstruction({
			project_id: project.norbital_id,
			revision,
			status: 'failed',
			stitched_at: stitchedAt,
			failure_reason: message(error),
			report_json: JSON.stringify({
				inputFingerprint: fingerprint,
				documents: Object.values(documents).map((document) => ({
					kind: document.kind,
					fileName: document.fileName,
					byteSize: document.bytes.byteLength,
					sha256: document.sha256
				}))
			})
		});
		return 'failed';
	}
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
