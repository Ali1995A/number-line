import { INumberLineOptions, ITickMarkLabelStrategy, NumberLine } from "../../lib/number-line";

export interface LadderEngine {
	numberLine: NumberLine;
	width: number;
	k: number;
	maxAbsValue: number;
	unitValue: number;
}

export function createLadderEngine(k: number, width: number): LadderEngine {
	const safeWidth = Math.max(1, Math.floor(width));
	const maxAbsValue = Math.pow(10, k);
	const unitValue = maxAbsValue; // one unit == 10^k

	const labelStrategy: ITickMarkLabelStrategy = {
		labelFor: (value, index) => {
			// label major + mid ticks (pattern indices 0 and 5 for our default pattern)
			if (index % 5 === 0) return value.toFixed(k === 0 ? 1 : 0);
			return null;
		},
	};

	const options: INumberLineOptions = {
		// classic: major at 0, mid at 5, minors elsewhere
		pattern: [3, 1, 1, 1, 1, 2, 1, 1, 1, 1],
		// lock unitLength so pixel spacing stays stable; show [-10^k, +10^k] across full width
		breakpointLowerbound: safeWidth / 2,
		breakpointUpperBound: safeWidth / 2,
		zoomPeriod: 1,
		zoomFactor: unitValue,
		labelStrategy,
		initialMagnification: 0,
		initialDisplacement: 0,
	};

	const numberLine = new NumberLine(options);
	// Map values exactly: x=0 => -10^k, x=width/2 => 0, x=width => +10^k
	numberLine.panTo(-safeWidth / 2);

	return {
		numberLine,
		width: safeWidth,
		k,
		maxAbsValue,
		unitValue,
	};
}
