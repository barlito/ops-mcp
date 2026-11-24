import { ToolError } from "../tools/contract";

export type LabelName = "service" | "server" | "service_namespace" | "service_name" | "host_name";

const MAX_VALUE_CHARS = 200;
// Newline is escaped; every other control character is refused.
const FORBIDDEN = /[\u0000-\u0009\u000b-\u001f\u007f]/;
// ASCII punctuation except `_`.
const REGEX_PUNCTUATION = /[!-/:-@\[-^`{-~]/g;

function assertValue(value: string): void {
  if (value.length > MAX_VALUE_CHARS || FORBIDDEN.test(value)) {
    throw new ToolError("invalid_parameter", `Label value must be at most ${MAX_VALUE_CHARS} characters without control characters.`);
  }
}

const quote = (value: string): string => value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");

export function escapeLabelValue(value: string): string {
  assertValue(value);
  return quote(value);
}

export const eq = (label: LabelName, value: string): string => `${label}="${escapeLabelValue(value)}"`;

const regexLiteral = (value: string): string => {
  assertValue(value);
  return quote(value.replace(REGEX_PUNCTUATION, "\\$&"));
};

// Prometheus anchors the regex: `suffix` is a raw, trusted regex fragment appended to each alternative.
export function anyOf(label: LabelName, values: string[], suffix = ""): string {
  return `${label}=~"(${values.map(regexLiteral).join("|")})${suffix}"`;
}
