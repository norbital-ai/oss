/**
 * In-process admit/resume for `pod start`, the reference host.
 *
 * Authored automations, collection events, interactive chat, and channel inbound are admitted
 * functions. They are not `workspaceJobs()` — that set is infrastructure crons only. This module
 * is wired only from the standalone adapter.
 */
import type { NorbitalManifest } from '@norbital-ai/platform-utils/manifest/types';
import type { HostAiBinding } from '@norbital-ai/platform-utils/runtime/binding';
import type { DurableHostEffectRequest, QueueJob } from '../host/types.js';
import type { RuntimeDispatch } from '../host/jobs.js';
import {
	settleHostReceiptEffect,
	type HostSettleQuery
} from '../host/settle-receipt-effect.js';

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
			readonly ordinal: number;
			readonly requestHash: string;
			readonly request: DurableHostEffectRequest;
	  };

export type StandaloneAutomationJobOptions = {
	readonly dispatch: RuntimeDispatch;
	readonly manifest: NorbitalManifest;
	readonly ai?: HostAiBinding;
	readonly query?: HostSettleQuery;
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
					...(request.outputSchema ? { outputSchema: request.outputSchema } : {}),
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
		if (!options.query) {
			throw new Error('Standalone automation settle requires a host database query');
		}
		await settleHostReceiptEffect(
			options.query,
			{
				receiptId,
				effectId: outcome.effectId,
				ordinal: outcome.ordinal,
				requestHash: outcome.requestHash
			},
			effectOutcome
		);
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
 * A wake fires because a cursor is waiting or a cron fired. The host then admits the same
 * functions: interactive chat, channel inbound, collection events, and authored schedules.
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
