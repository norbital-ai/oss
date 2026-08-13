/**
 * In-process automation orchestration for `pod start`.
 *
 * Core drives the same guest protocol with DBOS. Standalone has no DBOS, and must not put authored
 * automations on `workspaceJobs()` — Core registers that set with pg-boss, which is infrastructure
 * only. This module is wired only from the standalone adapter.
 */
import type { NorbitalManifest } from '@norbital-ai/platform-utils/manifest/types';
import type { HostAiBinding } from '@norbital-ai/platform-utils/runtime/binding';
import type { DurableHostEffectRequest, QueueJob } from '../host/types.js';
import type { RuntimeDispatch } from '../host/jobs.js';

export const STANDALONE_AUTOMATION_ARTIFACT = {
	artifactId: 'standalone',
	checkpointId: 'standalone',
	treeHash: 'standalone',
	runtimeVersion: 'standalone'
} as const;

const STANDALONE_PUMP_JOB = 'pod:standalone-automation-pump';

type AutomationAdmission = {
	readonly epoch: string;
	readonly receipts: readonly {
		readonly receiptId: string;
		readonly artifact: {
			readonly artifactId: string;
			readonly checkpointId: string;
			readonly treeHash: string;
			readonly runtimeVersion: string;
		};
	}[];
};

type AutomationStepOutcome =
	| { readonly status: 'completed'; readonly receiptId: string }
	| { readonly status: 'failed'; readonly receiptId: string; readonly error: string }
	| {
			readonly status: 'waiting_effect';
			readonly receiptId: string;
			readonly effectId: string;
			readonly request: DurableHostEffectRequest;
	  };

export type StandaloneAutomationJobOptions = {
	readonly dispatch: RuntimeDispatch;
	readonly manifest: NorbitalManifest;
	readonly ai?: HostAiBinding;
};

function scheduledOccurrenceId(now: Date): string {
	return now.toISOString().slice(0, 16);
}

async function executeStandaloneHostEffect(
	ai: HostAiBinding | undefined,
	request: DurableHostEffectRequest
): Promise<
	| { readonly status: 'succeeded'; readonly result: unknown }
	| { readonly status: 'failed'; readonly error: string }
> {
	if (!ai) {
		return { status: 'failed', error: 'Standalone host did not provide an ai facility' };
	}
	try {
		switch (request.kind) {
			case 'ai.prompt': {
				if (request.images && request.images.length > 0) {
					return {
						status: 'failed',
						error: 'Standalone automations cannot load authorized images for ai.prompt'
					};
				}
				const result = await ai.chat({
					messages: [{ role: 'user', content: request.prompt }],
					...(request.outputSchema ? { outputSchema: request.outputSchema } : {}),
					...(request.model ? { model: request.model } : {}),
					...(request.profile ? { profile: request.profile } : {})
				});
				return { status: 'succeeded', result };
			}
			case 'ai.turn': {
				const result = await ai.chat({
					messages: request.system
						? [{ role: 'system', content: request.system }, ...request.messages]
						: request.messages,
					...(request.tools ? { tools: request.tools } : {}),
					...(request.model ? { model: request.model } : {}),
					...(request.profile ? { profile: request.profile } : {})
				});
				return { status: 'succeeded', result };
			}
			default: {
				const _exhaustive: never = request;
				return {
					status: 'failed',
					error: `Unhandled standalone automation effect kind: ${JSON.stringify(_exhaustive)}`
				};
			}
		}
	} catch (cause) {
		return { status: 'failed', error: cause instanceof Error ? cause.message : String(cause) };
	}
}

async function pumpReceipt(
	options: StandaloneAutomationJobOptions,
	receiptId: string
): Promise<void> {
	for (let step = 0; step < 64; step += 1) {
		const outcome = (await options.dispatch({
			kind: 'automation-events',
			action: 'run',
			receiptId,
			artifact: STANDALONE_AUTOMATION_ARTIFACT
		})) as AutomationStepOutcome;
		if (outcome.status === 'completed') return;
		if (outcome.status === 'failed') {
			throw new Error(outcome.error);
		}
		if (outcome.status !== 'waiting_effect' || !outcome.effectId) {
			throw new Error(`Unexpected standalone automation step: ${JSON.stringify(outcome)}`);
		}
		const effectOutcome = await executeStandaloneHostEffect(options.ai, outcome.request);
		await options.dispatch({
			kind: 'automation-events',
			action: 'settle',
			receiptId,
			effectId: outcome.effectId,
			artifact: STANDALONE_AUTOMATION_ARTIFACT,
			outcome: effectOutcome
		});
	}
	throw new Error(`Standalone automation receipt ${receiptId} exceeded 64 durable steps`);
}

async function pumpAdmittedReceipts(options: StandaloneAutomationJobOptions): Promise<void> {
	const admission = (await options.dispatch({
		kind: 'automation-events',
		action: 'admit',
		artifact: STANDALONE_AUTOMATION_ARTIFACT,
		limit: 50
	})) as AutomationAdmission;
	for (const receipt of admission.receipts) {
		await pumpReceipt(options, receipt.receiptId);
	}
}

/**
 * Jobs the standalone adapter appends after `workspaceJobs()`.
 *
 * Continuous pump admits guest receipts (interactive chat, channel inbound, collection events) and
 * drives each through run/settle. One cron job per authored schedule admits that occurrence; the
 * pump then executes it.
 */
export function standaloneAutomationJobs(
	options: StandaloneAutomationJobOptions
): readonly QueueJob[] {
	const jobs: QueueJob[] = [
		{
			name: STANDALONE_PUMP_JOB,
			schedule: 'continuous',
			run: () => pumpAdmittedReceipts(options)
		}
	];
	for (const [automationName, automation] of Object.entries(options.manifest.automations ?? {})) {
		if (!('schedule' in automation.trigger)) continue;
		jobs.push({
			name: `pod:standalone-schedule:${automationName}`,
			schedule: automation.trigger.schedule,
			run: async () => {
				await options.dispatch({
					kind: 'automation',
					action: 'admit',
					automationName,
					occurrenceId: scheduledOccurrenceId(new Date()),
					artifact: STANDALONE_AUTOMATION_ARTIFACT
				});
			}
		});
	}
	return jobs;
}
