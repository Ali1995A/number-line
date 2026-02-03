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
import { RulerCanvas } from "./ladder/ruler-canvas";

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
const lowEndIPad = detectLowEndIPad();
const ruler = new RulerCanvas(axis, layers.overlay);
ruler.setLowEnd(lowEndIPad);
document.body.classList.toggle("nl-low-end", lowEndIPad);
const overlayUI = createOverlayUI(layers.overlay);

const state: State = {
	k: 0,
	targetK: 0,
	stepMode: toggleStepMode.checked,
	fullNumber: toggleFullNumber.checked,
	symmetric: true,
	valueA: 0,
	valueB: 0,
};

let lastScaleLabelText = "";
let lastRangeLabelText = "";
let lastCurrentValueText = "";

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
let renderScheduled = false;
let renderNeeded = false;

function requestRender() {
	renderNeeded = true;
	if (renderScheduled) return;
	renderScheduled = true;
	requestAnimationFrame(() => {
		renderScheduled = false;
		if (!renderNeeded) return;
		renderNeeded = false;
		render();
	});
}

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
	requestRender();
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

	const nextScaleLabel = formatScaleLabel(state.k);
	const nextRangeLabel = `${formatRangeLabel(state.k)}`;
	const nextCurrentValue = formatValueBanner();
	if (nextScaleLabel !== lastScaleLabelText) {
		lastScaleLabelText = nextScaleLabel;
		scaleLabelEl.textContent = nextScaleLabel;
	}
	if (nextRangeLabel !== lastRangeLabelText) {
		lastRangeLabelText = nextRangeLabel;
		rangeLabelEl.textContent = nextRangeLabel;
	}
	if (nextCurrentValue !== lastCurrentValueText) {
		lastCurrentValueText = nextCurrentValue;
		currentValueEl.textContent = nextCurrentValue;
	}

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

	ruler.render({
		width: engine.width,
		height,
		fullNumber: state.fullNumber,
		k: state.k,
		engine,
		transition: transition
			? {
					fromK: transition.fromK,
					toK: transition.toK,
					t: ball.t,
					ease: ball.ease,
					fromEngine: transition.fromEngine,
					toEngine: transition.toEngine,
				}
			: undefined,
		formatValue,
		lowEnd: lowEndIPad,
	});

	updateOverlayUI(overlayUI, {
		width: engine.width,
		height,
		xA: ball.xA,
		xB: ball.xB,
		labelA: formatValue(state.valueA, state.fullNumber, state.k),
		labelB: formatValue(state.valueB, state.fullNumber, state.k),
		symmetric: state.symmetric,
		fromOpacity: ball.labelsOpacity.from,
		toOpacity: ball.labelsOpacity.to,
	});

	// continue animation frames if needed
	if (transition) requestRender();
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

type OverlayUI = {
	wrap: HTMLElement;
	centerLine: HTMLDivElement;
	centerBadge: HTMLDivElement;
	signLeft: HTMLDivElement;
	signRight: HTMLDivElement;
	followerA: HTMLDivElement;
	followerB: HTMLDivElement;
	ballA: BallUI;
	ballB: BallUI;
};

type BallUI = {
	wrap: HTMLDivElement;
	line: HTMLDivElement;
	ghost: HTMLDivElement;
	knob: HTMLDivElement;
	hit: HTMLDivElement;
};

function createOverlayUI(host: HTMLElement): OverlayUI {
	host.style.pointerEvents = "none";
	const wrap = document.createElement("div");
	wrap.className = "absolute inset-0";
	wrap.style.pointerEvents = "none";

	const centerLine = document.createElement("div");
	centerLine.className = "absolute inset-y-0";
	centerLine.style.width = "3px";
	centerLine.style.background = "rgba(15, 23, 42, 0.90)";

	const centerBadge = document.createElement("div");
	centerBadge.className =
		"absolute left-1/2 top-2 -translate-x-1/2 rounded-full bg-slate-900 px-2 py-0.5 text-xs font-semibold text-white";
	centerBadge.textContent = "0";

	const signLeft = document.createElement("div");
	signLeft.className = "absolute left-3 bottom-2 text-xs font-semibold text-sky-600";
	signLeft.textContent = "负";

	const signRight = document.createElement("div");
	signRight.className = "absolute right-3 bottom-2 text-xs font-semibold text-rose-600";
	signRight.textContent = "正";

	const followerA = document.createElement("div");
	followerA.className = "absolute top-3 -translate-x-1/2 select-none";
	followerA.style.pointerEvents = "none";
	followerA.style.fontSize = "14px";
	followerA.style.fontWeight = "800";
	followerA.style.color = "rgb(136, 19, 55)";

	const followerB = document.createElement("div");
	followerB.className = "absolute top-3 -translate-x-1/2 select-none";
	followerB.style.pointerEvents = "none";
	followerB.style.fontSize = "13px";
	followerB.style.fontWeight = "800";
	followerB.style.color = "rgb(12, 74, 110)";

	const ballA = createBallUI("a");
	const ballB = createBallUI("b");

	wrap.append(centerLine, centerBadge, signLeft, signRight, followerA, followerB, ballA.wrap, ballB.wrap);
	host.appendChild(wrap);

	return { wrap, centerLine, centerBadge, signLeft, signRight, followerA, followerB, ballA, ballB };
}

