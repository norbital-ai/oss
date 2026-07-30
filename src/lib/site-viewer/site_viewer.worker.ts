/// <reference lib="webworker" />

/**
 * Off-thread geometry worker.
 *
 * Two jobs, both pure functions of the stitched model: tessellate it for the
 * viewer, and re-integrate it under a what-if simulation. Neither re-reads a
 * document, and both call the same engine the server used, so a simulated volume
 * is directly comparable with the stored take-off.
 */

import { buildSurfaces, integrateSite } from '../reclamation/solids.js';
import { applySimulation } from '../reclamation/simulation.js';
import type { GeometrySimulation } from '../reclamation/simulation.js';
import type { StitchedModel } from '../reclamation/types.js';

type Request =
	| { readonly type: 'build'; readonly model: StitchedModel; readonly renderCellM?: number }
	| {
			readonly type: 'simulate';
			readonly model: StitchedModel;
			readonly simulation: GeometrySimulation;
	  };

const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.onmessage = (event: MessageEvent<Request>) => {
	const request = event.data;
	try {
		if (request?.type === 'build') {
			const requested = request.renderCellM;
			const model =
				typeof requested === 'number' && Number.isFinite(requested) && requested > 0
					? { ...request.model, settings: { ...request.model.settings, renderCellM: requested } }
					: request.model;
			const surfaces = buildSurfaces(model);
			// Typed arrays built here are backed by plain ArrayBuffers, so they can
			// be handed over instead of copied.
			const transfer = [
				...surfaces.meshes.flatMap((mesh) => [mesh.positions, mesh.normals, mesh.indices]),
				...surfaces.cuts.map((cut) => cut.points)
			].map((view) => view.buffer as ArrayBuffer);
			scope.postMessage({ type: 'surfaces', surfaces }, transfer);
			return;
		}
		if (request?.type === 'simulate') {
			const { quantities, metrics } = integrateSite(
				applySimulation(request.model, request.simulation)
			);
			scope.postMessage({ type: 'simulated', quantities, metrics });
			return;
		}
	} catch (error) {
		scope.postMessage({
			type: 'error',
			error: error instanceof Error ? error.message : String(error)
		});
	}
};

scope.postMessage({ type: 'ready' });
