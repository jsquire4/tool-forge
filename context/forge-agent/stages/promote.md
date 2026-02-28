# Stage: Promote

Goal: promote the tool to the registry with lifecycle_state = 'promoted'.

Steps:
- Confirm all artifacts exist: tool spec, eval files, verifier.
- Promote the tool in the tool registry (lifecycle_state = 'promoted').
- Report a summary of what was built: tool name, eval count, verifier count.
- Emit [STAGE_COMPLETE] to close the session.

This is the final stage. Do not emit [STAGE_COMPLETE] until promotion is confirmed.
