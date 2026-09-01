import { Option, Schema } from 'effect';
import { Prompt } from 'effect/unstable/ai';
import {
	DirectiveId,
	DirectiveMode,
	ExactCharge,
	MessageId,
	ModelId,
	PlanId,
	PlanStatus,
	ProviderCallId,
	RunId,
	RunPhase,
	RunStatus,
	TaskId,
	UsageObservation
} from '@norbital-ai/bolt-protocol';

const MessageAuthor = Schema.Struct({
	kind: Schema.Literals(['human', 'agent', 'parent-agent', 'tool', 'system']),
	id: Schema.optionalKey(Schema.NonEmptyString)
});
type MessageAuthor = typeof MessageAuthor.Type;

const CompactAnnotation = Schema.Struct({
	tag: Schema.Literal('compact'),
	cutoff: Schema.Natural,
	retainedMessageIds: Schema.Array(MessageId)
});

const PlanVerdictAnnotation = Schema.Struct({
	tag: Schema.Literal('plan-verdict'),
	planId: PlanId,
	complete: Schema.Boolean,
	gaps: Schema.Array(Schema.String)
});

const MessageAnnotation = Schema.Union([CompactAnnotation, PlanVerdictAnnotation]);
export type MessageAnnotation = typeof MessageAnnotation.Type;

const EncodedMessage = Schema.toEncoded(Prompt.Message);

const AgentMessageRow = Schema.Struct({
	id: MessageId,
	task_id: TaskId,
	sequence: Schema.Natural,
	run_id: Schema.NullOr(RunId),
	author: MessageAuthor,
	message: EncodedMessage,
	annotation: Schema.NullOr(MessageAnnotation)
});
export type AgentMessageRow = typeof AgentMessageRow.Type;

const AgentPlanRow = Schema.Struct({
	id: PlanId,
	task_id: TaskId,
	revision: Schema.Natural,
	checkpoint_sequence: Schema.Natural,
	body: Schema.NonEmptyString,
	status: PlanStatus,
	created_at: Schema.Unknown
});
export type AgentPlanRow = typeof AgentPlanRow.Type;

const AgentRunRow = Schema.Struct({
	id: RunId,
	task_id: TaskId,
	directive_id: DirectiveId,
	epoch: Schema.Natural,
	mode: DirectiveMode,
	phase: RunPhase,
	input_through_sequence: Schema.Natural,
	model_id: ModelId,
	capability_snapshot: Schema.Json,
	status: RunStatus
});
export type AgentRunRow = typeof AgentRunRow.Type;

const AgentUsageRow = Schema.Struct({
	call_id: ProviderCallId,
	run_id: RunId,
	provider: Schema.NonEmptyString,
	model: Schema.NonEmptyString,
	operation: Schema.Literals(['language', 'embedding']),
	usage: Schema.NullOr(UsageObservation),
	charge: Schema.NullOr(ExactCharge),
	charge_source: Schema.NullOr(Schema.Literals(['provider', 'price-table'])),
	pricing_version: Schema.NullOr(Schema.NonEmptyString),
	settlement_id: Schema.NonEmptyString,
	settlement_state: Schema.Literals(['pending', 'settled', 'attention'])
});
export type AgentUsageRow = typeof AgentUsageRow.Type;

export type PanelMessage = Readonly<{
	kind: 'message';
	key: string;
	id: string;
	taskId: string;
	sequence: number;
	runId: string | null;
	author: MessageAuthor;
	message: Prompt.MessageEncoded;
	annotation: MessageAnnotation | null;
}>;

const decodeAgentMessageRow = Schema.decodeUnknownOption(AgentMessageRow);
const decodeAgentPlanRow = Schema.decodeUnknownOption(AgentPlanRow);
const decodeAgentRunRow = Schema.decodeUnknownOption(AgentRunRow);
const decodeAgentUsageRow = Schema.decodeUnknownOption(AgentUsageRow);

