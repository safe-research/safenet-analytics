// One colour per validator, the same in every Validators chart, legend and rendered image
// (docs/metrics/validators.md#colours). Assigned in label order over every validator in
// dune/data/participants.json, from the categorical palette of scripts/render-preview.ts.
// Unknown validators (address only) get UNKNOWN_VALIDATOR_COLOR. test/validators.test.ts checks
// that the chart settings use exactly these.

export const VALIDATOR_COLORS: Record<string, string> = {
  "Blockchain Capital": "#2a78d6",
  "Core Contributors": "#eb6834",
  Gnosis: "#1baf7a",
  Greenfield: "#eda100",
  RockawayX: "#e87ba4",
  "Safe Labs": "#008300",
};
export const UNKNOWN_VALIDATOR_COLOR = "#6f6e69";

export const validatorColor = (name: string) => VALIDATOR_COLORS[name] ?? UNKNOWN_VALIDATOR_COLOR;
