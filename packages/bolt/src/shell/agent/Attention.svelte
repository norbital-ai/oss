<script lang="ts">
	import { observe, fork } from '@norbital-ai/ui/effect';
	import { Effect, Option, Stream } from 'effect';
	import { getContext } from 'svelte';
	import { watch } from 'runed';
	import type { AgentConversation, AgentRow } from '../../protocol/schema.ts';
	import type { ShellBolt } from '../runtime.ts';
	import { runTransitions } from './chime.ts';
	import { SOUNDS, type Sounds } from '../sounds.ts';

	let { bolt, active }: { bolt: ShellBolt; active: string | null } = $props();
	const chime = getContext<Sounds>(SOUNDS);
	const ended = runTransitions();
	const conversations = observe(() =>
		bolt.observe<{ rows: AgentConversation[] }>({ read: { m: 'conversations', a: [] } })
	);
	watch(
		() => $conversations,
		(answer) => {
			if (answer === undefined) return;
			for (const id of ended(answer.rows)) {
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
									const rows = answer.value.rows;
									const turn = rows.findLast((row) => row.turn !== undefined)?.turn;
									const approval = rows.some(
										(row) =>
											row.turn === turn &&
											(row.state === 'confirm' || row.tool?.approval !== undefined)
									);
									chime.play(approval ? 'approval' : 'complete');
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
