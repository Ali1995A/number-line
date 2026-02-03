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
import { ParticleBlocks } from "./ladder/particles";

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
const layers = ensureAxisLayers(axis);
const particles = new ParticleBlocks(axis, layers.mask);

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
	const height = rect.height;
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

	layers.bg.innerHTML = "";
	layers.mask.innerHTML = "";
	layers.overlay.innerHTML = "";
	layers.overlay.appendChild(renderCenterZero(engine.width));

	const ball = computeBallPositions(engine);
	layers.mask.appendChild(renderCurtainMask(engine.width, ball.xA, ball.xB));
	particles.set({
		width: engine.width,
		height,
		k: state.k,
		midX: engine.width / 2,
		ballAx: ball.xA,
		ballBx: ball.xB,
		valueA: state.valueA,
		valueB: state.valueB,
	});

	const vm = engine.numberLine.buildViewModel(engine.width);
	for (const t of vm.tickMarks) {
		layers.overlay.appendChild(
			renderTick(t.position, classifyTickHeight(t.height, engine.numberLine.biggestTickPatternValue)),
		);
	}

	const labelsOpacity = ball.labelsOpacity;
	if (transition) {
		// crossfade labels between two k levels for a smoother "梯级变化"感受
		const fromVm = transition.fromEngine.numberLine.buildViewModel(transition.fromEngine.width);
		renderTickLabels(fromVm, labelsOpacity.from, transition.fromK);
	}
	renderTickLabels(vm, labelsOpacity.to, state.k);

	const { xA, xB } = ball;
	layers.overlay.appendChild(renderValueFollower(xA, formatValue(state.valueA, state.fullNumber, state.k), "a", engine.width));
	if (!state.symmetric) {
		layers.overlay.appendChild(renderValueFollower(xB, formatValue(state.valueB, state.fullNumber, state.k), "b", engine.width));
	} else {
		layers.overlay.appendChild(
			renderValueFollower(xB, formatValue(state.valueB, state.fullNumber, state.k), "b", engine.width, true),
		);
	}
	layers.overlay.appendChild(renderBall(xA, "a", labelsOpacity.from, labelsOpacity.to));
	layers.overlay.appendChild(renderBall(xB, "b", labelsOpacity.from, labelsOpacity.to));

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

function renderCurtainMask(width: number, xA: number, xB: number): HTMLElement {
	const mid = width / 2;
	const leftMost = Math.min(mid, xA, xB);
	const rightMost = Math.max(mid, xA, xB);

	// Reveal expands from 0 outward. Everything beyond the furthest ball on that side stays covered.
	const leftCoverW = clamp(leftMost, 0, mid);
	const rightCoverX = clamp(rightMost, mid, width);

	const wrap = document.createElement("div");
	wrap.className = "absolute inset-0";

	const left = document.createElement("div");
	left.className = "absolute inset-y-0 left-0";
	left.style.width = `${leftCoverW}px`;
	left.style.background =
		"linear-gradient(180deg, rgba(255,255,255,0.92), rgba(255,241,242,0.82))";
	left.style.backdropFilter = "blur(6px)";
	left.style.borderRight = "1px solid rgba(244,114,182,0.18)";

	const right = document.createElement("div");
	right.className = "absolute inset-y-0";
	right.style.left = `${rightCoverX}px`;
	right.style.right = "0px";
	right.style.background =
		"linear-gradient(180deg, rgba(255,255,255,0.92), rgba(255,241,242,0.82))";
	right.style.backdropFilter = "blur(6px)";
	right.style.borderLeft = "1px solid rgba(244,114,182,0.18)";

	// Soft edge at center (so “拉开”感觉更像窗帘)
	const seam = document.createElement("div");
	seam.className = "absolute inset-y-0";
	seam.style.left = `${mid - 1}px`;
	seam.style.width = "2px";
	seam.style.background =
		"linear-gradient(180deg, rgba(244,114,182,0.18), rgba(139,92,246,0.14))";

	wrap.append(left, right, seam);
	return wrap;
}

function renderTick(x: number, heightClass: "tall" | "mid" | "short"): HTMLElement {
	const tick = document.createElement("div");
	tick.className = "absolute bottom-10 w-px bg-slate-700/70";
	tick.style.left = `${x}px`;
	if (heightClass === "tall") {
		tick.style.height = "46px";
		tick.style.opacity = "0.85";
	} else if (heightClass === "mid") {
		tick.style.height = "34px";
		tick.style.opacity = "0.55";
	} else {
		tick.style.height = "24px";
		tick.style.opacity = "0.30";
	}
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
		layers.overlay.appendChild(renderTickLabel(t.position, formatValue(t.value, state.fullNumber, kForLabels), opacity));
	}
}

