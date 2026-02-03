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
const particles = new ParticleBlocks(axis, layers.overlay);

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
		durationMs: 360,
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
	layers.overlay.innerHTML = "";
	layers.overlay.appendChild(renderCenterZero(engine.width));

	const ball = computeBallPositions(engine);
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
	const labelsOpacity = ball.labelsOpacity;
	if (transition) {
		// Cross-zoom: scale + crossfade tick/label layers so the ruler feels “infinite”.
		const fromVm = transition.fromEngine.numberLine.buildViewModel(transition.fromEngine.width);
		const dir = Math.sign(transition.toK - transition.fromK) || 1;
		const tRaw = ball.t;
		const ease = ball.ease;
		const pulse = zoomPulse(tRaw);
		const zoomMul = 1 + 0.14 * pulse; // 0 at endpoints => exact 10× loop
		// Always the same loop per step: scale by exactly 10× between adjacent k levels.
		// k+1 (zoom out): old 1 -> 0.1, new 10 -> 1
		// k-1 (zoom in):  old 1 -> 10,  new 0.1 -> 1
		const fromScale = Math.pow(10, -dir * ease) / zoomMul;
		const toScale = Math.pow(10, dir * (1 - ease)) * zoomMul;

		layers.overlay.appendChild(
			renderRulerLayer(fromVm, transition.fromEngine.numberLine.biggestTickPatternValue, labelsOpacity.from, transition.fromK, fromScale),
		);
		layers.overlay.appendChild(
			renderRulerLayer(vm, engine.numberLine.biggestTickPatternValue, labelsOpacity.to, state.k, toScale),
		);
		layers.overlay.appendChild(renderVerticalRulerLayer(engine.width / 2, height, labelsOpacity.from, transition.fromK, fromScale));
		layers.overlay.appendChild(renderVerticalRulerLayer(engine.width / 2, height, labelsOpacity.to, state.k, toScale));
	} else {
		layers.overlay.appendChild(renderRulerLayer(vm, engine.numberLine.biggestTickPatternValue, 1, state.k, 1));
		layers.overlay.appendChild(renderVerticalRulerLayer(engine.width / 2, height, 1, state.k, 1));
	}

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

function renderTick(x: number, heightClass: "tall" | "mid" | "short"): HTMLElement {
	const tick = document.createElement("div");
	tick.className = "absolute bottom-10 w-px bg-slate-700/50";
	tick.style.left = `${x}px`;
	if (heightClass === "tall") {
		tick.style.height = "46px";
		tick.style.opacity = "0.72";
	} else if (heightClass === "mid") {
		tick.style.height = "34px";
		tick.style.opacity = "0.42";
	} else {
		tick.style.height = "24px";
		tick.style.opacity = "0.22";
	}
	return tick;
}

function renderTickLabel(x: number, label: string, opacity = 1): HTMLElement {
	const el = document.createElement("div");
	// Keep labels readable without creating a “foggy veil” over the particles.
	el.className =
		"absolute bottom-2 -translate-x-1/2 whitespace-nowrap rounded-md px-1.5 py-0.5 text-xs font-semibold text-slate-700";
	el.style.left = `${x}px`;
	el.textContent = label;
	el.style.opacity = String(opacity);
	el.style.textShadow = "0 1px 0 rgba(255,255,255,0.85), 0 2px 8px rgba(255,255,255,0.65)";
	return el;
}

function renderRulerLayer(
	viewModel: { tickMarks: Array<{ label: string | null; position: number; height: number; value: number }> },
	biggestTick: number,
	opacity: number,
	kForLabels: number,
	scaleX: number,
) {
	const layer = document.createElement("div");
	layer.className = "absolute inset-0";
	layer.style.pointerEvents = "none";
	layer.style.opacity = String(opacity);
	layer.style.transformOrigin = "50% 86%";
	const scaleY = 1 + (scaleX - 1) * 0.32;
	layer.style.transform = `scale(${scaleX}, ${scaleY})`;
	layer.style.willChange = "transform, opacity";

	for (const t of viewModel.tickMarks) {
		layer.appendChild(renderTick(t.position, classifyTickHeight(t.height, biggestTick)));
		if (t.label != null) {
			layer.appendChild(renderTickLabel(t.position, formatValue(t.value, state.fullNumber, kForLabels), opacity));
		}
	}
	return layer;
}

