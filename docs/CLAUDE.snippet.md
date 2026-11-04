# TencentDB project knowledge

Add this to the CLAUDE.md of a project that uses the adapter.

- Before a significant development task, call `get_development_context` with the task description. Skip it for trivial changes and questions.
- Follow the retrieved specifications and coding standards. If sources conflict, say so and ask.
- Retrieved memory doesn't replace reading the code. Inspect the local repository before changing it.
- Use each item's `fetch` to read more only when you need it.
- Check `warnings` in the result. A listed source was not searched, so its absence isn't evidence of anything.
- After finishing, save lasting decisions and outcomes with `save_development_decision`. Choose the scope deliberately: `developer_private` unless the team needs it.
- Don't save secrets, command logs, status messages or temporary debugging output.
