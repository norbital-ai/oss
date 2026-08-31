/**
 * Why this turn exists. The intent decides tool posture, the independent end-action
 * (verifier) prompt, and whether the settled window is folded into a checkpoint.
 *
 * The composer shows the same verifier prompt the end-action will read. Plan folds
 * through the same `kind: 'summary'` checkpoint the model already sees after compaction.
 */
const AGENT_INTENTS = ['do', 'plan', 'compact'] as const;
export type AgentIntent = (typeof AGENT_INTENTS)[number];
export type AgentSlashCommand = 'goal' | 'plan' | 'compact';

const DEFAULT_VERIFIER_PROMPTS = {
	do: "Was the person's request actually completed? Prefer tool results, record identifiers, and concrete outcomes over the agent's own claims. A sentence that says the work is done is not evidence. If the transcript does not show the work, it is not done.",
	plan: 'Is this plan complete and executable? It must cover the original request, name concrete next steps a later turn can follow, and not leave the reader needing another planning pass. Research-only — do not require that the work already happened.'
} as const satisfies Record<Exclude<AgentIntent, 'compact'>, string>;

const PLAN_SUMMARY_OPEN = '<plan-summary>';
const PLAN_SUMMARY_CLOSE = '</plan-summary>';

const TASK_SIGNAL =
	/\b(create|update|delete|write|add|fix|migrate|build|deploy|list|find|show|explain|change|remove|approve|draft|outline|plan|check|audit|compare|count|export|import|assign|invite|configure|set\s+up|setup)\b/i;

const CHITCHAT =
	/^(hi|hello|hey|yo|thanks|thank you|thx|ok|okay|cool|cheers|bye|good (morning|afternoon|evening|night)|how are you|how'?s it going|what'?s up|how'?s the weather)\b/i;

type AgentIntentInput = Readonly<{
	readonly intent?: string | null;
	readonly planMode?: boolean | null;
	readonly verifierPrompt?: string | null;
	readonly message?: string | null;
	readonly mentionCount?: number;
	readonly goal?: boolean;
}>;

export function resolveAgentIntent(input: AgentIntentInput) {
	const intent: AgentIntent =
		input.intent === 'compact'
			? 'compact'
			: input.intent === 'plan' || input.planMode === true
				? 'plan'
				: 'do';
	const trimmed = typeof input.verifierPrompt === 'string' ? input.verifierPrompt.trim() : '';
	const message = typeof input.message === 'string' ? input.message.trim() : '';
	const verifierPrompt =
		trimmed ||
		(input.goal === true
			? `Determine whether this exact goal is fully complete:\n${message}`
			: DEFAULT_VERIFIER_PROMPTS[intent === 'compact' ? 'do' : intent]);
	const explicit = trimmed.length > 0;
	const verify =
		intent !== 'compact' &&
		(explicit ||
			input.goal === true ||
			intent === 'plan' ||
			(input.mentionCount ?? 0) > 0 ||
			hasTaskSignal(message));
	return {
		intent,
		planMode: intent === 'plan',
		foldAsCheckpoint: intent === 'plan' || intent === 'compact',
		verify,
		verifierPrompt
	};
}

/**
 * Reads a leading composer command without storing command syntax in canonical history.
 *
 * A command must occupy the first token and carry a non-empty instruction. Similar prose such as
 * `/planner` remains ordinary text instead of being partially consumed.
 */
export function parseAgentSlashCommand(source: string): {
	readonly command: AgentSlashCommand | null;
	readonly message: string;
	readonly complete: boolean;
} {
	const match = /^\s*\/(goal|plan|compact)(?:\s+([\s\S]*))?$/i.exec(source);
	if (!match) return { command: null, message: source, complete: true };
	const message = (match[2] ?? '').trim();
	return {
		command: match[1]!.toLowerCase() as AgentSlashCommand,
		message,
		complete: message.length > 0
	};
}

/** Plain Tab toggles composer mode; mention menus consume it first and modified Tab keeps focus navigation. */
export function isAgentModeShortcut(
	event: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'altKey' | 'ctrlKey' | 'metaKey' | 'isComposing'>
): boolean {
	return (
		event.key === 'Tab' &&
		!event.shiftKey &&
		!event.altKey &&
		!event.ctrlKey &&
		!event.metaKey &&
		!event.isComposing
	);
}
function hasTaskSignal(message: string): boolean {
	const text = message.trim();
	if (text.length === 0) return false;
	if (text.length > 280) return true;
	if (TASK_SIGNAL.test(text)) return true;
	const words = text.split(/\s+/).length;
	if (words <= 16 && CHITCHAT.test(text)) return false;
	return words > 6 && text.includes('?');
}

export function parseStoredSummary(content: string): {
	readonly fold: 'plan' | 'compact';
	readonly text: string;
} {
	const trimmed = content.trim();
	if (trimmed.startsWith(`${PLAN_SUMMARY_OPEN}\n`) && trimmed.endsWith(PLAN_SUMMARY_CLOSE)) {
		return {
			fold: 'plan',
			text: trimmed.slice(PLAN_SUMMARY_OPEN.length + 1, -PLAN_SUMMARY_CLOSE.length).trimEnd()
		};
	}
	if (trimmed.startsWith(PLAN_SUMMARY_OPEN) && trimmed.endsWith(PLAN_SUMMARY_CLOSE)) {
		return {
			fold: 'plan',
			text: trimmed.slice(PLAN_SUMMARY_OPEN.length, -PLAN_SUMMARY_CLOSE.length).trim()
		};
	}
	return { fold: 'compact', text: content };
}
