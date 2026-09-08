
import { z } from "zod";
import { CopilotClient, defineTool } from "@github/copilot-sdk";

type EvaluationResult = {
    score: number;
    reasoning: string;
};

const maxEvaluationAttempts = 3;

function isEvalFailure(error: unknown): boolean {
    return error instanceof Error && error.cause === "eval_failure";
}

const EvalSchema = z.object({
    score: z.number().min(1).max(10).describe("The score of the evaluation, must be between 1 and 10."),
    reasoning: z.string().min(1).max(500).describe("The reasoning and justification behind the evaluation, must be between 1 and 500 characters."),
});

const evaluateTool = defineTool(
    "evaluate",
    {
        description: "Evaluates the quality of a given code snippet and provides a score and reasoning.",
        parameters: EvalSchema,
        defer: "never",
        skipPermission: true,
        isTerminal: true,
        handler: async (value: any) => {
            return { score: value.score, reasoning: value.reasoning };
        },
    }
);

type StaticIssue = {
    severity: "block" | "warning";
    message: string;
};

function parseFrontmatter(agentDefinition: string): { fields: Record<string, string>; body: string } | null {
    const match = agentDefinition.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    if (!match) {
        return null;
    }

    const fields: Record<string, string> = {};
    const frontmatter = match[1];
    if (!frontmatter) {
        return null;
    }

    const lines = frontmatter.split(/\r?\n/);

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) {
            continue;
        }

        const keyValue = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
        if (!keyValue) {
            return null;
        }

        const [, key, value] = keyValue;
        if (!key || value === undefined) {
            return null;
        }

        fields[key] = value.trim();
    }

    return { fields, body: match[2] ?? "" };
}

