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
	const unitValue = 2 * maxAbsValue; // value span across the full viewport width

	const labelStrategy: ITickMarkLabelStrategy = {
		labelFor: () => null,
	};

	const options: INumberLineOptions = {
		pattern: [3, 1, 2, 1], // 5 ticks across width (start, quarter, mid, 3/4, end)
		breakpointLowerbound: safeWidth,
		breakpointUpperBound: safeWidth,
		zoomPeriod: 1,
		zoomFactor: unitValue,
		labelStrategy,
		initialMagnification: 0,
		initialDisplacement: 0,
	};

	const numberLine = new NumberLine(options);
	// keep 0 centered: valueAt(width/2) == 0
	numberLine.panTo(-safeWidth / 2);

	return {
		numberLine,
		width: safeWidth,
		k,
		maxAbsValue,
		unitValue,
	};
}

