import { clamp } from "../lib/number-line";
import { createLadderEngine, LadderEngine } from "./ladder/engine";
import {
	formatFriendlyBigInt,
	formatFriendlyNumber,
	formatFullSigned,
	formatScaleLabel,
	pow10BigInt,
} from "./ladder/format";
import { DiscreteStepper } from "./ladder/stepper";

type State = {
	k: number;
	targetK: number;
	stepMode: boolean;
	fullNumber: boolean;
	symmetric: boolean;
	valueA: number; // left / primary
	valueB: number; // right / secondary
};

const K_MIN = 0;
const K_MAX = 16;

const axis = mustGetEl("#axis");
const currentValueEl = mustGetEl("#current-value");
const rangeLabelEl = mustGetEl("#range-label");
const scaleLabelEl = mustGetEl("#scale-label");

const btnZoomIn = mustGetEl("#btn-zoom-in") as HTMLButtonElement;
const btnZoomOut = mustGetEl("#btn-zoom-out") as HTMLButtonElement;
const btnResetZero = mustGetEl("#btn-reset-zero") as HTMLButtonElement;
const toggleStepMode = mustGetEl("#toggle-step-mode") as HTMLInputElement;
const toggleFullNumber = mustGetEl("#toggle-full-number") as HTMLInputElement;
const inputTargetK = mustGetEl("#input-target-k") as HTMLInputElement;
const segSymmetric = mustGetEl("#seg-symmetric") as HTMLButtonElement;
const segIndependent = mustGetEl("#seg-independent") as HTMLButtonElement;

let engine: LadderEngine | null = null;

const state: State = {
	k: 0,
	targetK: 0,
	stepMode: toggleStepMode.checked,
	fullNumber: toggleFullNumber.checked,
	symmetric: true,
	valueA: 0,
	valueB: 0,
};

type Transition = {
	fromK: number;
	toK: number;
	startAt: number;
	durationMs: number;
	fromEngine: LadderEngine;
	toEngine: LadderEngine;
	fromA: number;
	fromB: number;
	toA: number;
	toB: number;
};

let transition: Transition | null = null;

const stepper = new DiscreteStepper(state.k, (nextK) => {
	const rect = axis.getBoundingClientRect();
	const width = rect.width;
	const fromEngine = createLadderEngine(state.k, width);
	const toEngine = createLadderEngine(nextK, width);

	const toMax = toEngine.maxAbsValue;
	const toA = clamp(state.valueA, -toMax, toMax);
	const toB = state.symmetric ? -toA : clamp(state.valueB, -toMax, toMax);

	transition = {
		fromK: state.k,
		toK: nextK,
		startAt: performance.now(),
		durationMs: 280,
		fromEngine,
		toEngine,
		fromA: state.valueA,
		fromB: state.valueB,
		toA,
		toB,
	};

	state.k = nextK;
	state.valueA = toA;
	state.valueB = toB;
	inputTargetK.value = String(state.k);
	render();
});

function mustGetEl<T extends Element = HTMLElement>(selector: string): T {
	const el = document.querySelector(selector);
	if (!el) throw new Error(`Missing element: ${selector}`);
	return el as T;
}

function setTargetK(targetK: number) {
	const clamped = clamp(Math.round(targetK), K_MIN, K_MAX);
	state.targetK = clamped;
	inputTargetK.value = String(clamped);

	stepper.setStepMs(state.stepMode ? 320 : 0);
	stepper.requestTo(clamped);
}

function bumpK(delta: number) {
	setTargetK(state.k + delta);
}

function render() {
	const rect = axis.getBoundingClientRect();
	const width = rect.width;
	if (!engine || engine.k !== state.k || Math.abs(engine.width - width) > 0.5) {
		engine = createLadderEngine(state.k, width);
	}

	const max = engine.maxAbsValue;
	state.valueA = clamp(state.valueA, -max, max);
	if (state.symmetric) state.valueB = -state.valueA;
	else state.valueB = clamp(state.valueB, -max, max);

	scaleLabelEl.textContent = formatScaleLabel(state.k);
	rangeLabelEl.textContent = `${formatRangeLabel(state.k)}`;
	currentValueEl.textContent = formatValueBanner();

	axis.innerHTML = "";
	axis.appendChild(renderAxisBackground(engine.width));
	axis.appendChild(renderCenterZero(engine.width));

	const ball = computeBallPositions(engine);
	const vm = engine.numberLine.buildViewModel(engine.width);
	for (const t of vm.tickMarks) {
		axis.appendChild(renderTick(t.position, classifyTickHeight(t.height, engine.numberLine.biggestTickPatternValue)));
	}

	const labelsOpacity = ball.labelsOpacity;
	if (transition) {
		// crossfade labels between two k levels for a smoother "梯级变化"感受
		const fromVm = transition.fromEngine.numberLine.buildViewModel(transition.fromEngine.width);
		renderTickLabels(fromVm, labelsOpacity.from, transition.fromK);
	}
	renderTickLabels(vm, labelsOpacity.to, state.k);

	const { xA, xB } = ball;
	axis.appendChild(renderBall(xA, "a", labelsOpacity.from, labelsOpacity.to));
	axis.appendChild(renderBall(xB, "b", labelsOpacity.from, labelsOpacity.to));

	// continue animation frames if needed
	if (transition) requestAnimationFrame(render);
}

