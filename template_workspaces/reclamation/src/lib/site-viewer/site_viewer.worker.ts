/// <reference lib="webworker" />

/**
 * Tessellation worker.
 *
 * The stitched model is compact; the surfaces built from it are not. Building
 * them here keeps a multi-hundred-thousand-triangle rebuild off the main thread,
 * and the typed arrays are transferred rather than copied.
 */

import { buildSurfaces } from '../reclamation/solids.js';
import type { StitchedModel } from '../reclamation/types.js';

type BuildMessage = {
	readonly type: 'build';
	readonly model: StitchedModel;
	/** Optional per-request resolution, so quality can change without a re-stitch. */
	readonly renderCellM?: number;
};

const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.onmessage = (event: MessageEvent<BuildMessage>) => {
	if (event.data?.type !== 'build') return;
	try {
		const requested = event.data.renderCellM;
		const model =
			typeof requested === 'number' && Number.isFinite(requested) && requested > 0
				? {
						...event.data.model,
						settings: { ...event.data.model.settings, renderCellM: requested }
					}
				: event.data.model;
		const surfaces = buildSurfaces(model);
		// Typed arrays built in this worker are always backed by a plain
		// ArrayBuffer, so they can be handed over instead of copied.
		const transfer = [
			...surfaces.meshes.flatMap((mesh) => [mesh.positions, mesh.normals, mesh.indices]),
			...surfaces.cuts.map((cut) => cut.points)
		].map((view) => view.buffer as ArrayBuffer);
		scope.postMessage({ type: 'surfaces', surfaces }, transfer);
	} catch (error) {
		scope.postMessage({
			type: 'error',
			error: error instanceof Error ? error.message : String(error)
		});
	}
};

scope.postMessage({ type: 'ready' });
