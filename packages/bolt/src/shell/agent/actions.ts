import { Effect, Result, Schema } from 'effect';
import type { ShellApi } from '../api-types.ts';

export const refused = (
	answer: Result.Result<
		Effect.Success<ReturnType<ShellApi['agent']['stop']>>,
		Effect.Error<ReturnType<ShellApi['agent']['stop']>>
	>
) =>
	answer._tag === 'Failure'
		? answer.failure.message
		: answer.success.kind === 'refused'
			? answer.success.message
			: null;
export class AgentPanelFailed extends Schema.TaggedError<AgentPanelFailed>()('AgentPanelFailed', {
	message: Schema.String,
	cause: Schema.Defect()
}) {}
