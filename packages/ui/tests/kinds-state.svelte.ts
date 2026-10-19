export function reactive<Props>(initial: Props): Props {
	const state = $state(initial);
	return state;
}