function renderBall(x: number, which: "a" | "b", fromOpacity: number, toOpacity: number): HTMLElement {
	const wrap = document.createElement("div");
	wrap.className = "absolute inset-y-0";
	wrap.style.left = `${x}px`;
	wrap.style.width = "0px";

	const color =
		which === "a"
			? { line: "rgba(236,72,153,0.92)", fill: "rgba(251,207,232,1)", border: "rgba(219,39,119,1)" }
			: { line: "rgba(139,92,246,0.92)", fill: "rgba(221,214,254,1)", border: "rgba(109,40,217,1)" };

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

function renderValueFollower(
	x: number,
	label: string,
	which: "a" | "b",
	width: number,
	subtle = false,
): HTMLElement {
	const el = document.createElement("div");
	el.className = "absolute top-3 -translate-x-1/2 select-none";
	el.style.pointerEvents = "none";
	el.style.left = `${clamp(x, 24, width - 24)}px`;

	const color =
		which === "a"
			? { bg: "rgba(251,207,232,0.88)", border: "rgba(219,39,119,0.55)", text: "rgb(136, 19, 55)" }
			: { bg: "rgba(221,214,254,0.86)", border: "rgba(109,40,217,0.50)", text: "rgb(76, 29, 149)" };

	el.style.background = color.bg;
	el.style.border = `1px solid ${color.border}`;
	el.style.color = color.text;
	el.style.padding = subtle ? "6px 10px" : "7px 12px";
	el.style.borderRadius = "999px";
	el.style.fontSize = subtle ? "12px" : "13px";
	el.style.fontWeight = subtle ? "600" : "700";
	el.style.letterSpacing = "-0.01em";
	el.style.backdropFilter = "blur(10px)";
	el.style.boxShadow = subtle
		? "0 1px 1px rgba(15,23,42,0.06), 0 6px 18px rgba(236,72,153,0.06)"
		: "0 1px 1px rgba(15,23,42,0.06), 0 10px 24px rgba(236,72,153,0.10)";
	el.style.opacity = subtle ? "0.82" : "0.95";
	el.textContent = label;
	return el;
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
	if (ratio >= 0.55) return "mid";
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
let lastRippleAt = 0;
let lastRippleX = 0;
let lastRippleY = 0;

axis.addEventListener("pointerdown", (e) => {
	if (pinching) return;
	dragging = true;
	const target = e.target as HTMLElement;
	const attr = target?.dataset?.ball as "a" | "b" | undefined;
	draggingBall = attr ?? pickNearestBall(e.clientX);
	axis.setPointerCapture(e.pointerId);

	// ripple at touch point + symmetric ripple
	const rect = axis.getBoundingClientRect();
	lastRippleAt = performance.now();
	lastRippleX = clamp(e.clientX - rect.left, 0, rect.width);
	lastRippleY = clamp(e.clientY - rect.top, 0, rect.height);
	particles.addRipple(lastRippleX, lastRippleY);
});

axis.addEventListener("pointermove", (e) => {
	if (!dragging || !engine) return;
	const rect = axis.getBoundingClientRect();
	const x = clamp(e.clientX - rect.left, 0, rect.width);
	const y = clamp(e.clientY - rect.top, 0, rect.height);
	const value = engine.numberLine.valueAt(x);
	if (draggingBall === "b") {
		if (state.symmetric) state.valueA = clamp(-value, -engine.maxAbsValue, engine.maxAbsValue);
		else state.valueB = clamp(value, -engine.maxAbsValue, engine.maxAbsValue);
	} else {
		// default drag A
		state.valueA = clamp(value, -engine.maxAbsValue, engine.maxAbsValue);
	}
	if (state.symmetric) state.valueB = -state.valueA;

	// emit ripples while dragging (throttled)
	const now = performance.now();
	const dt = now - lastRippleAt;
	const dist = Math.hypot(x - lastRippleX, y - lastRippleY);
	if (dt >= 80 && dist >= 18) {
		lastRippleAt = now;
		lastRippleX = x;
		lastRippleY = y;
		particles.addRipple(x, y);
	}
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
			const rect = axis.getBoundingClientRect();
			lastRippleAt = performance.now();
			lastRippleX = clamp(e.touches[0].clientX - rect.left, 0, rect.width);
			lastRippleY = clamp(e.touches[0].clientY - rect.top, 0, rect.height);
			particles.addRipple(lastRippleX, lastRippleY);
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
			const y = clamp(t.clientY - rect.top, 0, rect.height);
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

			// emit ripples while finger slides (throttled)
			const now = performance.now();
			const dt = now - lastRippleAt;
			const dist = Math.hypot(x - lastRippleX, y - lastRippleY);
			if (dt >= 80 && dist >= 18) {
				lastRippleAt = now;
				lastRippleX = x;
				lastRippleY = y;
				particles.addRipple(x, y);
			}
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

function ensureAxisLayers(host: HTMLElement) {
	let bg = host.querySelector<HTMLElement>("[data-nl-bg]");
	let mask = host.querySelector<HTMLElement>("[data-nl-mask]");
	let overlay = host.querySelector<HTMLElement>("[data-nl-overlay]");
	if (bg && mask && overlay) return { bg, mask, overlay };

	bg = document.createElement("div");
	bg.dataset.nlBg = "1";
	bg.style.position = "absolute";
	bg.style.inset = "0";
	bg.style.pointerEvents = "none";
	bg.style.zIndex = "0";

	mask = document.createElement("div");
	mask.dataset.nlMask = "1";
	mask.style.position = "absolute";
	mask.style.inset = "0";
	mask.style.pointerEvents = "none";
	mask.style.zIndex = "2";

	overlay = document.createElement("div");
	overlay.dataset.nlOverlay = "1";
	overlay.style.position = "absolute";
	overlay.style.inset = "0";
	overlay.style.pointerEvents = "auto";
	overlay.style.zIndex = "3";

	// ensure order: bg (0) -> particles canvas (1) -> mask (2) -> overlay (3)
	host.appendChild(bg);
	host.appendChild(mask);
	host.appendChild(overlay);
	return { bg, mask, overlay };
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

const roParticles = new ResizeObserver(() => particles.resize());
roParticles.observe(axis);

render();
