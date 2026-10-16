// DeepSeek Harness plugin: /commit-listen (browser half)
//
// Registers a second source under the composer's "/" trigger (alongside the
// command source) that lists the session repository's git worktrees: type
// `--worktree=/` inside the /commit-listen draft and the menu completes a
// worktree name inline. Worktree data comes from the host half's fetch route
// (/api/commit-listener/worktrees) — git cannot run in the browser.
//
// Conventions mirror @deepseek-ai/dsh-client-ui-reference (the "@" source):
// ModuleLoader wrapper, inject + apply exports, registerSource on the
// inputTriggers service, onPick returning plain-text insertion.

window.__ModuleLoader__.load({
	id: "dsh-commit-listener",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const ROUTE = "/api/commit-listener/worktrees";
		const SECTION = "Worktrees";

		/** Required services: the trigger registry provided by dsh-client-ui-input-trigger. */
		const inject = ["inputTriggers"];

		/**
		* Register the worktree source under the "/" trigger.
		* @param ctx - client root context.
		*/
		function apply(ctx) {
			const inputTriggers = ctx.get("inputTriggers");
			const source = {
				trigger: "/",
				name: "commit-listener-worktrees",
				async candidates(session, { query, signal }) {
					let data;
					try {
						const response = await fetch(
							`${ROUTE}?session=${encodeURIComponent(session.sessionId)}`,
							{ signal }
						);
						if (!response.ok) return [];
						data = await response.json();
					} catch (error) {
						if (signal?.aborted) return [];
						console.error("[commit-listener] worktree candidates failed:", error);
						return [];
					}
					const needle = query.trim().toLowerCase();
					return data.worktrees
						.filter(
							(wt) =>
								needle === "" ||
								wt.name.toLowerCase().includes(needle) ||
								wt.branch.toLowerCase().includes(needle) ||
								wt.path.toLowerCase().includes(needle)
						)
						.map((wt) => ({
							// `name` is the completion value inserted into the draft.
							name: wt.name,
							description:
								`${wt.branch} · ${wt.path}` +
								(wt.markers.length > 0 ? ` (${wt.markers.join(", ")})` : "") +
								(wt.session ? "  ← session worktree" : ""),
							section: SECTION,
						}));
				},
				onPick: ({ candidate }) => ({ text: candidate.name }),
			};
			ctx.effect(() => inputTriggers.registerSource(source), "commit-listener: worktree source");
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
