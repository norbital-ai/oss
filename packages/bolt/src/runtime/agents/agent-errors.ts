import { Schema } from 'effect';

/** Carries skill error through the typed agents failure channel without losing diagnostic context. */
export class SkillError extends Schema.TaggedError<SkillError>()('Bolt.Agents.SkillError', {
	name: Schema.NonEmptyString,
	reason: Schema.Literals(['invalid-name', 'missing', 'unreadable'])
}) {
	readonly category = 'skill' as const;
	readonly retryable = false;
	readonly message = `The skill "${this.name}" is not available: ${this.reason}.`;
}

/** Carries tool not allowed through the typed agents failure channel without losing diagnostic context. */
export class ToolNotAllowed extends Schema.TaggedError<ToolNotAllowed>()(
	'Bolt.Agents.ToolNotAllowed',
	{
		agent: Schema.NonEmptyString,
		tool: Schema.NonEmptyString
	}
) {
	readonly category = 'tool-access' as const;
	readonly retryable = false;
	readonly message = `The tool "${this.tool}" is not allowed for the agent "${this.agent}".`;
}
