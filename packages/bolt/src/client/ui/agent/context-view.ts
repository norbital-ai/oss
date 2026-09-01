import type { AgentPlanRow, AgentRunRow, PanelMessage } from './transcript.js';

export type CompactOrigin = 'automatic' | 'manual' | 'unresolved';

export type AgentContextView = Readonly<{
	checkpoint: PanelMessage | null;
	checkpointOrigin: CompactOrigin | null;
	focusMessages: readonly PanelMessage[];
	outsideMessageIds: ReadonlySet<string>;
	detailMessageIds: ReadonlySet<string>;
}>;

const compactCheckpoint = (messages: readonly PanelMessage[]): PanelMessage | null =>
	messages.findLast((message) => message.annotation?.tag === 'compact') ?? null;

/** Derives manual/automatic Compact provenance from the canonical owning run. */
export function compactOrigin(
	checkpoint: PanelMessage,
	runs: readonly AgentRunRow[]
): CompactOrigin {
	if (checkpoint.annotation?.tag !== 'compact' || checkpoint.runId === null) {
		return 'unresolved';
	}
	const run = runs.find((candidate) => candidate.id === checkpoint.runId);
	if (run?.mode === 'compact') return 'manual';
	if (run?.mode === 'agent') return 'automatic';
	return 'unresolved';
}

/**
 * Mirrors the durable Plan/Compact context boundary used by TaskRuntime, then separates detailed
 * Plan/Compact turns from the focused conversation. Nothing is deleted from the full transcript.
 */
export function projectAgentContextView(input: Readonly<{
	messages: readonly PanelMessage[];
	runs: readonly AgentRunRow[];
	activePlan?: AgentPlanRow | undefined;
}>): AgentContextView {
	const latestCheckpoint = compactCheckpoint(input.messages);
	const planCutoff = input.activePlan?.checkpoint_sequence ?? null;
	const checkpoint =
		latestCheckpoint !== null &&
		(planCutoff === null || latestCheckpoint.sequence > planCutoff)
			? latestCheckpoint
			: null;
	const retained =
		latestCheckpoint?.annotation?.tag === 'compact'
			? new Set<string>(latestCheckpoint.annotation.retainedMessageIds)
			: new Set<string>();
	const compactCutoff =
		latestCheckpoint?.annotation?.tag === 'compact' ? latestCheckpoint.annotation.cutoff : null;
	const outsideMessageIds = new Set<string>();
	const detailMessageIds = new Set<string>();
	const runModes = new Map(input.runs.map((run) => [String(run.id), run.mode] as const));

	for (const message of input.messages) {
		const afterCompact =
			compactCutoff === null ||
			message.sequence > compactCutoff ||
			message.id === latestCheckpoint?.id ||
			retained.has(message.id);
		const afterPlan = planCutoff === null || message.sequence > planCutoff;
		if (!afterCompact || !afterPlan) outsideMessageIds.add(message.id);

		const runMode = message.runId === null ? undefined : runModes.get(message.runId);
		if (
			runMode === 'plan' ||
			runMode === 'compact' ||
			message.annotation?.tag === 'compact'
		) {
			detailMessageIds.add(message.id);
		}
	}

	return {
		checkpoint,
		checkpointOrigin: checkpoint === null ? null : compactOrigin(checkpoint, input.runs),
		focusMessages: input.messages.filter(
			(message) =>
				!outsideMessageIds.has(message.id) && !detailMessageIds.has(message.id)
		),
		outsideMessageIds,
		detailMessageIds
	};
}

/** Reads display text without exposing raw tool payloads in the focused context summary. */
export function plainMessageText(message: PanelMessage): string {
	if (typeof message.message.content === 'string') return message.message.content;
	return message.message.content
		.filter((part) => part.type === 'text')
		.map((part) => part.text)
		.join('\n');
}

/** Returns editable plain user text without dropping files or other canonical message parts. */
export function editableUserMessageText(message: PanelMessage): string | null {
	if (message.author.kind !== 'human' || message.message.role !== 'user') return null;
	if (typeof message.message.content === 'string') return message.message.content;
	if (message.message.content.some((part) => part.type !== 'text')) return null;
	return plainMessageText(message);
}
