import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const priorities = new Set(["high", "medium", "low"]);
const [issuesPath, decisionsPath] = process.argv.slice(2);

if (!issuesPath || !decisionsPath) {
  throw new Error("Usage: node apply-backlog-priorities.mjs <issues.json> <decisions.json>");
}

const issues = JSON.parse(readFileSync(issuesPath, "utf8"));
const result = JSON.parse(readFileSync(decisionsPath, "utf8"));
const decisions = result.decisions;

if (!Array.isArray(issues) || !Array.isArray(decisions)) {
  throw new Error("Issues and decisions must both be arrays");
}

const issueNumbers = new Set(issues.map((issue) => issue.number));
const decisionsByNumber = new Map();

for (const decision of decisions) {
  if (
    !Number.isInteger(decision.number) ||
    !priorities.has(decision.priority) ||
    typeof decision.reasoning !== "string" ||
    decision.reasoning.trim().length === 0
  ) {
    throw new Error(`Invalid decision: ${JSON.stringify(decision)}`);
  }
  if (!issueNumbers.has(decision.number)) {
    throw new Error(`Decision references unknown issue #${decision.number}`);
  }
  if (decisionsByNumber.has(decision.number)) {
    throw new Error(`Duplicate decision for issue #${decision.number}`);
  }
  decisionsByNumber.set(decision.number, decision);
}

const missing = issues.filter((issue) => !decisionsByNumber.has(issue.number));
if (missing.length > 0) {
  throw new Error(`Missing decisions for issues: ${missing.map((issue) => `#${issue.number}`).join(", ")}`);
}

for (const issue of issues) {
  const decision = decisionsByNumber.get(issue.number);
  const currentPriorities = issue.labels
    .map((label) => label.name.toLowerCase())
    .filter((label) => priorities.has(label));

  if (currentPriorities.length === 1 && currentPriorities[0] === decision.priority) {
    console.log(`#${issue.number}: remains ${decision.priority}`);
    continue;
  }

  const argumentsList = ["issue", "edit", String(issue.number)];
  for (const priority of currentPriorities) {
    argumentsList.push("--remove-label", priority);
  }
  argumentsList.push("--add-label", decision.priority);
  execFileSync("gh", argumentsList, { stdio: "inherit" });

  const previous = currentPriorities.length > 0 ? currentPriorities.join(", ") : "unprioritized";
  const comment = [
    `Priority changed from **${previous}** to **${decision.priority}**.`,
    "",
    `Reasoning: ${decision.reasoning.trim()}`,
    "",
    "_Updated by the weekly backlog prioritization workflow._",
  ].join("\n");

  execFileSync("gh", ["issue", "comment", String(issue.number), "--body", comment], {
    stdio: "inherit",
  });
  console.log(`#${issue.number}: ${previous} -> ${decision.priority}`);
}