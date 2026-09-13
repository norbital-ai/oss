import { Option, Schema } from 'effect';
import { Prompt } from 'effect/unstable/ai';
import {
	DirectiveMode,
	ExactCharge,
	MessageId,
	ModelId,
	PlanId,
	PlanStatus,
	PlanAction,
	ProviderCallId,
	TurnId,
	RunPhase,
	RunStatus,
	ConversationId,
	UsageObservation
} from '@norbital-ai/bolt-protocol';

const MessageAuthor = Schema.Struct({
	kind: Schema.Literals(['human', 'agent', 'parent-agent', 'tool', 'system']),
	id: Schema.optionalKey(Schema.NonEmptyString)
});
type MessageAuthor = typeof MessageAuthor.Type;

const CompactAnnotation = Schema.Struct({
	tag: Schema.Literal('compact'),
	/** Who asked: a person's `/compact`, the runtime's own bound, or the agent calling `compact`. */
	origin: Schema.Literals(['manual', 'automatic', 'requested']),
	cutoff: Schema.Natural,
	retainedMessageIds: Schema.Array(MessageId)
});

const PlanVerdictAnnotation = Schema.Struct({
	tag: Schema.Literal('plan-verdict'),
	planId: PlanId,
	complete: Schema.Boolean,
	gaps: Schema.Array(Schema.String)
});

const MessageAnnotation = Schema.Union([
	Schema.Struct({
		tag: Schema.Literal('input'),
		planAction: Schema.optionalKey(PlanAction),
		queuePosition: Schema.optionalKey(Schema.Natural),
		consumedAfterSequence: Schema.optionalKey(Schema.Natural)
	}),
	CompactAnnotation,
	PlanVerdictAnnotation,
	Schema.Struct({
		tag: Schema.Literal('generation'),
		callId: ProviderCallId,
		sequence: Schema.Natural,
		activeParts: Schema.Array(Schema.Natural)
	})
]);
export type MessageAnnotation = typeof MessageAnnotation.Type;

const EncodedMessage = Schema.toEncoded(Prompt.Message);

const ConversationMessageRow = Schema.Struct({
	id: MessageId,
	conversation_id: ConversationId,
	sequence: Schema.Natural,
	turn_id: Schema.NullOr(TurnId),
	author: MessageAuthor,
	message: EncodedMessage,
	annotation: Schema.NullOr(MessageAnnotation),
	/** The queue, on the message: `queued` until answered, then `consumed` or `cancelled`. */
	state: Schema.optionalKey(Schema.NullOr(Schema.NonEmptyString)),
	mode: Schema.optionalKey(Schema.NullOr(DirectiveMode)),
	priority: Schema.optionalKey(Schema.NullOr(Schema.Literals(['normal', 'steer'])))
});
export type ConversationMessageRow = typeof ConversationMessageRow.Type;

const PlanRow = Schema.Struct({
	id: PlanId,
	conversation_id: ConversationId,
	revision: Schema.Natural,
	checkpoint_sequence: Schema.Natural,
	body: Schema.NonEmptyString,
	status: PlanStatus,
	created_at: Schema.Unknown
});
export type PlanRow = typeof PlanRow.Type;

const TurnRow = Schema.Struct({
	id: TurnId,
	conversation_id: ConversationId,
	input_message_id: MessageId,
	mode: DirectiveMode,
	phase: RunPhase,
	input_through_sequence: Schema.Natural,
	model_id: ModelId,
	/** The model's context window as the catalog stated it when this turn was claimed. */
	context_window_tokens: Schema.Natural,
	status: RunStatus,
	created_at: Schema.optionalKey(Schema.Unknown)
});
export type TurnRow = typeof TurnRow.Type;