function createBallUI(which: "a" | "b"): BallUI {
	const wrap = document.createElement("div");
	wrap.className = "absolute inset-y-0";
	wrap.style.width = "0px";
	wrap.style.pointerEvents = "none";

	const color =
		which === "a"
			? { line: "rgba(236,72,153,1)", fill: "rgb(253, 164, 215)", border: "rgb(219,39,119)" }
			: { line: "rgba(56,189,248,1)", fill: "rgb(125, 211, 252)", border: "rgb(14, 116, 144)" };

	const line = document.createElement("div");
	line.className = "absolute bottom-10 w-0.5";
	line.style.left = "-1px";
	line.style.height = "64px";
	line.style.background = color.line;

	const knob = document.createElement("div");
	knob.className = "absolute bottom-10 left-0 -translate-x-1/2 -translate-y-1/2";
	knob.style.width = "28px";
	knob.style.height = "28px";
	knob.style.borderRadius = "999px";
	knob.style.border = `3px solid ${color.border}`;
	knob.style.background = color.fill;
	knob.style.boxShadow = "0 8px 18px rgba(15, 23, 42, 0.16)";

	const hit = document.createElement("div");
	hit.className = "absolute bottom-10 left-0 -translate-x-1/2 -translate-y-1/2";
	hit.style.width = "52px";
	hit.style.height = "52px";
	hit.style.borderRadius = "999px";
	hit.style.background = "transparent";
	hit.style.pointerEvents = "auto";
	hit.dataset.ball = which;

	const ghost = document.createElement("div");
	ghost.className = knob.className;
	ghost.style.width = knob.style.width;
	ghost.style.height = knob.style.height;
	ghost.style.borderRadius = knob.style.borderRadius;
	ghost.style.border = knob.style.border;
	ghost.style.background = knob.style.background;
	ghost.style.boxShadow = "none";

	wrap.append(line, ghost, knob, hit);
	return { wrap, line, ghost, knob, hit };
}

function updateOverlayUI(
	ui: OverlayUI,
	p: {
		width: number;
		height: number;
		xA: number;
		xB: number;
		labelA: string;
		labelB: string;
		symmetric: boolean;
		fromOpacity: number;
		toOpacity: number;
	},
) {
	const midX = p.width / 2;
	ui.centerLine.style.left = `${midX}px`;

	const clampX = (x: number) => clamp(x, 24, p.width - 24);
	ui.followerA.style.left = `${clampX(p.xA)}px`;
	if (ui.followerA.textContent !== p.labelA) ui.followerA.textContent = p.labelA;

	ui.followerB.style.left = `${clampX(p.xB)}px`;
	if (ui.followerB.textContent !== p.labelB) ui.followerB.textContent = p.labelB;
	ui.followerB.style.opacity = p.symmetric ? "0.75" : "1";

	updateBallUI(ui.ballA, p.xA, p.fromOpacity, p.toOpacity);
	updateBallUI(ui.ballB, p.xB, p.fromOpacity, p.toOpacity);
}

function updateBallUI(ball: BallUI, x: number, fromOpacity: number, toOpacity: number) {
	ball.wrap.style.left = `${x}px`;
	ball.line.style.opacity = String(toOpacity);
	ball.knob.style.opacity = String(toOpacity);
	ball.ghost.style.opacity = String(fromOpacity);
}

function valueToXWithEngine(value: number, eng: LadderEngine): number {
	// valueAt(pos) = (pos + displacement) / (unitLength/unitValue)
	// => pos = value*(unitLength/unitValue) - displacement
	const ratio = eng.numberLine.unitLength / eng.numberLine.unitValue;
	return value * ratio - eng.numberLine.displacement;
}

// --- Interactions ---

btnZoomIn.addEventListener("click", () => bumpK(+1));
btnZoomOut.addEventListener("click", () => bumpK(-1));
btnResetZero.addEventListener("click", () => {
	state.valueA = 0;
	state.valueB = 0;
	requestRender();
});

