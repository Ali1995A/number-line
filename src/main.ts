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
	value: number;
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

let engine: LadderEngine | null = null;

const state: State = {
	k: 0,
	targetK: 0,
	stepMode: toggleStepMode.checked,
	fullNumber: toggleFullNumber.checked,
	value: 0,
};

const stepper = new DiscreteStepper(state.k, (nextK) => {
	state.k = nextK;
	state.value = clamp(state.value, -Math.pow(10, state.k), Math.pow(10, state.k));
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
	state.value = clamp(state.value, -max, max);

	scaleLabelEl.textContent = formatScaleLabel(state.k);
	rangeLabelEl.textContent = `${formatRangeLabel(state.k)}`;
	currentValueEl.textContent = `当前值：${formatValue(state.value, state.fullNumber, state.k)}`;

	axis.innerHTML = "";
	axis.appendChild(renderAxisBackground(engine.width));
	axis.appendChild(renderCenterZero(engine.width));

	const vm = engine.numberLine.buildViewModel(engine.width);
	const ticks = getTicksForK(state.k, vm.tickMarks.map((t) => t.position), vm.tickMarks.map((t) => t.height));
	for (const tick of ticks) {
		axis.appendChild(renderTick(tick.x, tick.heightClass));
		axis.appendChild(renderTickLabel(tick.x, tick.label));
	}

	const sliderX = valueToXWithEngine(state.value, engine);
	axis.appendChild(renderSlider(sliderX));
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

function renderTickLabel(x: number, label: string): HTMLElement {
	const el = document.createElement("div");
	el.className =
		"absolute bottom-2 -translate-x-1/2 whitespace-nowrap rounded-md bg-white/70 px-1.5 py-0.5 text-xs text-slate-700 backdrop-blur";
	el.style.left = `${x}px`;
	el.textContent = label;
	return el;
}

function renderSlider(x: number): HTMLElement {
	const wrap = document.createElement("div");
	wrap.className = "absolute inset-y-0";
	wrap.style.left = `${x}px`;
	wrap.style.width = "0px";

	const line = document.createElement("div");
	line.className = "absolute bottom-10 w-0.5 bg-amber-500";
	line.style.left = "-1px";
	line.style.height = "56px";

	const knob = document.createElement("div");
	knob.className =
		"absolute bottom-10 left-0 -translate-x-1/2 -translate-y-1/2 h-5 w-5 rounded-full border-2 border-amber-600 bg-amber-200 shadow";
	knob.title = "拖动当前值";

	wrap.append(line, knob);
	return wrap;
}

function valueToXWithEngine(value: number, eng: LadderEngine): number {
	// valueAt(pos) = (pos + displacement) / (unitLength/unitValue)
	// => pos = value*(unitLength/unitValue) - displacement
	const ratio = eng.numberLine.unitLength / eng.numberLine.unitValue;
	return value * ratio - eng.numberLine.displacement;
}

function getTicksForK(k: number, positions: number[], heights: number[]) {
	const maxNumber = Math.pow(10, k);
	const halfNumber = k === 0 ? 0.5 : maxNumber / 2;

	const fmt = (v: number) => formatValue(v, state.fullNumber, k);
	const classify = (h: number) => (h >= 3 ? ("tall" as const) : h === 2 ? ("mid" as const) : ("short" as const));
	const defaultPositions = [0, 0, 0, 0, 0];
	const p = positions.length === 5 ? positions : defaultPositions;
	const hs = heights.length === 5 ? heights : [3, 1, 2, 1, 2];
	return [
		{ x: p[0], label: fmt(-maxNumber), heightClass: classify(hs[0]) },
		{ x: p[1], label: fmt(-halfNumber), heightClass: classify(hs[1]) },
		{ x: p[2], label: fmt(0), heightClass: classify(hs[2]) },
		{ x: p[3], label: fmt(halfNumber), heightClass: classify(hs[3]) },
		{ x: p[4], label: fmt(maxNumber), heightClass: classify(hs[4]) },
	];
}

// --- Interactions ---

btnZoomIn.addEventListener("click", () => bumpK(+1));
btnZoomOut.addEventListener("click", () => bumpK(-1));
btnResetZero.addEventListener("click", () => {
	state.value = 0;
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

// Drag (mouse & iPad single finger): pan current value v.
let dragging = false;
let pinching = false;

axis.addEventListener("pointerdown", (e) => {
	if (pinching) return;
	dragging = true;
	axis.setPointerCapture(e.pointerId);
});

axis.addEventListener("pointermove", (e) => {
	if (!dragging || !engine) return;
	const rect = axis.getBoundingClientRect();
	const x = clamp(e.clientX - rect.left, 0, rect.width);
	const value = engine.numberLine.valueAt(x);
	state.value = clamp(value, -engine.maxAbsValue, engine.maxAbsValue);
	render();
});

axis.addEventListener("pointerup", () => {
	dragging = false;
});
axis.addEventListener("pointercancel", () => {
	dragging = false;
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
			state.value = clamp(value, -engine.maxAbsValue, engine.maxAbsValue);
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
});
axis.addEventListener("touchcancel", () => {
	pinchStartDist = 0;
	pinching = false;
	touchDragging = false;
	touchDragId = null;
});

function touchDistance(a: Touch, b: Touch) {
	const dx = a.clientX - b.clientX;
	const dy = a.clientY - b.clientY;
	return Math.hypot(dx, dy);
}

// Initial render + resize handling
const ro = new ResizeObserver(() => render());
ro.observe(axis);

render();
