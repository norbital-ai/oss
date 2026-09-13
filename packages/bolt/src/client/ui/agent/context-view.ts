import { Schema } from 'effect';
import type { PlanRow, TurnRow, PanelMessage } from './transcript.js';

const isString = Schema.is(Schema.String);

export type CompactOrigin = 'automatic' | 'manual' | 'requested' | 'unresolved';

type AgentContextView = Readonly<{
	checkpoint: PanelMessage | null;
	checkpointOrigin: CompactOrigin | null;
	focusMessages: readonly PanelMessage[];
	historyMessages: readonly PanelMessage[];
	outsideMessageIds: ReadonlySet<string>;
	detailMessageIds: ReadonlySet<string>;
}>;

const compactCheckpoint = (messages: readonly PanelMessage[]): PanelMessage | null =>
	messages.findLast((message) => message.annotation?.tag === 'compact') ?? null;

/**
 * Who asked for this checkpoint, read from the checkpoint.
 *
 * It used to be inferred from the owning run's `mode` — `compact` meant a person, `agent` meant the
 * runtime — which was a second scanner that had to agree with the runtime's by hand, and could not
 * express the third case at all: an agent calling `compact` on itself runs in `agent` mode and would
 * have read as automatic. The annotation has always carried `origin`; now it is what is read.
 */
export function compactOrigin(checkpoint: PanelMessage): CompactOrigin {
	return checkpoint.annotation?.tag === 'compact' ? checkpoint.annotation.origin : 'unresolved';
}

/**
 * Mirrors the durable Plan/Compact context boundary used by TaskRuntime, then separates detailed
 * Plan/Compact turns from the focused conversation. Nothing is deleted from the full transcript.
 */
export function projectAgentContextView(
	input: Readonly<{
		messages: readonly PanelMessage[];
		runs: readonly TurnRow[];
		activePlan?: PlanRow | undefined;
	}>
): AgentContextView {
	const latestCheckpoint = compactCheckpoint(input.messages);
	const planCutoff =
		input.activePlan?.status === 'draft' ? null : (input.activePlan?.checkpoint_sequence ?? null);
	const checkpoint =
		latestCheckpoint !== null && (planCutoff === null || latestCheckpoint.sequence > planCutoff)
			? latestCheckpoint
			: null;
	const retained =
		latestCheckpoint?.annotation?.tag === 'compact'
			? new Set<string>(latestCheckpoint.annotation.retainedMessageIds)
			: new Set<string>();
	const compactCutoff =
		latestCheckpoint?.annotation?.tag === 'compact' ? latestCheckpoint.annotation.cutoff : null;
	const outsideMessageIds = new Set<string>();
	const historyMessageIds = new Set<string>();
	const contextOrder = new Map<string, number>();
	const detailMessageIds = new Set<string>();
	const runModes = new Map(input.runs.map((run) => [String(run.id), run.mode] as const));

	for (const message of input.messages) {
		const sequence =
			message.annotation?.tag === 'input' && message.annotation.consumedAfterSequence !== undefined
				? Math.max(message.sequence, message.annotation.consumedAfterSequence + 1)
				: message.sequence;
		const queued =
			message.annotation?.tag === 'input' && message.annotation.consumedAfterSequence === undefined;
		contextOrder.set(message.id, sequence);
		const afterCompact =
			compactCutoff === null ||
			sequence > compactCutoff ||
			message.id === latestCheckpoint?.id ||
			retained.has(message.id);
		const afterPlan = planCutoff === null || sequence > planCutoff;
		if (!queued && (!afterCompact || !afterPlan)) outsideMessageIds.add(message.id);
		// Group the entire completed conversation, even requests explicitly retained by the model.
		if (
			!queued &&
			((compactCutoff !== null && sequence <= compactCutoff) ||
				(planCutoff !== null && sequence <= planCutoff) ||
				message.id === checkpoint?.id)
		)
			historyMessageIds.add(message.id);

		const runMode = message.runId === null ? undefined : runModes.get(message.runId);
		if (runMode === 'plan' || runMode === 'compact' || message.annotation?.tag === 'compact') {
			detailMessageIds.add(message.id);
		}
	}

	return {
		checkpoint,
		checkpointOrigin: checkpoint === null ? null : compactOrigin(checkpoint),
		focusMessages: input.messages
			.filter((message) => !historyMessageIds.has(message.id))
			.toSorted(
				(left, right) =>
					contextOrder.get(left.id)! - contextOrder.get(right.id)! || left.sequence - right.sequence
			),
		historyMessages: input.messages.filter((message) => historyMessageIds.has(message.id)),
		outsideMessageIds,
		detailMessageIds
	};
}

/** Reads display text without exposing raw tool payloads in the focused context summary. */
export function plainMessageText(message: PanelMessage): string {
	if (isString(message.message.content)) return message.message.content;
	return message.message.content
		.filter((part) => part.type === 'text')
		.map((part) => part.text)
		.join('\n');
}

/** Returns editable plain user text without dropping files or other canonical message parts. */
export function editableUserMessageText(message: PanelMessage): string | null {
	if (message.author.kind !== 'human' || message.message.role !== 'user') return null;
	if (isString(message.message.content)) return message.message.content;
	if (message.message.content.some((part) => part.type !== 'text')) return null;
	return plainMessageText(message);
}
