/**
 * Settings page (spec §3.6): left nav across eight sections; each section is
 * a stack of cards reusing the same data commands the legacy dialogs used.
 * The page is self-contained for the parallel-lane split: it exposes a
 * `SettingsPageDeps` seam and the integrator wires it in app.ts; redundant
 * dialogs (model/thinking selectors, theme selector, hotkeys, changelog,
 * trust, settings grid) are listed in the task report for retirement.
 */

import { chipEl, toggleEl } from "../components/kit.ts";
import type { PiConnection } from "../connection.ts";
import { applyThemeVars } from "../dialogs.ts";
import { clearElement, h } from "../dom.ts";
import { renderMarkdown } from "../markdown.ts";
import type { ShellPage } from "../shell.ts";
import type { Store } from "../state.ts";
import type { RpcSettingsSnapshot, RpcThemeInfo, RpcTrustState } from "../types.ts";

export const SETTINGS_SECTIONS: ReadonlyArray<{ id: string; label: string }> = [
	{ id: "general", label: "General" },
	{ id: "models", label: "Models" },
	{ id: "appearance", label: "Appearance" },
	{ id: "keybindings", label: "Keybindings" },
	{ id: "mcp", label: "MCP & Integrations" },
	{ id: "accounts", label: "Accounts & Auth" },
	{ id: "trust", label: "Trust & Security" },
	{ id: "about", label: "About" },
];

/** Swatch source keys, mirroring the legacy theme selector row. */
const THEME_SWATCH_KEYS = ["text", "accent", "red", "green"] as const;
const THEME_SWATCH_FALLBACK = "#888888";

export interface KbdBinding {
	id?: string;
	keys?: string[];
	description?: string;
}

/** Normalize one get_keybindings entry into kbd-chip row data. */
export function settingsKbdRow(binding: KbdBinding): { id: string; keys: string[]; description: string } {
	const keys = Array.isArray(binding.keys)
		? binding.keys.filter((key): key is string => typeof key === "string" && key.length > 0)
		: [];
	return {
		id: typeof binding.id === "string" ? binding.id : "",
		keys,
		description: typeof binding.description === "string" ? binding.description.trim() : "",
	};
}

interface ModelRowInfo {
	provider: string;
	id: string;
	name?: string;
	reasoning?: boolean;
	authenticated?: boolean;
}

/** Themes → card rows: name + four swatches + current marker. */
export function themeCardRows(
	themes: RpcThemeInfo[],
	current?: string,
): Array<{ name: string; swatches: string[]; isCurrent: boolean }> {
	return themes.map((theme) => ({
		name: theme.name,
		swatches: THEME_SWATCH_KEYS.map((key) => theme.vars?.[key] ?? THEME_SWATCH_FALLBACK),
		isCurrent: theme.name === current,
	}));
}

/** Section resolution for deep links (#/settings/<section>): unknown → general. */
export function resolveSection(input: string | undefined): { id: string; label: string } {
	return SETTINGS_SECTIONS.find((section) => section.id === input) ?? SETTINGS_SECTIONS[0]!;
}

export interface SettingsPageDeps {
	connection(): PiConnection | undefined;
	activeStore(): Store | undefined;
	/** Cross-page navigation (rail parity); settings itself is not a target. */
	onNavigate(page: "chat" | "home" | "projects" | "mcp" | "usage"): void;
	pushToast(message: string, level: "info" | "warning" | "error"): void;
}

export interface SettingsPageOptions {
	/** Deep-link target; applied once when the page is created. */
	initialSection?: string;
	/** Local section switches (for hash sync); not called for the initial one. */
	onSectionChange?: (section: string) => void;
}

interface SectionDefaults {
	defaultProvider?: string;
	defaultModel?: string;
	defaultThinkingLevel?: string;
}

