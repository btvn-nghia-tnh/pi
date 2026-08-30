/**
 * Interactive questionnaire overlay (kind: "rpiv-ask-user-question").
 *
 * Extensions with a rich `ask_user_question` tool (e.g.
 * @juicesharp/rpiv-ask-user-question) render the whole questionnaire as one
 * interactive widget overlay: radio rows for single-select, checkbox rows for
 * multi-select, a side-by-side preview pane for preview-carrying options, and
 * a "Type something." custom-answer row on every question. Submitting sends a
 * structured payload back through the `widget_response` command; cancelling
 * (Esc / Cancel) reports `{ cancelled: true }` — both resolve the pending
 * tool call.
 */

import { h } from "../dom.ts";
import { renderMarkdown } from "../markdown.ts";

/** Wire format: option within a question. */
interface AskOption {
	label: string;
	description?: string;
	preview?: string;
}

/** Wire format: one question. */
interface AskQuestion {
	question: string;
	header?: string;
	multiSelect?: boolean;
	options: AskOption[];
}

/** Wire format: the questionnaire payload pushed via setWidgetData. */
export interface AskQuestionnaireData {
	kind: "rpiv-ask-user-question";
	title?: string;
	questions: AskQuestion[];
	otherLabel?: string;
}

/** User's answer for one question, before enrichment. */
interface QuestionState {
	optionIndex: number | undefined;
	multiIndices: Set<number>;
	customText: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/** Parse the extension's widget payload defensively; undefined when malformed. */
export function parseAskQuestionnaire(data: unknown): AskQuestionnaireData | undefined {
	if (!isRecord(data) || data.kind !== "rpiv-ask-user-question") return undefined;
	const rawQuestions = Array.isArray(data.questions) ? data.questions : [];
	const questions: AskQuestion[] = [];
	for (const raw of rawQuestions) {
		if (!isRecord(raw) || typeof raw.question !== "string") continue;
		const options: AskOption[] = [];
		for (const rawOption of Array.isArray(raw.options) ? raw.options : []) {
			if (!isRecord(rawOption) || typeof rawOption.label !== "string") continue;
			options.push({
				label: rawOption.label,
				description: typeof rawOption.description === "string" ? rawOption.description : undefined,
				preview: typeof rawOption.preview === "string" ? rawOption.preview : undefined,
			});
		}
		if (options.length === 0) continue;
		questions.push({
			question: raw.question,
			header: typeof raw.header === "string" ? raw.header : undefined,
			multiSelect: raw.multiSelect === true,
			options,
		});
	}
	if (questions.length === 0) return undefined;
	return {
		kind: "rpiv-ask-user-question",
		title: typeof data.title === "string" ? data.title : undefined,
		questions,
		otherLabel: typeof data.otherLabel === "string" ? data.otherLabel : "Type something.",
	};
}

/** Answer payload for one question — mirrors the extension's QuestionAnswer. */
export interface AskAnswerPayload {
	questionIndex: number;
	question: string;
	kind: "option" | "custom" | "multi";
	answer: string | null;
	selected?: string[];
	preview?: string;
}

export interface AskSubmitPayload {
	answers: AskAnswerPayload[];
	cancelled: boolean;
}

/**
 * Build the interactive questionnaire view. `onSubmit` receives the final
 * payload (never called after the first submit) — the host turns it into a
 * widget_response command; `onCancel` fires for Esc/Cancel.
 */
export function createQuestionnaireView(
	data: AskQuestionnaireData,
	onSubmit: (payload: AskSubmitPayload) => void,
	onCancel: () => void,
): HTMLElement {
	const states: QuestionState[] = data.questions.map(() => ({
		optionIndex: undefined,
		multiIndices: new Set<number>(),
		customText: "",
	}));
	let submitted = false;

	// ---- per-question answer collection -------------------------------

	const answerFor = (index: number): AskAnswerPayload | undefined => {
		const question = data.questions[index];
		const state = states[index];
		if (state.customText.trim().length > 0) {
			return { questionIndex: index, question: question.question, kind: "custom", answer: state.customText.trim() };
		}
		if (question.multiSelect) {
			return {
				questionIndex: index,
				question: question.question,
				kind: "multi",
				answer: null,
				selected: [...state.multiIndices].sort((a, b) => a - b).map((i) => question.options[i].label),
			};
		}
		if (state.optionIndex !== undefined) {
			const option = question.options[state.optionIndex];
			return {
				questionIndex: index,
				question: question.question,
				kind: "option",
				answer: option.label,
				preview: option.preview && option.preview.length > 0 ? option.preview : undefined,
			};
		}
		return undefined;
	};

	const questionAnswered = (index: number): boolean => {
		const state = states[index];
		if (state.customText.trim().length > 0) return true;
		if (data.questions[index].multiSelect) return true; // deliberate empty commit allowed
		return state.optionIndex !== undefined;
	};

	// ---- DOM ------------------------------------------------------------

	const root = h("div", { class: "ask-questionnaire" });
	const submitButton = h("button", { class: "primary", disabled: true }, "Submit");
	const cancelButton = h("button", {}, "Cancel");

	const finish = (payload: AskSubmitPayload): void => {
		if (submitted) return;
		submitted = true;
		submitButton.setAttribute("disabled", "");
		cancelButton.setAttribute("disabled", "");
		onSubmit(payload);
	};

	submitButton.addEventListener("click", () => {
		const answers: AskAnswerPayload[] = [];
		for (let i = 0; i < data.questions.length; i++) {
			const answer = answerFor(i);
			if (answer) answers.push(answer);
		}
		finish({ answers, cancelled: false });
	});
	cancelButton.addEventListener("click", () => {
		finish({ answers: [], cancelled: true });
	});

	const updateSubmitState = (): void => {
		if (submitted) return;
		const allAnswered = data.questions.every((_, index) => questionAnswered(index));
		if (allAnswered) {
			submitButton.removeAttribute("disabled");
		} else {
			submitButton.setAttribute("disabled", "");
		}
	};

	for (let index = 0; index < data.questions.length; index++) {
		root.appendChild(buildQuestionSection(index));
	}
	// Initial gate: multi-select questions accept a deliberate empty commit,
	// so Submit may already be valid before any interaction.
	updateSubmitState();

	function buildQuestionSection(index: number): HTMLElement {
		const question = data.questions[index];
		const state = states[index];
		const hasPreviews =
			!question.multiSelect && question.options.some((option) => option.preview && option.preview.length > 0);

		const headChildren: (HTMLElement | string)[] = [];
		if (question.header) {
			headChildren.push(h("span", { class: "ask-header-chip" }, question.header));
		}
		headChildren.push(question.question);

		const rows: Array<{ row: HTMLElement; refreshRow: () => void }> = [];

		const refreshAllRows = (): void => {
			for (const entry of rows) entry.refreshRow();
		};

		const customRow = h("div", { class: "ask-row ask-other-row" });
		const customLabel = h("span", { class: "ask-option-label" }, data.otherLabel ?? "Type something.");
		const customInput = h("input", {
			class: "ask-custom-input",
			type: "text",
			placeholder: "…",
			autocomplete: "off",
		}) as HTMLInputElement;

		const syncCustomRow = (): void => {
			customRow.classList.toggle("selected", state.customText.trim().length > 0);
		};

		const optionRows = h("div", { class: "ask-options" });
		const bodyChildren: HTMLElement[] = [optionRows, customRow];
		let previewPane: HTMLElement | undefined;
		if (hasPreviews) {
			previewPane = h("div", { class: "ask-preview" });
			bodyChildren.push(previewPane);
		}

		const setPreview = (optionIndex: number | undefined): void => {
			if (!previewPane) return;
			const option = optionIndex !== undefined ? question.options[optionIndex] : undefined;
			const markdown = option?.preview;
			previewPane.replaceChildren();
			if (markdown && markdown.length > 0) {
				previewPane.innerHTML = renderMarkdown(markdown);
			} else {
				previewPane.appendChild(h("div", { class: "ask-preview-empty" }, "Preview"));
			}
		};

		for (let optionIndex = 0; optionIndex < question.options.length; optionIndex++) {
			const option = question.options[optionIndex];
			const marker = h("span", { class: "ask-marker" }, question.multiSelect ? "☐" : "○");
			const label = h("span", { class: "ask-option-label" }, option.label);
			const description = option.description
				? h("span", { class: "ask-option-desc" }, option.description)
				: undefined;
			const row = h("div", { class: "ask-row" }, marker, h("div", { class: "ask-option-text" }, label, description));
			const refreshRow = (): void => {
				const selected = question.multiSelect
					? state.multiIndices.has(optionIndex)
					: state.optionIndex === optionIndex;
				row.classList.toggle("selected", selected);
				marker.textContent = question.multiSelect ? (selected ? "☑" : "☐") : selected ? "●" : "○";
			};
			row.addEventListener("click", () => {
				if (submitted) return;
				if (question.multiSelect) {
					if (state.multiIndices.has(optionIndex)) {
						state.multiIndices.delete(optionIndex);
					} else {
						state.multiIndices.add(optionIndex);
					}
				} else {
					state.optionIndex = optionIndex;
					setPreview(optionIndex);
				}
				// Picking an option clears a typed custom answer.
				state.customText = "";
				customInput.value = "";
				syncCustomRow();
				refreshAllRows();
				updateSubmitState();
			});
			if (hasPreviews) {
				row.addEventListener("mouseenter", () => setPreview(optionIndex));
			}
			rows.push({ row, refreshRow });
			optionRows.appendChild(row);
		}

		customInput.addEventListener("input", () => {
			if (submitted) return;
			state.customText = customInput.value;
			syncCustomRow();
			refreshAllRows();
			updateSubmitState();
		});
		customInput.addEventListener("keydown", (event) => {
			if (event.key === "Escape") {
				event.stopPropagation();
				onCancel();
			}
		});
		customRow.append(customLabel, customInput);
		setPreview(question.multiSelect ? undefined : state.optionIndex);

		return h(
			"div",
			{ class: "ask-question" },
			h("div", { class: "ask-q-head" }, ...headChildren),
			h("div", { class: "ask-q-body" }, ...bodyChildren),
		);
	}

	root.appendChild(
		h("div", { class: "ask-footer" }, h("span", { class: "ask-hint" }, "Esc cancels"), cancelButton, submitButton),
	);

	return root;
}
