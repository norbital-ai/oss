/** The durable lifecycle states stored by the task queue for an automation run. */
export type AutomationRunStatus = 'pending' | 'running' | 'done' | 'failed';

type AutomationStatusPresentation = Readonly<{
	readonly status: AutomationRunStatus;
	readonly label: 'Running' | 'Completed' | 'Failed';
	readonly canStop: boolean;
	readonly canResume: boolean;
}>;

/**
 * Presents a durable task state without making a newly queued run briefly unactionable.
 *
 * The start command returns the task id before the generated status query has necessarily painted
 * its first snapshot. That transient absence is the queue's active/default state: pending. Treating
 * it differently makes Studio say “Running…” while hiding the Stop control.
 */
export const presentAutomationStatus = (
	status: AutomationRunStatus | undefined
): AutomationStatusPresentation => {
	const normalized = status ?? 'pending';
	if (normalized === 'done')
		return { status: normalized, label: 'Completed', canStop: false, canResume: false };
	if (normalized === 'failed')
		return { status: normalized, label: 'Failed', canStop: false, canResume: false };
	return { status: normalized, label: 'Running', canStop: true, canResume: false };
};
