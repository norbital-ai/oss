<script lang="ts">
	import { observe, fork } from '@norbital-ai/ui/effect';
	import { Effect, Option, Stream } from 'effect';
	import { getContext } from 'svelte';
	import { watch } from 'runed';
	import type { AgentConversation, AgentRow } from '../../protocol/schema.ts';
	import type { ShellBolt } from '../runtime.ts';
	import { endingSound, settled } from './chime.ts';
	import { SOUNDS, type SoundKind, type Sounds } from '../sounds.ts';

	let {
		bolt,
		active,
		onEnded
	}: { bolt: ShellBolt; active: string | null; onEnded: (kind: SoundKind) => void } = $props();
	const chime = getContext<Sounds>(SOUNDS);
	const ended = settled();
	const conversations = observe(() =>
		bolt.observe<{ rows: AgentConversation[] }>({ read: { m: 'conversations', a: [] } })
	);
	watch(
		() => $conversations,
		(answer) => {
			if (answer === undefined) return;
			for (const { id, since } of ended(answer.rows)) {
				if (id === active) continue;
				fork(
					bolt
						.observe<{ rows: AgentRow[] }>({ read: { m: 'transcript', a: [id, { tail: 10 }] } })
						.pipe(
							Stream.take(1),
							Stream.runHead,
							Effect.tap((answer) =>
								Effect.sync(() => {
									if (Option.isNone(answer)) return;
									const kind = endingSound(answer.value.rows, since);
									if (kind === null) return;
									chime.play(kind);
									onEnded(kind);
								})
							),
							Effect.asVoid
						),
					() => {}
				);
			}
		}
	);
</script>
