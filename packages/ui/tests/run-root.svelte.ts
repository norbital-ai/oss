export const in_root = (fn: () => void): (() => void) => $effect.root(fn);