const TurnUsageRow = Schema.Struct({
	call_id: ProviderCallId,
	turn_id: TurnId,
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
export type TurnUsageRow = typeof TurnUsageRow.Type;

export type PanelMessage = Readonly<{
	kind: 'message';
	key: string;
	id: string;
	conversationId: string;
	sequence: number;
	runId: string | null;
	author: MessageAuthor;
	message: Prompt.MessageEncoded;
	annotation: MessageAnnotation | null;
	/** The queue columns, read from the row rather than from a second copy in the annotation. */
	state: string | null;
	mode?: typeof DirectiveMode.Type | null;
	priority: 'normal' | 'steer' | null;
}>;

const decodeConversationMessageRow = Schema.decodeUnknownOption(ConversationMessageRow);
const decodePlanRow = Schema.decodeUnknownOption(PlanRow);
const decodeTurnRow = Schema.decodeUnknownOption(TurnRow);
const decodeTurnUsageRow = Schema.decodeUnknownOption(TurnUsageRow);

/** Decodes each durable row directly as the one canonical Effect message representation. */
export function projectConversationMessages(rows: readonly unknown[]): PanelMessage[] {
	const decoded: Array<typeof ConversationMessageRow.Type> = [];
	for (const row of rows) {
		const parsed = decodeConversationMessageRow(row);
		if (Option.isSome(parsed)) decoded.push(parsed.value);
	}
	decoded.sort((left, right) => left.sequence - right.sequence);
	return decoded.map((row) => ({
		kind: 'message',
		key: row.id,
		id: row.id,
		conversationId: row.conversation_id,
		sequence: row.sequence,
		runId: row.turn_id,
		author: row.author,
		message: row.message,
		annotation: row.annotation,
		state: row.state ?? null,
		...(row.mode === undefined ? {} : { mode: row.mode }),
		priority: row.priority ?? null
	}));
}

export function projectPlans(rows: readonly unknown[]): PlanRow[] {
	return rows.flatMap((row) => {
		const decoded = decodePlanRow(row);
		return Option.isSome(decoded) ? [decoded.value] : [];
	});
}

export function projectTurns(rows: readonly unknown[]): TurnRow[] {
	return rows.flatMap((row) => {
		const decoded = decodeTurnRow(row);
		return Option.isSome(decoded) ? [decoded.value] : [];
	});
}

/**
 * Seconds a running turn has been working with nothing to show, or `null` once its first agent
 * row exists (or the turn is not running). The first token can take up to half a minute to
 * arrive; a clock is what keeps that window from looking stuck.
 */
export function turnWaitingSeconds(
	run: TurnRow | undefined,
	messages: readonly PanelMessage[],
	now: number
): number | null {
	if (run === undefined || run.status !== 'running') return null;
	if (messages.some((message) => message.runId === run.id && message.author.kind === 'agent'))
		return null;
	const startedAt = new Date(String(run.created_at ?? '')).getTime();
	return Number.isFinite(startedAt) ? Math.max(0, Math.floor((now - startedAt) / 1_000)) : 0;
}

export function projectAgentUsage(rows: readonly unknown[]): TurnUsageRow[] {
	return rows.flatMap((row) => {
		const decoded = decodeTurnUsageRow(row);
		return Option.isSome(decoded) ? [decoded.value] : [];
	});
}

/**
 * Where the model changed between consecutive runs, keyed by the first message of the run that
 * changed it and valued with that run's `model_id`.
 *
 * Runs are ordered by the transcript, not the run table: a run that persisted no message has no
 * place to carry a divider and is skipped, so two same-model runs around an empty one produce
 * nothing. Everything is read off stored rows, which is what lets the divider survive a reload.
 */
export function modelChangeDividers(
	runs: readonly TurnRow[],
	messages: readonly PanelMessage[]
): ReadonlyMap<string, string> {
	const modelByTurnId = new Map<string, string>(runs.map((run) => [run.id, run.model_id]));
	const dividers = new Map<string, string>();
	const seenRuns = new Set<string>();
	let previousModel: string | null = null;
	for (const message of [...messages].sort((left, right) => left.sequence - right.sequence)) {
		if (message.runId === null || seenRuns.has(message.runId)) continue;
		const model = modelByTurnId.get(message.runId);
		if (model === undefined) continue;
		seenRuns.add(message.runId);
		if (previousModel !== null && previousModel !== model) dividers.set(message.id, model);
		previousModel = model;
	}
	return dividers;
}

const isString = Schema.is(Schema.String);
const TodoItem = Schema.Struct({
	id: Schema.NonEmptyString,
	text: Schema.NonEmptyString,
	status: Schema.Literals(['pending', 'doing', 'done'])
});
const TodoResult = Schema.Struct({ items: Schema.Array(TodoItem) });
type TodoResult = typeof TodoResult.Type;
const decodeTodoResult = Schema.decodeUnknownOption(TodoResult);

/**
 * This conversation's checklist, read from the row the `todo` tool writes.
 *
 * It used to be recovered by walking the transcript backwards for the newest successful `todo`
 * tool-result — a second scanner that had to agree with the runtime's by hand, and that carried a
 * `system/todo` alias for a name nothing has ever emitted. One stored list, one reader.
 */
export function conversationTodos(
	conversation: { readonly todos?: unknown } | null
): TodoResult | null {
	if (conversation == null) return null;
	const decoded = decodeTodoResult(conversation.todos);
	return Option.isSome(decoded) ? decoded.value : null;
}

type ExactTaskCharge = Readonly<{
	currency: string;
	coefficient: bigint;
	scale: number;
}>;

/** Provider observations are already incurred costs, even before billing settlement. */
export function aggregateTaskCharges(
	rows: readonly TurnUsageRow[],
	runIds: ReadonlySet<string>
): ExactTaskCharge[] {
	const totals = new Map<string, ExactTaskCharge>();
	for (const row of rows) {
		if (!runIds.has(row.turn_id) || row.charge === null) {
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

const decodeTokenCount = Schema.decodeUnknownOption(
	Schema.NumberFromString.check(
		Schema.isInt(),
		Schema.isGreaterThanOrEqualTo(0),
		Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)
	)
);

export function aggregateTaskTokens(rows: readonly TurnUsageRow[], runIds: ReadonlySet<string>) {
	const total = {
		input: 0,
		output: 0,
		cacheRead: 0,
		reasoning: 0,
		reportedCalls: 0,
		missingCalls: 0
	};
	for (const row of rows) {
		if (!runIds.has(row.turn_id)) continue;
		const usage = row.usage;
		if (usage !== null && 'inputTokens' in usage && usage.inputTokens.total !== undefined) {
			total.input += usage.inputTokens.total;
			total.output += usage.outputTokens.total ?? 0;
			total.cacheRead += usage.inputTokens.cacheRead ?? 0;
			total.reasoning += usage.outputTokens.reasoning ?? 0;
			total.reportedCalls += 1;
		} else if (
			usage !== null &&
			'billableUnits' in usage &&
			usage.billableUnits.inputTokens !== undefined
		) {
			const input = decodeTokenCount(usage.billableUnits.inputTokens);
			if (Option.isSome(input)) {
				total.input += input.value;
				total.reportedCalls += 1;
			} else total.missingCalls += 1;
		} else total.missingCalls += 1;
	}
	return total;
}

/** Format presentation only; accounting retains the exact decimal total. */
export function formatTaskCharge(charge: ExactTaskCharge): string {
	const negative = charge.coefficient < 0n;
	const absolute = negative ? -charge.coefficient : charge.coefficient;
	const divisor = 10n ** BigInt(Math.max(0, charge.scale - 2));
	if (absolute > 0n && charge.scale > 2 && absolute < divisor)
		return `${charge.currency} ${negative ? '>-0.01' : '<0.01'}`;
	const cents =
		charge.scale <= 2
			? absolute * 10n ** BigInt(2 - charge.scale)
			: (absolute + divisor / 2n) / divisor;
	return `${charge.currency} ${negative ? '-' : ''}${(cents / 100n).toLocaleString('en-US')}.${(cents % 100n).toString().padStart(2, '0')}`;
}

export const formatAgentTokens = (tokens: number): string =>
	new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(tokens);

/** The last reported request for this root turn; cumulative/child usage is not context size. */
export function latestContextTokens(
	rows: readonly TurnUsageRow[],
	run: TurnRow | undefined
): number | undefined {
	if (run === undefined) return undefined;
	const usage = rows.findLast(
		(row) =>
			row.turn_id === run.id &&
			row.model === run.model_id &&
			row.operation === 'language' &&
			row.usage !== null &&
			'inputTokens' in row.usage
	)?.usage;
	return usage !== undefined && usage !== null && 'inputTokens' in usage
		? usage.inputTokens.total
		: undefined;
}
