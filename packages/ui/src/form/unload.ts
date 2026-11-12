/** The owning component keeps its window listener; pending state is read when navigation occurs. */
export const pendingUnload = (pending: () => boolean) => (event: BeforeUnloadEvent): void => {
	if (!pending()) return;
	event.preventDefault();
	event.returnValue = true;
};