function renderVerticalRulerLayer(midX: number, height: number, opacity: number, kForLabels: number, scale: number) {
	const layer = document.createElement("div");
	layer.className = "absolute inset-0";
	layer.style.pointerEvents = "none";
	layer.style.opacity = String(opacity);

	const topPad = 56;
	const bottomPad = 92;
	const baseY = clamp(height - bottomPad, 0, height);
	const topY = clamp(topPad, 0, height);
	const originPct = height <= 0 ? 50 : (baseY / height) * 100;

	// Scale around the bottom origin (0 at baseY), so it feels consistent with horizontal 10× zoom loop.
	layer.style.transformOrigin = `50% ${originPct.toFixed(2)}%`;
	layer.style.transform = `scale(1, ${scale})`;
	layer.style.willChange = "transform, opacity";

	// Center line
	const line = document.createElement("div");
	line.className = "absolute w-px";
	line.style.left = `${midX}px`;
	line.style.top = `${topY}px`;
	line.style.bottom = `${height - baseY}px`;
	line.style.background = "rgba(15, 23, 42, 0.10)";
	layer.appendChild(line);

	// Vertical ruler: origin at bottom, no negatives. Labels match horizontal formatting.
	const usable = Math.max(80, baseY - topY);
	const max = kForLabels === 0 ? 1 : Math.pow(10, kForLabels);
	const half = max / 2;

	const yForValue = (v: number) => {
		const t = max <= 0 ? 0 : clamp(v / max, 0, 1);
		return baseY - t * usable;
	};

	const marks: Array<{ v: number; major: boolean; label: string }> = [
		{ v: 0, major: true, label: "0" },
		{ v: half, major: false, label: formatValue(half, state.fullNumber, kForLabels) },
		{ v: max, major: true, label: formatValue(max, state.fullNumber, kForLabels) },
	];

	for (const m of marks) {
		const y = clamp(yForValue(m.v), topY, baseY);

		const tick = document.createElement("div");
		tick.className = "absolute h-px";
		tick.style.left = `${midX}px`;
		tick.style.top = `${y}px`;
		tick.style.width = m.major ? "28px" : "18px";
		tick.style.transform = "translateX(-50%)";
		tick.style.background = m.major ? "rgba(15, 23, 42, 0.18)" : "rgba(15, 23, 42, 0.12)";
		layer.appendChild(tick);

		const label = document.createElement("div");
		label.className = "absolute -translate-y-1/2 whitespace-nowrap rounded-md px-1.5 py-0.5 text-xs font-semibold text-slate-700";
		label.style.left = `${midX + 18}px`;
		label.style.top = `${y}px`;
		label.style.opacity = String(opacity);
		label.style.textShadow = "0 1px 0 rgba(255,255,255,0.85), 0 2px 8px rgba(255,255,255,0.65)";
		label.textContent = m.label;
		layer.appendChild(label);
	}

	return layer;
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

	// Avoid any “veil” over particles: no blurred or translucent pill background.
	el.style.background = "transparent";
	el.style.border = "none";
	el.style.color = color.text;
	el.style.padding = subtle ? "6px 8px" : "7px 10px";
	el.style.borderRadius = "12px";
	el.style.fontSize = subtle ? "12px" : "13px";
	el.style.fontWeight = subtle ? "600" : "700";
	el.style.letterSpacing = "-0.01em";
	el.style.textShadow =
		"0 1px 0 rgba(255,255,255,0.95), 0 0 10px rgba(255,255,255,0.75), 0 6px 18px rgba(15,23,42,0.08)";
	el.style.opacity = subtle ? "0.9" : "1";
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

function applyValueAtClientPoint(clientX: number, clientY: number) {
	if (!engine) return;
	const rect = axis.getBoundingClientRect();
	const x = clamp(clientX - rect.left, 0, rect.width);
	const value = engine.numberLine.valueAt(x);
	const chosen = draggingBall ?? pickNearestBall(clientX);
	if (chosen === "b") {
		if (state.symmetric) state.valueA = clamp(-value, -engine.maxAbsValue, engine.maxAbsValue);
		else state.valueB = clamp(value, -engine.maxAbsValue, engine.maxAbsValue);
	} else {
		state.valueA = clamp(value, -engine.maxAbsValue, engine.maxAbsValue);
	}
	if (state.symmetric) state.valueB = -state.valueA;

	// ripple (throttled by movement during dragging; always emit on tap)
	const now = performance.now();
	lastRippleAt = now;
	lastRippleX = x;
	lastRippleY = clamp(clientY - rect.top, 0, rect.height);
	particles.addRipple(lastRippleX, lastRippleY);
	render();
}

axis.addEventListener("pointerdown", (e) => {
	if (pinching) return;
	dragging = true;
	const target = e.target as HTMLElement;
	const attr = target?.dataset?.ball as "a" | "b" | undefined;
	draggingBall = attr ?? pickNearestBall(e.clientX);
	axis.setPointerCapture(e.pointerId);

	// Tap anywhere: value follows finger/mouse immediately + ripple.
	applyValueAtClientPoint(e.clientX, e.clientY);
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
			draggingBall = pickNearestBall(e.touches[0].clientX);
			applyValueAtClientPoint(e.touches[0].clientX, e.touches[0].clientY);
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
	let overlay = host.querySelector<HTMLElement>("[data-nl-overlay]");
	if (bg && overlay) return { bg, overlay };

	bg = document.createElement("div");
	bg.dataset.nlBg = "1";
	bg.style.position = "absolute";
	bg.style.inset = "0";
	bg.style.pointerEvents = "none";
	bg.style.zIndex = "0";

	overlay = document.createElement("div");
	overlay.dataset.nlOverlay = "1";
	overlay.style.position = "absolute";
	overlay.style.inset = "0";
	overlay.style.pointerEvents = "auto";
	overlay.style.zIndex = "2";

	// ensure order: bg (0) -> particles canvas (1) -> overlay (2)
	host.appendChild(bg);
	host.appendChild(overlay);
	return { bg, overlay };
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
			t: 1,
			ease: 1,
		};
	}
	const now = performance.now();
	const t = clamp((now - transition.startAt) / transition.durationMs, 0, 1);
	const ease = easeInOutQuint(t);

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
		t,
		ease,
	};
}

function easeInOutQuint(t: number) {
	return t < 0.5 ? 16 * t * t * t * t * t : 1 - Math.pow(-2 * t + 2, 5) / 2;
}

function zoomPulse(t: number) {
	// 0 at endpoints, gentle in the middle.
	const s = Math.sin(Math.PI * clamp(t, 0, 1));
	return s * s;
}

// Initial render + resize handling
const ro = new ResizeObserver(() => render());
ro.observe(axis);

const roParticles = new ResizeObserver(() => particles.resize());
roParticles.observe(axis);

render();