function parseToolList(rawValue: string | undefined): string[] {
    if (!rawValue) {
        return [];
    }

    const trimmed = rawValue.trim();
    if (!trimmed) {
        return [];
    }

    const listMatch = trimmed.match(/^\[(.*)\]$/) || trimmed.match(/^\((.*)\)$/);
    if (!listMatch || !listMatch[1]) {
        return [];
    }

    return listMatch[1]
        .split(",")
        .map((tool) => tool.trim().replace(/^['\"]|['\"]$/g, ""))
        .filter(Boolean);
}

function evaluateStaticAgentIssues(agentDefinition: string): StaticIssue[] {
    const issues: StaticIssue[] = [];
    const parsed = parseFrontmatter(agentDefinition);

    if (!parsed) {
        return [{ severity: "block", message: "Malformed agent definition: missing properly formatted YAML frontmatter." }];
    }

    const { fields } = parsed;
    const requiredKeys = ["name", "description"];
    for (const key of requiredKeys) {
        const value = fields[key]?.trim();
        if (!value || value.length < 3) {
            issues.push({ severity: "block", message: `Missing or empty required frontmatter field: ${key}.` });
        }
    }

    const name = fields.name?.trim();
    if (name && !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(name)) {
        issues.push({ severity: "warning", message: `Agent name should be a simple identifier; got '${name}'.` });
    }

    const description = fields.description?.trim() ?? "";
    if (description && description.length < 20) {
        issues.push({ severity: "warning", message: "Description is too brief to clearly communicate the agent's role and boundaries." });
    }

    const tools = parseToolList(fields.tools).map((tool) => tool.trim().toLowerCase());
    if (tools.length === 0) {
        issues.push({ severity: "block", message: "Tool allow-list is missing; read-only or write-capable functions are not declared." });
    }

    const riskyTools = new Set(["bash", "execute", "write", "edit", "web", "agent", "vscode", "todo"]);
    const broadToolCount = tools.filter((tool) => riskyTools.has(tool)).length;
    if (tools.length > 6 || broadToolCount > 3) {
        issues.push({ severity: "warning", message: "Tool allow-list appears overly broad for a focused agent role." });
    }

    if (tools.length < 2 && description.toLowerCase().includes("implement")) {
        issues.push({ severity: "warning", message: "The agent may need more explicit capabilities than a single tool for implementation work." });
    }

    const model = fields.model?.trim();
    if (model) {
        const normalizedModel = model.toLowerCase();
        const validPrefix = ["auto", "claude", "gpt", "gemini", "kimi", "mai-code", "sonnet", "opus", "luna", "o3", "o4"];
        if (!validPrefix.some((prefix) => normalizedModel.includes(prefix))) {
            issues.push({ severity: "warning", message: `Model choice '${model}' does not match the expected Copilot model families.` });
        }

        const descriptionLower = description.toLowerCase();
        const modeIsReview = /review|analyze|summarize|plan/.test(descriptionLower);
        const modeIsImplement = /implement|code|write|edit|fix/.test(descriptionLower);

        if (modeIsReview && !/claude|gpt|mai-code|kimi|auto/.test(normalizedModel)) {
            issues.push({ severity: "warning", message: `Model '${model}' may be a weak choice for a review/planning role.` });
        }

        if (modeIsImplement && !/claude|gpt|mai-code|kimi|luna|sonnet|opus/.test(normalizedModel)) {
            issues.push({ severity: "warning", message: `Model '${model}' may be a weak choice for an implementation-heavy role.` });
        }
    }

    return issues;
}

const baseRole = `
You are an evaluator for agents, prompts, skills and tools. You will be given a code snippet and you need to evaluate its quality based on the following criteria:
1. Correctness: Does the code do what it is supposed to do?
2. Efficiency: Is the code optimized for performance?
3. Readability: Is the code easy to read and understand?
4. Maintainability: Is the code structured in a way that makes it easy to maintain and extend?
`;

const scoringSystem = `
<scoring>
The scoring system is based on a scale of 1 to 10, where 1 is the lowest and 10 is the highest. 
Every evaluation should include a reasoning to justify the score given.
1 - Failing: The agent or skill does not meet the basic requirements and fails to perform its intended function.
2 - Poor: The agent or skill has significant issues that hinder its performance and usability.
3 - Below Average: The agent or skill performs below expectations and has noticeable flaws
4 - Average: The agent or skill meets basic expectations but lacks advanced features or optimizations.
5 - Above Average: The agent or skill performs well in most scenarios but has some areas for improvement.
6 - Good: The agent or skill performs well and meets expectations, with minor areas for improvement.
7 - Very Good: The agent or skill performs very well, with only minor issues or areas for improvement.
8 - Excellent: The agent or skill performs excellently, with only minor issues
9 - Outstanding: The agent or skill performs exceptionally well, with very few issues or areas for improvement.
10 - Exceptional: The agent or skill performs exceptionally well, exceeding expectations and demonstrating advanced capabilities
</scoring>`;

async function evaluateBase(systemMessage: string, evaluationPrompt: string): Promise<EvaluationResult> {
    for (let attempt = 1; attempt <= maxEvaluationAttempts; attempt++) {
        try {
            return await evaluateBaseAttempt(systemMessage, evaluationPrompt);
        } catch (error) {
            if (!isEvalFailure(error)) {
                throw error;
            }

            if (attempt === maxEvaluationAttempts) {
                throw new Error("Maximum retry attempts reached during evaluation.", { cause: "eval_failure" });
            }

            console.error(`Evaluation failed, retrying (${attempt}/${maxEvaluationAttempts})...`, error);
        }
    }

    throw new Error("Maximum retry attempts reached during evaluation.", { cause: "eval_failure" });
}

async function evaluateBaseAttempt(systemMessage: string, evaluationPrompt: string): Promise<EvaluationResult> {
    const client = new CopilotClient();
    await client.start();

    try {
        const session = await client.createSession({
            systemMessage: {
                mode: "replace",
                content: systemMessage,
            },
            enableSessionStore: false,
            tools: [evaluateTool],
        });

        const result = await session.sendAndWait(evaluationPrompt);

        if (!result?.data.toolRequests || result.data.toolRequests.length === 0) {
            throw new Error("No tool requests found in the evaluation result.", { cause: "eval_failure" });
        }

        const evaluations = result.data.toolRequests
            .filter((request) => request.name === "evaluate")
            .map((request) => {
                const args = request.arguments;
                const isRecord = typeof args === "object" && args !== null && !Array.isArray(args);
                return {
                    score: isRecord ? (args as { [key: string]: unknown }).score : undefined,
                    reasoning: isRecord ? (args as { [key: string]: unknown }).reasoning : undefined,
                } as EvaluationResult;
            });

        if (evaluations.length === 0) {
            throw new Error("No evaluations found in the tool requests.", { cause: "eval_failure" });
        }
        
        const evaluation = evaluations[0];
        
        if (evaluation?.score === undefined || evaluation?.reasoning === undefined) {
            throw new Error("Incomplete evaluation result.", { cause: "eval_failure" });
        }
        
        return evaluation;
    } catch (error) {
        console.error("Error during evaluation:", error);
        throw error;
    } finally {
        await client.stop();
    }
}

async function evaluatePerformance(userPrompt: string, processOutput: string, expectations: string): Promise<EvaluationResult> {
    const systemMessage = `
${baseRole}
${scoringSystem}
`;
    const evaluationPrompt = `
Evaluate the performance based on the following user prompt, process output, and expectations.

<user-prompt>
${userPrompt}
</user-prompt>

<process-output>
${processOutput}
</process-output>

<expectations>
${expectations}
</expectations>
`;

    return await evaluateBase(systemMessage, evaluationPrompt);
}

async function evaluateSkillDefinition(skillDefinition: string, skillArtifacts?: { path: string; content: string }[]) : Promise<EvaluationResult> {
    const systemMessage = `
${baseRole}
${scoringSystem}
`;
    let evaluationPrompt = `
Evaluate the following skill definition based on the criteria provided.

<skill-definition>
${skillDefinition}
</skill-definition>
`;
    if (skillArtifacts && skillArtifacts.length > 0) {
        evaluationPrompt += `
<skill-artifacts>
${skillArtifacts.map(artifact => `<artifact path="${artifact.path}">${artifact.content}</artifact>`).join("\n")}
</skill-artifacts>
`;
    }

    return await evaluateBase(systemMessage, evaluationPrompt);
}

async function evaluateAgentDefinition(agentDefinition: string): Promise<EvaluationResult> {
    const staticIssues = evaluateStaticAgentIssues(agentDefinition);
    const blockIssue = staticIssues.find((issue) => issue.severity === "block");
    if (blockIssue) {
        return {
            score: 0,
            reasoning: `Static validation failed: ${blockIssue.message}. ${staticIssues.filter((issue) => issue !== blockIssue).map((issue) => issue.message).join(" ")}`.trim(),
        };
    }

    const systemMessage = `
${baseRole}
${scoringSystem}
`;
    const evaluationPrompt = `
Evaluate the following agent definition based on the criteria provided. 

<agent-definition>
${agentDefinition}
</agent-definition>
`;

    const evaluation = await evaluateBase(systemMessage, evaluationPrompt);
    const warnings = staticIssues.filter((issue) => issue.severity === "warning");
    const penalty = Math.min(4, warnings.length * 2);
    const score = Math.max(0, Math.min(10, evaluation.score - penalty));

    return {
        score,
        reasoning: warnings.length > 0
            ? `${warnings.map((issue) => issue.message).join(" ")} ${evaluation.reasoning}`
            : evaluation.reasoning,
    };
}


export {
    evaluatePerformance,
    evaluateSkillDefinition,
    evaluateAgentDefinition,
    evaluateStaticAgentIssues
};

export type { EvaluationResult };