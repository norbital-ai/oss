// Result decoding is granted by the operation that returns it, independently of model read grants.
import { canonical, sha256_hex } from '@norbital-ai/store';
import type { OperationOutputs } from '../../protocol/output-contract.ts';
import { output_contract } from '../callables/output.ts';
import type { Authority } from '../contracts.ts';
import type { EngineManifest } from '../manifest.ts';
import { schema_slice } from '../schema/plan.ts';

const outputs = (manifest: EngineManifest, names: readonly string[]): OperationOutputs => {
	const automations: Record<string, OperationOutputs['automations'][string]> = {};
	for (const name of names) {
		const spec = Object.hasOwn(manifest.automations, name) ? manifest.automations[name] : undefined;
		if (spec !== undefined) automations[name] = {
			mode: spec.mode ?? 'job', output: output_contract(manifest, spec.output)
		};
	}
	return { automations };
};

/** Only manually granted automations expose their declared result shape; visitor pages receive none. */
export const operation_output_catalog = (manifest: EngineManifest, authority: Authority): OperationOutputs =>
	outputs(manifest, authority.actor.kind === 'visitor' ? []
		: authority.admin ? Object.keys(manifest.automations) : authority.automations);

/** The existing client contract fence covers database shape AND the source identity/shape of operation results. */
export const client_contract = (manifest: EngineManifest): string => sha256_hex(canonical({
	schema: schema_slice(manifest),
	operation_outputs: outputs(manifest, Object.keys(manifest.automations))
}));