/** Decodes each durable row directly as the one canonical Effect message representation. */
export function projectAgentMessages(rows: readonly unknown[]): PanelMessage[] {
	const decoded: Array<typeof AgentMessageRow.Type> = [];
	for (const row of rows) {
		const parsed = decodeAgentMessageRow(row);
		if (Option.isSome(parsed)) decoded.push(parsed.value);
	}
	decoded.sort((left, right) => left.sequence - right.sequence);
	return decoded.map((row) => ({
			kind: 'message',
			key: row.id,
			id: row.id,
			taskId: row.task_id,
			sequence: row.sequence,
			runId: row.run_id,
			author: row.author,
			message: row.message,
			annotation: row.annotation
		}));
}

export function projectAgentPlans(rows: readonly unknown[]): AgentPlanRow[] {
	return rows.flatMap((row) => {
		const decoded = decodeAgentPlanRow(row);
		return Option.isSome(decoded) ? [decoded.value] : [];
	});
}

export function projectAgentRuns(rows: readonly unknown[]): AgentRunRow[] {
	return rows.flatMap((row) => {
		const decoded = decodeAgentRunRow(row);
		return Option.isSome(decoded) ? [decoded.value] : [];
	});
}

export function projectAgentUsage(rows: readonly unknown[]): AgentUsageRow[] {
	return rows.flatMap((row) => {
		const decoded = decodeAgentUsageRow(row);
		return Option.isSome(decoded) ? [decoded.value] : [];
	});
}

const TodoItem = Schema.Struct({
	id: Schema.NonEmptyString,
	text: Schema.NonEmptyString,
	status: Schema.Literals(['pending', 'doing', 'done'])
});
const TodoResult = Schema.Struct({ items: Schema.Array(TodoItem) });
export type TodoResult = typeof TodoResult.Type;
const decodeTodoResult = Schema.decodeUnknownOption(TodoResult);

/** Latest successful canonical `system/todo` result for the selected run scope. */
export function latestTodo(
	messages: readonly PanelMessage[],
	activeRunId: string | null
): TodoResult | null {
	for (const entry of [...messages].toReversed()) {
		if (activeRunId !== null && entry.runId !== activeRunId) continue;
		const content = entry.message.content;
		if (typeof content === 'string') continue;
		for (const part of [...content].toReversed()) {
			if (part.type !== 'tool-result' || part.name !== 'system/todo' || part.isFailure) {
				continue;
			}
			const decoded = decodeTodoResult(part.result);
			if (Option.isSome(decoded)) return decoded.value;
		}
	}
	return null;
}

type ExactTaskCharge = Readonly<{
	currency: string;
	coefficient: bigint;
	scale: number;
}>;

/** Aggregates settled provider charges with integer arithmetic only. */
export function aggregateTaskCharges(
	rows: readonly AgentUsageRow[],
	runIds: ReadonlySet<string>
): ExactTaskCharge[] {
	const totals = new Map<string, ExactTaskCharge>();
	for (const row of rows) {
		if (!runIds.has(row.run_id) || row.settlement_state !== 'settled' || row.charge === null) {
			continue;
		}
		const charge = row.charge;
		const current = totals.get(charge.currency);
		if (current === undefined) {
			totals.set(charge.currency, charge);
			continue;
		}
		const scale = Math.max(current.scale, charge.scale);
		const currentCoefficient = current.coefficient * 10n ** BigInt(scale - current.scale);
		const nextCoefficient = charge.coefficient * 10n ** BigInt(scale - charge.scale);
		totals.set(charge.currency, {
			currency: charge.currency,
			coefficient: currentCoefficient + nextCoefficient,
			scale
		});
	}
	return [...totals.values()].sort((left, right) => left.currency.localeCompare(right.currency));
}

/** Converts one exact total to display text only at the UI boundary. */
export function formatTaskCharge(charge: ExactTaskCharge): string {
	const negative = charge.coefficient < 0n;
	const digits = (negative ? -charge.coefficient : charge.coefficient).toString();
	if (charge.scale === 0) return `${charge.currency} ${negative ? '-' : ''}${digits}`;
	const padded = digits.padStart(charge.scale + 1, '0');
	const whole = padded.slice(0, -charge.scale);
	const fraction = padded.slice(-charge.scale).replace(/0+$/, '');
	return `${charge.currency} ${negative ? '-' : ''}${whole}${fraction === '' ? '' : `.${fraction}`}`;
}
