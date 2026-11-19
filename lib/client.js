// DeepSeek Harness plugin: /commit-listen (browser half)
//
// Two composer-adjacent surfaces:
//
// 1. A typing-time source under the composer's "/" trigger (alongside the
//    command source) that lists the session repository's git worktrees: type
//    `--worktree=/` inside the /commit-listen draft and the menu completes a
//    worktree name inline.
//
// 2. A clickable worktree picker: when a bare /commit-listen lands in a repo
//    with several watchable worktrees, the host parks a pending selection and
//    this half renders one full-width panel above the composer
//    (conversation.input.dock) with a button per worktree plus an "All
//    worktrees" button. A click POSTs the choice to the host's pick route,
//    which starts the listener; × dismisses without starting anything.
//
// Both read the host half's fetch routes (/api/commit-listener/…) — git
// cannot run in the browser. Conventions mirror
// @deepseek-ai/dsh-client-ui-input-trigger: ModuleLoader wrapper, inject +
// apply exports, registerSource on the inputTriggers service, slot entries
// through ctx.slots. Styling uses only --dsw-alias-* theme tokens, so the
// panel follows the host theme and degrades gracefully if a token renames.

window.__ModuleLoader__.load({
	id: "dsh-commit-listener",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const h = React.createElement;

		const ROUTE = "/api/commit-listener/worktrees";
		const PICK_ROUTE = "/api/commit-listener/pick";
		const ALL_TARGET = "__all__";
		const PICK_POLL_MS = 2000;
		const STATUS_MS = 8000;
		const SECTION = "Worktrees";

		/** Panel-local styles: prefixed class names, host theme tokens only. */
		const STYLE = [
			".dsh-clp{display:flex;flex-direction:column;gap:6px;box-sizing:border-box;padding:8px 10px;margin:0 0 6px;border:0.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);font-size:13px}",
			".dsh-clp-head{display:flex;align-items:center;gap:8px;min-width:0}",
			".dsh-clp-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px}",
			".dsh-clp-close{flex:none;display:inline-grid;place-items:center;width:20px;height:20px;padding:0;border:none;border-radius:var(--dsw-radius-xs);background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;font:inherit;font-size:14px;line-height:1}",
			".dsh-clp-close:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
			".dsh-clp-close:disabled{opacity:0.5;cursor:default}",
			".dsh-clp-row{display:flex;flex-wrap:wrap;gap:6px}",
			".dsh-clp-wt,.dsh-clp-all{display:inline-flex;align-items:baseline;gap:6px;max-width:100%;padding:5px 10px;border:0.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);cursor:pointer;font:inherit;font-size:12px;line-height:18px;text-align:left}",
			".dsh-clp-wt:hover,.dsh-clp-all:hover{background:var(--dsw-alias-interactive-bg-hover)}",
			".dsh-clp-wt:disabled,.dsh-clp-all:disabled{opacity:0.6;cursor:default}",
			".dsh-clp-session{border-color:var(--dsw-alias-border-selected)}",
			".dsh-clp-name{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".dsh-clp-branch{flex:none;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}",
			".dsh-clp-prompt{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-caption);font-size:11px;line-height:16px}",
			".dsh-clp-status{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}",
			".dsh-clp-status.dsh-clp-error{color:var(--dsh-alias-state-warn-label)}",
		].join("");

		/** Required services: the trigger registry provided by dsh-client-ui-input-trigger. */
		const inject = ["inputTriggers"];

		/**
		* The pending-selection panel above the composer (slot owner passes the
		* session snapshot; nothing renders while no pick is pending).
		* @param props - conversation.input.dock owner props ({ session }).
		*/
		function WorktreePicker(props) {
			const sessionId = props.session?.sessionId;
			const [pending, setPending] = React.useState(null);
			const [status, setStatus] = React.useState(null);
			const [busy, setBusy] = React.useState(false);

			// Poll the host for a pending pick: the panel mounts for the whole
			// session lifetime, and the pending state appears whenever a bare
			// /commit-listen asks for a choice.
			React.useEffect(() => {
				if (!sessionId) return undefined;
				let alive = true;
				const poll = async () => {
					if (document.hidden) return;
					try {
						const response = await fetch(`${PICK_ROUTE}?session=${encodeURIComponent(sessionId)}`);
						if (!response.ok) return;
						const data = await response.json();
						if (alive) setPending(data.pending);
					} catch {
						// Transient fetch failures keep the last state; next poll retries.
					}
				};
				void poll();
				const timer = setInterval(poll, PICK_POLL_MS);
				return () => {
					alive = false;
					clearInterval(timer);
				};
			}, [sessionId]);

			// A finished action shows its outcome briefly, then the panel retires.
			React.useEffect(() => {
				if (!status) return undefined;
				const timer = setTimeout(() => setStatus(null), STATUS_MS);
				return () => clearTimeout(timer);
			}, [status]);

			if (!sessionId || (!pending && !status)) return null;

			const act = async (target) => {
				setBusy(true);
				try {
					const response = await fetch(`${PICK_ROUTE}?session=${encodeURIComponent(sessionId)}`, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify(target === undefined ? {} : { target }),
					});
					const data = await response.json().catch(() => null);
					if (!response.ok) {
						setStatus({ kind: "error", text: `Picker: ${data?.error ?? "selection failed."}` });
					} else {
						setStatus({ kind: data?.kind === "error" ? "error" : "success", text: data?.text ?? "" });
					}
					setPending(null);
				} catch (error) {
					setStatus({ kind: "error", text: `Picker: ${String(error)}` });
				} finally {
					setBusy(false);
				}
			};

			return h(
				"div",
				{ className: "dsh-clp" },
				h("style", null, STYLE),
				status
					? h(
							"div",
							{ className: status.kind === "error" ? "dsh-clp-status dsh-clp-error" : "dsh-clp-status" },
							status.text,
						)
					: h(
							React.Fragment,
							null,
							h(
								"div",
								{ className: "dsh-clp-head" },
								h("span", { className: "dsh-clp-title" }, "commit-listener — pick a worktree to watch"),
								h(
									"button",
									{ className: "dsh-clp-close", onClick: () => void act(undefined), disabled: busy, "aria-label": "Dismiss worktree picker" },
									"×",
								),
							),
							h(
								"div",
								{ className: "dsh-clp-row" },
								pending.worktrees.map((wt) =>
									h(
										"button",
										{
											key: wt.path,
											className: wt.session ? "dsh-clp-wt dsh-clp-session" : "dsh-clp-wt",
											onClick: () => void act(wt.name),
											disabled: busy,
											title: wt.path,
										},
										h("span", { className: "dsh-clp-name" }, wt.name),
										h("span", { className: "dsh-clp-branch" }, wt.branch + (wt.session ? " · session" : "")),
									),
								),
								h(
									"button",
									{ className: "dsh-clp-all", onClick: () => void act(ALL_TARGET), disabled: busy },
									h("span", { className: "dsh-clp-name" }, "All worktrees"),
									h("span", { className: "dsh-clp-branch" }, "--all"),
								),
							),
							pending.prompt
								? h("div", { className: "dsh-clp-prompt", title: pending.prompt }, `Instruction: ${pending.prompt}`)
								: null,
						),
			);
		}

		/**
		* Register the worktree source under the "/" trigger and the pending-pick
		* panel above the composer.
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

			// The picker panel needs the slot registry; a nested soft dependency
			// keeps the typing-time source alive where slots are unavailable.
			ctx.inject(["slots"], (scope) => {
				scope.slots.inject("conversation.input.dock", () =>
					scope.slots.register(
						{ name: "conversation.input.dock", id: "commit-listener-picker", order: 20 },
						WorktreePicker,
					),
				);
			});
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
