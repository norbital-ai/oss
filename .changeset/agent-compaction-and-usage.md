---
'@norbital-ai/pod': patch
---

Compact the agent's context visibly, nest subagents, and report the run's real usage.

The window was trimmed by a recency limit and a scan back to the nearest user message, recomputed
every turn. Old turns fell out of the model's view with nothing recording that they had, and the
same conversation produced a different starting point each time it ran. Compaction now writes a
durable checkpoint — an ordinary `chat_message` with `kind = 'summary'` — and the window builder
starts from the newest one. Nothing is deleted: the transcript below a checkpoint stays readable in
full, behind a tab beside the summary, so a reader can always see what a recap replaced. `/compact`
forces one and takes optional instructions steering what the summary keeps; it is matched against
the whole message, so prose that merely begins with the word is still prose.

A subagent writes into its parent's session, so its rows interleaved into the parent transcript and
the task handed to the child rendered as a bubble labelled "You". A delegated run now renders inside
the call that spawned it, through the same component as its parent and with no composer of its own.

The composer reports context-window occupancy, total tokens and cost. Every figure comes from the
provider's own accounting on `chat_message.usage`; the window it is measured against comes from the
host's model catalog. Anything the host did not report is absent rather than estimated — in
particular there is no cost derived from a price list, because a number a reader takes for a bill
has to be the bill.

A conversation's spend is now accumulated onto `chat_session` as each turn settles, rather than
summed from the messages on screen: a derived total falls when a message is deleted, and what was
spent does not. The increment claims its turn through `chat_turn.usage_settled_at` in the same
statement, so a retried or resumed run adds nothing the second time. Turns whose host reported no
cost are counted separately, so a total is never passed off as complete when part of it is
unmeasured. Compaction does not affect any of it — a checkpoint changes which messages the model is
sent, not which ones were paid for.

This also fixes usage being lost entirely on any turn that called a tool: those iterations produce
no text message, so the provider's accounting for them had nowhere to be stored.
