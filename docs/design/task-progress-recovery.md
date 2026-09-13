# Native task progress and approval recovery

## Problem

An unanswered approval was remembered only by browser SSE subscribers. Disconnecting before delivery could lose the request, and expiry silently deleted the HTTP registry entry after 30 minutes without replying to the runtime. The agent could remain waiting while the UI showed Running and disabled a failed approval card. Separately, active-turn proofs overrode the runtime's waiting status, missed completion events were not periodically reconciled, and command completion/plan updates were ignored by the live timeline.

## Runtime behavior

The process owns pending approvals with a fixed 30-minute deadline and a maximum of 128 entries. Subscribers receive unresolved requests with the original deadline. Expiry or capacity eviction sends `decision: cancel`; it never grants permission. A failed cancellation write terminates the failed transport rather than abandoning an unresolved wait. Decisions consume the process entry; resolved requests, turn completion, and process shutdown clean up timers. Process exit closes SSE so browsers reconnect to a new process.

The HTTP approval registry retains tenant/user binding, action metadata, single-use checks, and the attachment restriction on session-wide approval. Authorized thread detail reads include current pending approvals, allowing navigation or refresh to restore a decision card. A historical in-progress turn on a `notLoaded` thread is not treated as live.

This follows the [Codex App Server protocol](https://learn.chatgpt.com/docs/app-server): decisions answer server requests, `serverRequest/resolved` clears approval UI, and `turn/completed` confirms turn termination. An interrupt acknowledgement alone does not prove completion.

## UI behavior

The task transcript displays an Agent status and Execution timeline panel with refresh and stop controls, reported model/agent, related agent statuses, recent execution events, and activity age. A plan displays completed steps divided by the reported total; no plan means event counts without a fabricated percentage. A quiet active run explains the lack of recent events after one minute. Completed runs retain the last reported plan without a running animation.

The event reducer handles item starts/completions, output and assistant deltas, plan updates, errors, approvals and turn lifecycle. Active flags preserve Waiting. The selected active task reconciles an authorized full read every 15 seconds and on reconnect, manual refresh, and approval responses. Liveness generations protect newer events from older reads. A refreshed snapshot restores still-pending approvals and clears stale cards; history reads retain newer observed activity timestamps.

## Validation

Regression coverage includes approval cancellation without subscribers, reconnect replay with unchanged deadline, single-use decisions, pending approvals in authorized history, unloaded historical turns, missed terminal-event recovery, waiting-state preservation, command exit results, per-turn completion, plan updates, expiry messaging and progress controls. Browser fixture verification covers waiting/plan display and transition to a stopped, continuation-ready task.

No database migration, provider credential change, or automatic approval is required. Existing runs interrupted by a runtime restart must be continued by the user after refreshing; their transcript is preserved. Verifying the originally reported live task requires an authenticated browser session.
