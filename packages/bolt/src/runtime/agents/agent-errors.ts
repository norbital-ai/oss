import { Schema } from 'effect';

/** Carries skill error through the typed agents failure channel without losing diagnostic context. */
export class SkillError extends Schema.TaggedError<SkillError>()('Bolt.Agents.SkillError', {
	name: Schema.String,
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

/** A turn may use only a host-reported model with an explicit context length. */
export class AgentModelUnavailable extends Schema.TaggedError<AgentModelUnavailable>()(
	'Bolt.Agents.AgentModelUnavailable',
	{
		model: Schema.NonEmptyString,
		reason: Schema.Literals(['invalid-catalog', 'not-found', 'context-missing'])
	}
) {
	readonly category = 'agent-model' as const;
	readonly message = `The model "${this.model}" is unavailable: ${this.reason}.`;
}

/** Carries typed MCP transport and protocol failures without flattening them into tool output. */
export class McpToolError extends Schema.TaggedError<McpToolError>()('Bolt.Agents.McpToolError', {
	server: Schema.NonEmptyString,
	tool: Schema.NonEmptyString,
	reason: Schema.Literals(['invalid-input', 'invalid-response', 'http-status', 'protocol-error']),
	detail: Schema.NonEmptyString
}) {
	readonly category = 'mcp' as const;
	readonly retryable = this.reason === 'http-status';
	readonly message = `MCP ${this.server}:${this.tool} failed: ${this.detail}.`;
}
