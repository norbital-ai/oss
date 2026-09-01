/** One client-minted idempotency key retained only while its command outcome is unknown. */
export type UnsettledTaskAdmission = Readonly<{
	taskId: string;
	agentId: string;
	message: string;
	mode: 'agent' | 'plan' | 'compact';
	priority: 'normal' | 'steer';
	draft: string;
}>;

/** Reuses a Task ID only for an exact retry of the same canonical submission identity. */
export const retryableAdmission = (
	admission: UnsettledTaskAdmission | null,
	input: Readonly<{
		agentId: string;
		message: string;
		mode: 'agent' | 'plan' | 'compact';
		priority: 'normal' | 'steer';
	}>
): UnsettledTaskAdmission | null =>
	admission !== null &&
	admission.agentId === input.agentId &&
	admission.message === input.message &&
	admission.mode === input.mode &&
	admission.priority === input.priority
		? admission
		: null;