toggleStepMode.addEventListener("change", () => {
	state.stepMode = toggleStepMode.checked;
	stepper.setStepMs(state.stepMode ? 320 : 0);
});

toggleFullNumber.addEventListener("change", () => {
	state.fullNumber = toggleFullNumber.checked;
	requestRender();
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
	requestRender();
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

function applyValueAtClientPoint(clientX: number, clientY: number, opts?: { emitRipple?: boolean }) {
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

	const emitRipple = opts?.emitRipple ?? true;
	if (emitRipple) {
		// ripple (throttled by movement during dragging; always emit on tap)
		const now = performance.now();
		lastRippleAt = now;
		lastRippleX = x;
		lastRippleY = clamp(clientY - rect.top, 0, rect.height);
		particles.addRipple(lastRippleX, lastRippleY);
	}
	requestRender();
}

axis.addEventListener("pointerdown", (e) => {
	// On iPad Safari, both Pointer Events and Touch Events may fire; we use Touch Events for touch UX.
	if (e.pointerType === "touch") return;
	if (pinching) return;
	dragging = true;
	draggingBall = pickNearestBall(e.clientX);
	axis.setPointerCapture(e.pointerId);

	// Tap anywhere: value follows finger/mouse immediately + ripple.
	applyValueAtClientPoint(e.clientX, e.clientY, { emitRipple: true });
});

axis.addEventListener("pointermove", (e) => {
	if (e.pointerType === "touch") return;
	if (pinching) return;
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
	const rippleDt = lowEndIPad ? 140 : 80;
	const rippleDist = lowEndIPad ? 32 : 18;
	if (dt >= rippleDt && dist >= rippleDist) {
		lastRippleAt = now;
		lastRippleX = x;
		lastRippleY = y;
		particles.addRipple(x, y);
	}
	requestRender();
});

axis.addEventListener("pointerup", (e) => {
	if (e.pointerType === "touch") return;
	dragging = false;
	draggingBall = null;
});
axis.addEventListener("pointercancel", (e) => {
	if (e.pointerType === "touch") return;
	dragging = false;
	draggingBall = null;
});

// iPad pinch (Touch Events): snap to k±1 with thresholds.
let pinchStartDist = 0;
let touchDragging = false;
let touchDragId: number | null = null;
let touchMoved = false;
let lastTouchX = 0;
let lastTouchY = 0;
axis.addEventListener(
	"touchstart",
	(e) => {
		if (e.touches.length === 1) {
			pinching = false;
			touchDragging = true;
			touchMoved = false;
			touchDragId = e.touches[0].identifier;
			draggingBall = pickNearestBall(e.touches[0].clientX);
			lastTouchX = e.touches[0].clientX;
			lastTouchY = e.touches[0].clientY;
			// Immediate follow + ripple for kid-friendly feedback.
			applyValueAtClientPoint(lastTouchX, lastTouchY, { emitRipple: true });
		} else if (e.touches.length === 2) {
			e.preventDefault();
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
			if (!touchMoved) {
				// First movement: immediate visible feedback.
				touchMoved = true;
				lastRippleAt = now;
				lastRippleX = x;
				lastRippleY = y;
				particles.addRipple(x, y);
			} else
			if (dt >= (lowEndIPad ? 140 : 80) && dist >= (lowEndIPad ? 32 : 18)) {
				lastRippleAt = now;
				lastRippleX = x;
				lastRippleY = y;
				particles.addRipple(x, y);
			}
			lastTouchX = t.clientX;
			lastTouchY = t.clientY;
			requestRender();
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
	touchMoved = false;
});
axis.addEventListener("touchcancel", () => {
	pinchStartDist = 0;
	pinching = false;
	touchDragging = false;
	touchDragId = null;
	draggingBall = null;
	touchMoved = false;
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
	overlay.style.pointerEvents = "none";
	overlay.style.zIndex = "3";

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
	const ease = easeInOutCubic(t);

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

function easeInOutCubic(t: number) {
	return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

// Initial render + resize handling
const ro = new ResizeObserver(() => {
	particles.resize();
	ruler.resize();
	requestRender();
});
ro.observe(axis);
particles.resize();
ruler.resize();
requestRender();

function detectLowEndIPad() {
	const ua = (navigator.userAgent || "").toLowerCase();
	const isIPad = ua.includes("ipad") || (ua.includes("macintosh") && "ontouchend" in document);
	if (!isIPad) return false;
	const cores = (navigator as any).hardwareConcurrency || 4;
	return cores <= 2;
}