function formatRangeLabel(k: number): string {
	const max = pow10BigInt(k);
	if (k === 0) return "[-1, +1]";
	return `[${formatFriendlyBigInt(-max)}, ${formatFriendlyBigInt(max)}]`;
}

function formatValue(value: number, full: boolean, k: number): string {
	if (full) return formatFullSigned(value);
	if (k >= 8) {
		// for large magnitudes, show a friendlier Chinese unit label
		const asInt = BigInt(Math.round(value));
		return formatFriendlyBigInt(asInt);
	}
	return formatFriendlyNumber(value);
}

function formatValueBanner(): string {
	const a = formatValue(state.valueA, state.fullNumber, state.k);
	const b = formatValue(state.valueB, state.fullNumber, state.k);
	if (state.symmetric) return `当前值：${a}（对称：${b}）`;
	return `A：${a}　B：${b}`;
}

function renderAxisBackground(width: number): HTMLElement {
	const bg = document.createElement("div");
	bg.className = "absolute inset-0";

	const left = document.createElement("div");
	left.className = "absolute inset-y-0 left-0";
	left.style.width = `${width / 2}px`;
	left.style.background = "rgba(59, 130, 246, 0.06)";

	const right = document.createElement("div");
	right.className = "absolute inset-y-0 right-0";
	right.style.width = `${width / 2}px`;
	right.style.background = "rgba(34, 197, 94, 0.06)";

	bg.append(left, right);
	return bg;
}

function renderCenterZero(width: number): HTMLElement {
	const mid = document.createElement("div");
	mid.className = "absolute inset-y-0";
	mid.style.left = `${width / 2}px`;
	mid.style.width = "2px";
	mid.style.background = "rgba(15, 23, 42, 0.85)";

	const badge = document.createElement("div");
	badge.className =
		"absolute left-1/2 top-2 -translate-x-1/2 rounded-full bg-slate-900 px-2 py-0.5 text-xs font-semibold text-white";
	badge.textContent = "0";

	const signLeft = document.createElement("div");
	signLeft.className = "absolute left-3 bottom-2 text-xs text-slate-500";
	signLeft.textContent = "负";

	const signRight = document.createElement("div");
	signRight.className = "absolute right-3 bottom-2 text-xs text-slate-500";
	signRight.textContent = "正";

	const wrap = document.createElement("div");
	wrap.className = "absolute inset-0";
	wrap.append(mid, badge, signLeft, signRight);
	return wrap;
}

function renderTick(x: number, heightClass: "tall" | "mid" | "short"): HTMLElement {
	const tick = document.createElement("div");
	tick.className = "absolute bottom-10 w-px bg-slate-700/70";
	tick.style.left = `${x}px`;
	if (heightClass === "tall") tick.style.height = "44px";
	else if (heightClass === "mid") tick.style.height = "34px";
	else tick.style.height = "26px";
	return tick;
}

function renderTickLabel(x: number, label: string, opacity = 1): HTMLElement {
	const el = document.createElement("div");
	el.className =
		"absolute bottom-2 -translate-x-1/2 whitespace-nowrap rounded-md bg-white/70 px-1.5 py-0.5 text-xs text-slate-700 backdrop-blur";
	el.style.left = `${x}px`;
	el.textContent = label;
	el.style.opacity = String(opacity);
	return el;
}

function renderTickLabels(
	viewModel: { tickMarks: Array<{ label: string | null; position: number; value: number }> },
	opacity: number,
	kForLabels: number,
) {
	if (opacity <= 0) return;
	for (const t of viewModel.tickMarks) {
		if (t.label == null) continue;
		axis.appendChild(renderTickLabel(t.position, formatValue(t.value, state.fullNumber, kForLabels), opacity));
	}
}

