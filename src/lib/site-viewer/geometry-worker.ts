/**
 * One entry point for the geometry worker.
 *
 * Both callers — the viewer tessellating, and the cost panel simulating — need
 * the same worker, created the same guarded way. A sandboxed iframe blocks a
 * direct worker URL, so the script is fetched and handed over as a blob, with a
 * main-thread fallback when even that is unavailable.
 */

import workerUrl from './site_viewer.worker.ts?worker&url';
import type { GeometrySimulation } from '../reclamation/simulation.js';
import type {
	ReconstructionMetrics,
	SiteSurfaces,
	StitchedModel,
	SubstrateQuantity
} from '../reclamation/types.js';

type Response =
	| { type: 'ready' }
	| { type: 'surfaces'; surfaces: SiteSurfaces }
	| { type: 'simulated'; quantities: SubstrateQuantity[]; metrics: ReconstructionMetrics }
	| { type: 'error'; error: string };

async function runInWorker<T>(request: unknown, take: (message: Response) => T | null): Promise<T> {
	const response = await fetch(new URL(workerUrl, import.meta.url).href);
	const blob = new Blob([await response.text()], { type: 'application/javascript' });
	const worker = new Worker(URL.createObjectURL(blob), { name: 'reclamation-geometry' });
	return new Promise<T>((resolve, reject) => {
		worker.onmessage = (event: MessageEvent<Response>) => {
			if (event.data.type === 'ready') return;
			worker.terminate();
			const value = take(event.data);
			if (value !== null) resolve(value);
			else reject(new Error(event.data.type === 'error' ? event.data.error : 'Worker failed.'));
		};
		worker.onerror = (event) => {
			worker.terminate();
			reject(new Error(event.message || 'The geometry worker failed to start.'));
		};
		worker.postMessage(request);
	});
}

export async function tessellate(
	model: StitchedModel,
	renderCellM?: number
): Promise<SiteSurfaces> {
	try {
		return await runInWorker({ type: 'build', model, renderCellM }, (message) =>
			message.type === 'surfaces' ? message.surfaces : null
		);
	} catch {
		const { buildSurfaces } = await import('../reclamation/solids.js');
		return buildSurfaces(
			renderCellM ? { ...model, settings: { ...model.settings, renderCellM } } : model
		);
	}
}

export async function simulate(
	model: StitchedModel,
	simulation: GeometrySimulation
): Promise<{ quantities: SubstrateQuantity[]; metrics: ReconstructionMetrics }> {
	try {
		return await runInWorker({ type: 'simulate', model, simulation }, (message) =>
			message.type === 'simulated'
				? { quantities: message.quantities, metrics: message.metrics }
				: null
		);
	} catch {
		const [{ integrateSite }, { applySimulation }] = await Promise.all([
			import('../reclamation/solids.js'),
			import('../reclamation/simulation.js')
		]);
		return integrateSite(applySimulation(model, simulation));
	}
}