export function createSettingsPage(deps: SettingsPageDeps, opts: SettingsPageOptions = {}): ShellPage {
	const initial = resolveSection(opts.initialSection);
	let activeId = initial.id;
	let disposed = false;
	/** Bumps on every section switch; async loads check it before writing DOM. */
	let renderToken = 0;
	let unsubscribe: (() => void) | undefined;

	const crumb = h("span", { class: "c-crumb" }, initial.label);
	const nav = h("aside", { class: "settings-nav", "aria-label": "Settings sections" });
	const content = h("div", { class: "settings-content" });
	const header = h("div", { class: "c-page-header" }, h("span", { class: "c-page-title" }, "Settings"), crumb);
	const pageRoot = h(
		"section",
		{ class: "c-page settings-page" },
		header,
		h("div", { class: "settings-body" }, nav, content),
	);

	const request = <T>(command: Parameters<PiConnection["request"]>[0]): Promise<T> | undefined => {
		const connection = deps.connection();
		if (!connection) {
			content.replaceChildren(disconnectedCard());
			return undefined;
		}
		return connection.request<T>(command);
	};

	const selectSection = (id: string, notify: boolean): void => {
		const resolved = resolveSection(id);
		activeId = resolved.id;
		crumb.textContent = resolved.label;
		renderNav();
		if (notify) opts.onSectionChange?.(resolved.id);
		renderSection();
	};

	const renderNav = (): void => {
		clearElement(nav);
		for (const section of SETTINGS_SECTIONS) {
			const button = h(
				"button",
				{
					class: `settings-nav-item${section.id === activeId ? " is-active" : ""}`,
					onclick: () => selectSection(section.id, true),
				},
				section.label,
			);
			nav.appendChild(button);
		}
	};

	// ------------------------------------------------------------------
	// Shared card builders
	// ------------------------------------------------------------------

	const cardHost = (title: string): { card: HTMLElement; body: HTMLElement } => {
		const body = h("div", { class: "settings-card-body" });
		const card = h("div", { class: "c-card settings-card" }, h("div", { class: "c-card-title" }, title), body);
		return { card, body };
	};

	const disconnectedCard = (): HTMLElement =>
		h(
			"div",
			{ class: "c-card settings-card" },
			h("div", { class: "c-card-title" }, "Offline"),
			h("p", { class: "settings-hint" }, "Waiting for the pi server connection…"),
		);

	const rowLine = (label: string, ...children: HTMLElement[]): HTMLElement =>
		h("div", { class: "settings-row" }, h("span", { class: "settings-row-label" }, label), ...children);

	/** Global defaults via get/set_settings (mirrors the legacy Save flow). */
	const loadDefaults = (): Promise<SectionDefaults | undefined> | undefined =>
		request<RpcSettingsSnapshot>({ type: "get_settings" })?.then((snapshot) => {
			const effective = (snapshot?.effective ?? {}) as Record<string, unknown>;
			const pick = (key: string): string | undefined =>
				typeof effective[key] === "string" ? (effective[key] as string) : undefined;
			return {
				defaultProvider: pick("defaultProvider"),
				defaultModel: pick("defaultModel"),
				defaultThinkingLevel: pick("defaultThinkingLevel"),
			};
		});

	const saveDefaults = (values: Record<string, unknown>): void => {
		void request({ type: "set_settings", scope: "global", values })
			?.then(() => deps.pushToast("Saved global default", "info"))
			.catch((error: Error) => deps.pushToast(`Save failed: ${error.message}`, "error"));
	};

	// ------------------------------------------------------------------
	// Sections
	// ------------------------------------------------------------------

	const sectionGeneral = (): void => {
		const token = ++renderToken;
		const behavior = cardHost("Session behavior — active session");
		const defaultsCard = cardHost("Defaults — global settings");
		content.replaceChildren(behavior.card, defaultsCard.card);

		const renderBehavior = (): void => {
			if (token !== renderToken) return;
			const store = deps.activeStore();
			const session = store?.getState().sessionState;
			clearElement(behavior.body);
			if (!session) {
				behavior.body.appendChild(h("p", { class: "settings-hint" }, "No active session."));
				return;
			}
			const modeButtons = (
				command: "set_steering_mode" | "set_follow_up_mode",
				current: string | undefined,
			): HTMLElement => {
				const group = h("span", { class: "settings-segmented" });
				for (const mode of ["all", "one-at-a-time"] as const) {
					group.appendChild(
						h(
							"button",
							{
								class: `settings-segmented-item${current === mode ? " is-active" : ""}`,
								onclick: () => {
									void request({ type: command, mode })?.catch(() => {});
								},
							},
							mode,
						),
					);
				}
				return group;
			};
			behavior.body.append(
				rowLine("Steering mode", modeButtons("set_steering_mode", session.steeringMode)),
				rowLine("Follow-up mode", modeButtons("set_follow_up_mode", session.followUpMode)),
			);
			const compactionLine = rowLine(
				"Auto-compaction",
				toggleEl(session.autoCompactionEnabled, (next) => {
					void request({ type: "set_auto_compaction", enabled: next })?.catch(() => {});
				}),
			);
			behavior.body.appendChild(compactionLine);
		};

		renderBehavior();
		void loadDefaults()?.then((defaults) => {
			if (token !== renderToken || !defaults) return;
			const session = deps.activeStore()?.getState().sessionState;
			const modelText = defaults.defaultModel
				? `${defaults.defaultProvider ?? "?"}/${defaults.defaultModel}`
				: "(not set)";
			clearElement(defaultsCard.body);
			defaultsCard.body.append(
				rowLine("Default model", h("span", { class: "settings-value mono" }, modelText)),
				rowLine(
					"Default thinking",
					h("span", { class: "settings-value mono" }, defaults.defaultThinkingLevel ?? "(not set)"),
				),
			);
			const model = session?.model;
			if (model) {
				defaultsCard.body.appendChild(
					h(
						"button",
						{
							class: "c-btn",
							onclick: () => {
								saveDefaults({
									defaultProvider: model.provider,
									defaultModel: model.id,
									defaultThinkingLevel: session?.thinkingLevel ?? defaults.defaultThinkingLevel,
								});
							},
						},
						"Set from active session",
					),
				);
			}
		});
	};

	const sectionModels = (): void => {
		const token = ++renderToken;
		const defaults = cardHost("Default model");
		const listCard = cardHost("Available models");
		content.replaceChildren(defaults.card, listCard.card);
		void loadDefaults()?.then((current) => {
			if (token !== renderToken || !current) return;
			defaults.body.appendChild(
				rowLine(
					"Default",
					h(
						"span",
						{ class: "settings-value mono" },
						current.defaultModel ? `${current.defaultProvider ?? "?"}/${current.defaultModel}` : "(not set)",
					),
				),
			);
		});
		void request<{ models: ModelRowInfo[] }>({ type: "get_available_models" })?.then((data) => {
			if (token !== renderToken) return;
			clearElement(listCard.body);
			for (const model of data.models ?? []) {
				const actions = h("span", { class: "settings-row-actions" });
				actions.appendChild(
					h(
						"button",
						{
							class: "c-btn",
							title: "Save as the global default (settings)",
							onclick: () => saveDefaults({ defaultProvider: model.provider, defaultModel: model.id }),
						},
						"default",
					),
				);
				const store = deps.activeStore();
				if (store) {
					actions.appendChild(
						h(
							"button",
							{
								class: "c-btn",
								title: "Switch the active session to this model",
								onclick: () => {
									void request({ type: "set_model", provider: model.provider, modelId: model.id })
										?.then((updated) => {
											deps.activeStore()?.setModel(updated as never);
											deps.pushToast(`Session model: ${model.id}`, "info");
										})
										.catch((error: Error) => {
											deps.pushToast(error.message, "error");
										});
								},
							},
							"session",
						),
					);
				}
				const chips = [];
				if (model.authenticated === false) chips.push(chipEl("auth needed", { tone: "warn" }));
				if (model.reasoning) chips.push(chipEl("reasoning", { tone: "blue" }));
				listCard.body.appendChild(rowLine(`${model.provider}/${model.id}`, ...chips, actions));
			}
		});
	};

	const sectionAppearance = (): void => {
		const token = ++renderToken;
		const themesCard = cardHost("Theme");
		content.replaceChildren(themesCard.card);
		void request<{ themes: RpcThemeInfo[]; current: string }>({ type: "get_themes" })?.then((data) => {
			if (token !== renderToken) return;
			clearElement(themesCard.body);
			const grid = h("div", { class: "settings-theme-grid" });
			for (const theme of themeCardRows(data.themes ?? [], data.current)) {
				const swatches = theme.swatches.map((color) =>
					h("span", { class: "settings-swatch", style: `background: ${color}` }),
				);
				const card = h(
					"button",
					{
						class: `settings-theme-card${theme.isCurrent ? " is-active" : ""}`,
						onclick: () => {
							const full = (data.themes ?? []).find((entry) => entry.name === theme.name);
							void request({ type: "set_theme", name: theme.name })?.then(() => {
								deps.activeStore()?.applyThemeChanged(theme.name);
								if (full) applyThemeVars(full.vars);
								deps.pushToast(`Theme: ${theme.name}`, "info");
							});
						},
					},
					h("span", { class: "settings-theme-name" }, theme.name),
					h("span", { class: "settings-theme-swatches" }, ...swatches),
				);
				grid.appendChild(card);
			}
			themesCard.body.appendChild(grid);
		});
	};

	const sectionKeybindings = (): void => {
		const token = ++renderToken;
		const card = cardHost("Keyboard shortcuts (effective)");
		content.replaceChildren(card.card);
		void request<{ bindings: Array<{ id: string; keys: string[]; description?: string }> }>({
			type: "get_keybindings",
		})?.then((data) => {
			if (token !== renderToken) return;
			clearElement(card.body);
			const bindings = (data.bindings ?? []).filter((binding) => binding.description);
			if (bindings.length === 0) {
				card.body.appendChild(h("p", { class: "settings-hint" }, "No keybindings configured."));
				return;
			}
			for (const binding of bindings.map(settingsKbdRow)) {
				const keys = binding.keys.map((key) => h("kbd", { class: "settings-kbd" }, key));
				card.body.appendChild(
					h(
						"div",
						{ class: "settings-row" },
						h("span", { class: "settings-kbd-keys" }, ...keys),
						h("span", { class: "settings-row-label" }, binding.description),
					),
				);
			}
		});
	};

	const sectionMcp = (): void => {
		const card = cardHost("Extensions");
		content.replaceChildren(card.card);
		const extensions = deps.activeStore()?.getState().contextInfo?.extensions ?? [];
		clearElement(card.body);
		if (extensions.length === 0) {
			card.body.appendChild(h("p", { class: "settings-hint" }, "No extensions loaded."));
		}
		for (const extension of extensions) {
			card.body.appendChild(rowLine(extension.name));
		}
		card.body.appendChild(h("button", { class: "c-btn", onclick: () => deps.onNavigate("mcp") }, "Open MCP page →"));
	};

	const sectionAccounts = (): void => {
		const token = ++renderToken;
		const card = cardHost("Providers");
		content.replaceChildren(card.card);
		void request<{ providers: Array<{ id: string; authenticated: boolean }> }>({ type: "auth_status" })?.then(
			(data) => {
				if (token !== renderToken) return;
				clearElement(card.body);
				for (const provider of data.providers ?? []) {
					const actions = h("span", { class: "settings-row-actions" });
					const after = (): void => sectionAccounts();
					if (provider.authenticated) {
						actions.appendChild(
							h(
								"button",
								{
									class: "c-btn",
									onclick: () => {
										void request({ type: "auth_logout", provider: provider.id })
											?.then(() => {
												deps.pushToast(`Logged out of ${provider.id}`, "info");
												after();
											})
											.catch((error: Error) => deps.pushToast(error.message, "error"));
									},
								},
								"logout",
							),
						);
					} else {
						actions.appendChild(
							h(
								"button",
								{
									class: "c-btn",
									title: "API-key login (OAuth: type /login <provider> in chat)",
									onclick: () => {
										void request({ type: "auth_login", provider: provider.id, method: "api_key" })
											?.then(() => {
												deps.pushToast(`Logged in to ${provider.id}`, "info");
												after();
											})
											.catch((error: Error) => {
												if (error.message !== "Login cancelled") {
													deps.pushToast(`Login failed: ${error.message}`, "error");
												}
											});
									},
								},
								"login",
							),
						);
					}
					card.body.appendChild(
						rowLine(
							provider.id,
							chipEl(provider.authenticated ? "authenticated" : "signed out", {
								tone: provider.authenticated ? "ok" : "warn",
							}),
							actions,
						),
					);
				}
				card.body.appendChild(h("p", { class: "settings-hint" }, "OAuth flows: type /login <provider> in chat."));
			},
		);
	};

	const sectionTrust = (): void => {
		const token = ++renderToken;
		const card = cardHost("Project trust");
		content.replaceChildren(card.card);
		void request<RpcTrustState>({ type: "get_trust" })?.then((trust) => {
			if (token !== renderToken || !trust) return;
			clearElement(card.body);
			card.body.appendChild(
				h(
					"p",
					{ class: "settings-hint" },
					trust.trustPath
						? `Local pi resources under "${trust.trustPath}". Trusted projects may load project settings, extensions and skills.`
						: "This project has no local pi resources requiring trust.",
				),
			);
			for (const [index, option] of (trust.options ?? []).entries()) {
				card.body.appendChild(
					h(
						"div",
						{ class: "settings-row" },
						h(
							"button",
							{
								class: "c-btn",
								onclick: () => {
									void request({ type: "set_trust", trusted: option.trusted, optionIndex: index })
										?.then(() => {
											deps.pushToast(option.trusted ? "Trusted" : "Untrusted", "info");
											sectionTrust();
										})
										.catch(() => {});
								},
							},
							option.label,
						),
						h("span", { class: "settings-value mono" }, option.trusted ? "trust" : "deny"),
					),
				);
			}
			card.body.appendChild(
				rowLine(
					"Current",
					chipEl(trust.trusted ? "trusted" : "untrusted", {
						tone: trust.trusted ? "ok" : "warn",
					}),
				),
			);
		});
	};

	const sectionAbout = (): void => {
		const token = ++renderToken;
		const card = cardHost("About");
		const changelogCard = cardHost("Changelog");
		content.replaceChildren(card.card, changelogCard.card);
		const contextInfo = deps.activeStore()?.getState().contextInfo;
		if (contextInfo) {
			card.body.append(
				rowLine("Version", h("span", { class: "settings-value mono" }, contextInfo.version || "?")),
				rowLine("Agent dir", h("span", { class: "settings-value mono" }, contextInfo.agentDir)),
			);
		} else {
			card.body.appendChild(h("p", { class: "settings-hint" }, "No active session context."));
		}
		void request<{ markdown: string }>({ type: "get_changelog" })?.then((data) => {
			if (token !== renderToken) return;
			const body = h("div", { class: "settings-changelog" });
			body.innerHTML = renderMarkdown(data.markdown ?? "");
			changelogCard.body.replaceChildren(body);
		});
	};

	const renderSection = (): void => {
		switch (activeId) {
			case "models":
				sectionModels();
				break;
			case "appearance":
				sectionAppearance();
				break;
			case "keybindings":
				sectionKeybindings();
				break;
			case "mcp":
				sectionMcp();
				break;
			case "accounts":
				sectionAccounts();
				break;
			case "trust":
				sectionTrust();
				break;
			case "about":
				sectionAbout();
				break;
			default:
				sectionGeneral();
				break;
		}
	};

	const page: ShellPage = {
		id: "settings",
		title: "Settings",
		element: pageRoot,
		mount(): void {
			renderNav();
			// Initial deep-link target renders without an onSectionChange call.
			const resolved = resolveSection(activeId);
			crumb.textContent = resolved.label;
			renderSection();
			// Live sections re-render when the active session state changes.
			const store = deps.activeStore();
			if (store) {
				unsubscribe = store.subscribe(() => {
					if (disposed) return;
					if (activeId === "general" || activeId === "mcp" || activeId === "about") renderSection();
				});
			}
		},
		unmount(): void {
			disposed = true;
			unsubscribe?.();
			unsubscribe = undefined;
		},
	};
	return page;
}