function renderBall(x: number, which: "a" | "b", fromOpacity: number, toOpacity: number): HTMLElement {
	const wrap = document.createElement("div");
	wrap.className = "absolute inset-y-0";
	wrap.style.left = `${x}px`;
	wrap.style.width = "0px";

	const color = which === "a" ? { line: "rgba(59,130,246,0.9)", fill: "rgba(191,219,254,1)", border: "rgba(37,99,235,1)" } : { line: "rgba(34,197,94,0.9)", fill: "rgba(187,247,208,1)", border: "rgba(22,163,74,1)" };

	const line = document.createElement("div");
	line.className = "absolute bottom-10 w-0.5";
	line.style.left = "-1px";
	line.style.height = "64px";
	line.style.background = color.line;
	line.style.opacity = String(toOpacity);

	const knob = document.createElement("div");
	knob.className = "absolute bottom-10 left-0 -translate-x-1/2 -translate-y-1/2 shadow";
	knob.style.width = "26px";
	knob.style.height = "26px";
	knob.style.borderRadius = "999px";
	knob.style.border = `2px solid ${color.border}`;
	knob.style.background = color.fill;
	knob.style.opacity = String(toOpacity);
	knob.dataset.ball = which;

	// larger hit target
	const hit = document.createElement("div");
	hit.className = "absolute bottom-10 left-0 -translate-x-1/2 -translate-y-1/2";
	hit.style.width = "44px";
	hit.style.height = "44px";
	hit.style.borderRadius = "999px";
	hit.style.background = "transparent";
	hit.dataset.ball = which;

	// during k transition, slightly fade the ball if it's clamped
	const ghost = document.createElement("div");
	ghost.className = knob.className;
	ghost.style.width = knob.style.width;
	ghost.style.height = knob.style.height;
	ghost.style.borderRadius = knob.style.borderRadius;
	ghost.style.border = knob.style.border;
	ghost.style.background = knob.style.background;
	ghost.style.opacity = String(fromOpacity);

	wrap.append(line, ghost, knob, hit);
	return wrap;
}

function valueToXWithEngine(value: number, eng: LadderEngine): number {
	// valueAt(pos) = (pos + displacement) / (unitLength/unitValue)
	// => pos = value*(unitLength/unitValue) - displacement
	const ratio = eng.numberLine.unitLength / eng.numberLine.unitValue;
	return value * ratio - eng.numberLine.displacement;
}

function classifyTickHeight(height: number, biggest: number): "tall" | "mid" | "short" {
	const ratio = biggest <= 0 ? 0 : height / biggest;
	if (ratio >= 0.95) return "tall";
	if (ratio >= 0.65) return "mid";
	return "short";
}

// --- Interactions ---

btnZoomIn.addEventListener("click", () => bumpK(+1));
btnZoomOut.addEventListener("click", () => bumpK(-1));
btnResetZero.addEventListener("click", () => {
	state.valueA = 0;
	state.valueB = 0;
	render();
});

toggleStepMode.addEventListener("change", () => {
	state.stepMode = toggleStepMode.checked;
	stepper.setStepMs(state.stepMode ? 320 : 0);
});

toggleFullNumber.addEventListener("change", () => {
	state.fullNumber = toggleFullNumber.checked;
	render();
});

inputTargetK.addEventListener("change", () => {
	setTargetK(Number(inputTargetK.value));
});

// Desktop wheel: snap to integer k, but can request multi-step; always steps k±1 internally.
axis.addEventListener(
	"wheel",
	(e) => {
		e.preventDefault();
		const dir = Math.sign(e.deltaY);
		if (dir === 0) return;
		bumpK(dir);
	},
	{ passive: false },
);

function setSymmetricMode(on: boolean) {
	state.symmetric = on;
	segSymmetric.classList.toggle("nl-seg-btn-active", on);
	segIndependent.classList.toggle("nl-seg-btn-active", !on);
	if (on) state.valueB = -state.valueA;
	render();
}

segSymmetric.addEventListener("click", () => setSymmetricMode(true));
segIndependent.addEventListener("click", () => setSymmetricMode(false));

// Drag balls (mouse & iPad single finger): move values.
let dragging = false;
let pinching = false;
let draggingBall: "a" | "b" | null = null;

axis.addEventListener("pointerdown", (e) => {
	if (pinching) return;
	dragging = true;
	const target = e.target as HTMLElement;
	const attr = target?.dataset?.ball as "a" | "b" | undefined;
	draggingBall = attr ?? pickNearestBall(e.clientX);
	axis.setPointerCapture(e.pointerId);
});

axis.addEventListener("pointermove", (e) => {
	if (!dragging || !engine) return;
	const rect = axis.getBoundingClientRect();
	const x = clamp(e.clientX - rect.left, 0, rect.width);
	const value = engine.numberLine.valueAt(x);
	if (draggingBall === "b") {
		if (state.symmetric) state.valueA = clamp(-value, -engine.maxAbsValue, engine.maxAbsValue);
		else state.valueB = clamp(value, -engine.maxAbsValue, engine.maxAbsValue);
	} else {
		// default drag A
		state.valueA = clamp(value, -engine.maxAbsValue, engine.maxAbsValue);
	}
	if (state.symmetric) state.valueB = -state.valueA;
	render();
});

