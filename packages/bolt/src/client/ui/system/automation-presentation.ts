import { getContext, setContext } from 'svelte';

export type AutomationRunStatus = 'pending' | 'running' | 'done' | 'failed' | 'stopped';

type AutomationStatusMessageKey =
	| 'bolt.automations.status.running'
	| 'bolt.automations.status.completed'
	| 'bolt.automations.status.stopped'
	| 'bolt.automations.status.failed';

type AutomationStatusPresentation = Readonly<{
	readonly status: AutomationRunStatus;
	readonly messageKey: AutomationStatusMessageKey;
	readonly canStop: boolean;
	readonly canResume: boolean;
}>;

export const presentAutomationStatus = (
	status: AutomationRunStatus | undefined
): AutomationStatusPresentation => {
	const normalized = status ?? 'pending';
	if (normalized === 'stopped')
		return {
			status: normalized,
			messageKey: 'bolt.automations.status.stopped',
			canStop: false,
			canResume: false
		};
	if (normalized === 'done')
		return {
			status: normalized,
			messageKey: 'bolt.automations.status.completed',
			canStop: false,
			canResume: false
		};
	if (normalized === 'failed')
		return {
			status: normalized,
			messageKey: 'bolt.automations.status.failed',
			canStop: false,
			canResume: false
		};
	return {
		status: normalized,
		messageKey: 'bolt.automations.status.running',
		canStop: true,
		canResume: false
	};
};

/** Fail-closed: host-projected entitlement and a compiler sourcePath. */
export const canShowAutomationSource = ({
	canEnterStudio,
	sourcePath
}: Readonly<{
	canEnterStudio: boolean | undefined;
	sourcePath: string | undefined;
}>): boolean => canEnterStudio === true && sourcePath !== undefined && sourcePath.trim() !== '';

/** Fail-closed: host-projected entitlement only. */
export const canShowStudioSource = (canEnterStudio: boolean | undefined): boolean =>
	canEnterStudio === true;

type StudioSourceEntitlement = Readonly<{
	readonly canEnterStudio: boolean;
	readonly openSource: (path: string) => void;
}>;

const STUDIO_SOURCE_ENTITLEMENT = Symbol('studio-source-entitlement');

export const setStudioSourceEntitlement = (read: () => StudioSourceEntitlement): void => {
	setContext(STUDIO_SOURCE_ENTITLEMENT, read);
};

export const useStudioSourceEntitlement = (): (() => StudioSourceEntitlement) => {
	const read = getContext<(() => StudioSourceEntitlement) | undefined>(STUDIO_SOURCE_ENTITLEMENT);
	return () => read?.() ?? { canEnterStudio: false, openSource: () => undefined };
};
