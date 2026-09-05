/** One client-minted idempotency key retained only while its command outcome is unknown. */
export type UnsettledTaskAdmission = Readonly<{
	taskId: string;
	agentId: string;
	message: string;
	mode: 'agent' | 'plan' | 'compact';
	priority: 'normal' | 'steer';
	modelId?: string;
	draft: string;
}>;

/**
 * Paints the operator's text immediately. Drop it only when the Task row AND a durable
 * human `agent_message` for that Task are both live findMany facts — the row and its
 * messages arrive over independent live queries, and clearing on the message alone
 * leaves the composer empty with a blank transcript while the row is still in flight.
 */
export const visibleUnsettledAdmission = (
	admission: UnsettledTaskAdmission | null,
	tasksWithHumanMessage: ReadonlySet<string>,
	taskPresent: boolean
): UnsettledTaskAdmission | null =>
	admission !== null && taskPresent && tasksWithHumanMessage.has(admission.taskId)
		? null
		: admission;

/** Reuses a Task ID only for an exact retry of the same canonical submission identity. */
export const retryableAdmission = (
	admission: UnsettledTaskAdmission | null,
	input: Readonly<{
		agentId: string;
		message: string;
		mode: 'agent' | 'plan' | 'compact';
		priority: 'normal' | 'steer';
		modelId?: string;
	}>
): UnsettledTaskAdmission | null =>
	admission !== null &&
	admission.agentId === input.agentId &&
	admission.message === input.message &&
	admission.mode === input.mode &&
	admission.priority === input.priority &&
	admission.modelId === input.modelId
		? admission
		: null;