axis.addEventListener("pointerup", () => {
	dragging = false;
	draggingBall = null;
});
axis.addEventListener("pointercancel", () => {
	dragging = false;
	draggingBall = null;
});

// iPad pinch (Touch Events): snap to k±1 with thresholds.
let pinchStartDist = 0;
let touchDragging = false;
let touchDragId: number | null = null;
axis.addEventListener(
	"touchstart",
	(e) => {
		if (e.touches.length === 1) {
			pinching = false;
			touchDragging = true;
			touchDragId = e.touches[0].identifier;
		} else if (e.touches.length === 2) {
			pinching = true;
			dragging = false;
			touchDragging = false;
			touchDragId = null;
			pinchStartDist = touchDistance(e.touches[0], e.touches[1]);
		}
	},
	{ passive: false },
);

axis.addEventListener(
	"touchmove",
	(e) => {
		if (!engine) return;
		if (e.touches.length === 1 && touchDragging && touchDragId != null) {
			const t = Array.from(e.touches).find((x) => x.identifier === touchDragId) ?? e.touches[0];
			e.preventDefault();
			const rect = axis.getBoundingClientRect();
			const x = clamp(t.clientX - rect.left, 0, rect.width);
			const value = engine.numberLine.valueAt(x);
			// touch drag defaults to nearest ball
			const chosen = draggingBall ?? pickNearestBall(t.clientX);
			if (chosen === "b") {
				if (state.symmetric) state.valueA = clamp(-value, -engine.maxAbsValue, engine.maxAbsValue);
				else state.valueB = clamp(value, -engine.maxAbsValue, engine.maxAbsValue);
			} else {
				state.valueA = clamp(value, -engine.maxAbsValue, engine.maxAbsValue);
			}
			if (state.symmetric) state.valueB = -state.valueA;
			render();
			return;
		}
		if (e.touches.length !== 2) return;
		e.preventDefault();
		const d = touchDistance(e.touches[0], e.touches[1]);
		if (pinchStartDist <= 0) pinchStartDist = d;
		const ratio = d / pinchStartDist;
		const threshold = 0.10;
		if (ratio > 1 + threshold) {
			setTargetK(state.k + 1);
			pinchStartDist = d;
		} else if (ratio < 1 - threshold) {
			setTargetK(state.k - 1);
			pinchStartDist = d;
		}
	},
	{ passive: false },
);

axis.addEventListener("touchend", () => {
	pinchStartDist = 0;
	pinching = false;
	touchDragging = false;
	touchDragId = null;
	draggingBall = null;
});
axis.addEventListener("touchcancel", () => {
	pinchStartDist = 0;
	pinching = false;
	touchDragging = false;
	touchDragId = null;
	draggingBall = null;
});

function touchDistance(a: Touch, b: Touch) {
	const dx = a.clientX - b.clientX;
	const dy = a.clientY - b.clientY;
	return Math.hypot(dx, dy);
}

function pickNearestBall(clientX: number): "a" | "b" {
	if (!engine) return "a";
	const rect = axis.getBoundingClientRect();
	const x = clientX - rect.left;
	const xA = valueToXWithEngine(state.valueA, engine);
	const xB = valueToXWithEngine(state.valueB, engine);
	return Math.abs(x - xB) < Math.abs(x - xA) ? "b" : "a";
}

function computeBallPositions(eng: LadderEngine) {
	if (!transition) {
		return {
			xA: valueToXWithEngine(state.valueA, eng),
			xB: valueToXWithEngine(state.valueB, eng),
			labelsOpacity: { from: 0, to: 1 },
		};
	}
	const now = performance.now();
	const t = clamp((now - transition.startAt) / transition.durationMs, 0, 1);
	const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;

	const xFromA = valueToXWithEngine(transition.fromA, transition.fromEngine);
	const xToA = valueToXWithEngine(transition.toA, transition.toEngine);
	const xFromB = valueToXWithEngine(transition.fromB, transition.fromEngine);
	const xToB = valueToXWithEngine(transition.toB, transition.toEngine);

	const lerp = (a: number, b: number) => a + (b - a) * ease;
	const xA = lerp(xFromA, xToA);
	const xB = lerp(xFromB, xToB);

	if (t >= 1) transition = null;

	return {
		xA,
		xB,
		labelsOpacity: { from: 1 - ease, to: ease },
	};
}

// Initial render + resize handling
const ro = new ResizeObserver(() => render());
ro.observe(axis);

render();
