import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const root = new URL("../", import.meta.url);

type Step = {
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  "continue-on-error"?: boolean;
};
type Workflow = {
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  jobs: Record<
    string,
    {
      permissions?: Record<string, string>;
      "timeout-minutes": number;
      strategy?: {
        "fail-fast": boolean;
        matrix: { language: string[] };
      };
      steps: Step[];
    }
  >;
};

function readWorkflow(name: string): Workflow {
  return Bun.YAML.parse(
    readFileSync(new URL(`.github/workflows/${name}.yml`, root), "utf8"),
  ) as Workflow;
}

test("CodeQL scans source and Actions with only analysis-scoped upload permission", () => {
  const workflow = readWorkflow("codeql");
  expect(Object.keys(workflow.on).sort()).toEqual([
    "pull_request",
    "push",
    "schedule",
    "workflow_dispatch",
  ]);
  expect(workflow.on.pull_request).toEqual({ branches: ["main"] });
  expect(workflow.on.push).toEqual({ branches: ["main"] });
  expect(workflow.on.schedule).toEqual([{ cron: "23 4 * * 1" }]);
  expect(workflow.permissions).toEqual({});
  expect(Object.keys(workflow.jobs)).toEqual(["analyze"]);
  const job = workflow.jobs.analyze;
  expect(job.permissions).toEqual({
    contents: "read",
    "security-events": "write",
  });
  expect(job.strategy).toEqual({
    "fail-fast": false,
    matrix: { language: ["javascript-typescript", "actions"] },
  });
  expect(job.steps.map((step) => step.uses?.split("@")[0])).toEqual([
    "actions/checkout",
    "github/codeql-action/init",
    "github/codeql-action/analyze",
  ]);
  expect(job.steps.some((step) => step.run)).toBe(false);
  expect(job.steps[1].with).toEqual({
    languages: "${{ matrix.language }}",
    "build-mode": "none",
  });
  expect(job.steps[2].with).toEqual({
    category: "/language:${{ matrix.language }}",
  });
});

test("dependency audit checks the lockfile without installing or suppressing findings", () => {
  const workflow = readWorkflow("dependency-audit");
  expect(Object.keys(workflow.on).sort()).toEqual([
    "pull_request",
    "schedule",
    "workflow_dispatch",
  ]);
  expect(workflow.on.pull_request).toEqual({
    paths: [
      "**/package.json",
      "bun.lock",
      "**/bunfig.toml",
      "**/.npmrc",
      ".github/workflows/dependency-audit.yml",
    ],
  });
  expect(workflow.on.schedule).toEqual([{ cron: "41 4 * * 1" }]);
  expect(workflow.permissions).toEqual({ contents: "read" });
  expect(Object.keys(workflow.jobs)).toEqual(["audit"]);
  const job = workflow.jobs.audit;
  expect(job.permissions).toBeUndefined();
  const command = "bun audit --json --audit-level=high";
  expect(job.steps.flatMap((step) => (step.run ? [step.run] : []))).toEqual([
    command,
  ]);
  const manifest = JSON.parse(
    readFileSync(new URL("package.json", root), "utf8"),
  );
  expect(manifest.scripts.audit).toBe(command);
  expect(job.steps[1].uses).toStartWith("oven-sh/setup-bun@");
  expect(job.steps[1].with).toEqual({
    "bun-version": "1.4.1",
    "no-cache": true,
  });
});

test("security workflows pin actions and do not retain credentials or ignore failures", () => {
  for (const name of ["codeql", "dependency-audit"]) {
    const workflow = readWorkflow(name);
    expect(workflow.on.pull_request_target).toBeUndefined();
    expect(workflow.on.workflow_run).toBeUndefined();
    for (const job of Object.values(workflow.jobs)) {
      expect(job["timeout-minutes"]).toBeGreaterThan(0);
      expect(job["timeout-minutes"]).toBeLessThanOrEqual(30);
      for (const step of job.steps) {
        expect(step["continue-on-error"]).toBeUndefined();
        if (!step.uses) continue;
        expect(step.uses).toMatch(/^[\w-]+\/[\w/-]+@[a-f0-9]{40}$/);
        if (step.uses.startsWith("actions/checkout@")) {
          expect(step.with).toEqual({ "persist-credentials": false });
        }
      }
    }
  }
});

test("Dependabot uses weekly family groups with an explicit xterm beta-pair exception", () => {
  const config = Bun.YAML.parse(
    readFileSync(new URL(".github/dependabot.yml", root), "utf8"),
  ) as {
    version: number;
    updates: {
      "package-ecosystem": string;
      directory: string;
      schedule: { interval: string; timezone: string };
      "open-pull-requests-limit": number;
      ignore?: unknown;
      groups: Record<
        string,
        {
          patterns: string[];
          "update-types"?: string[];
          "exclude-patterns"?: string[];
          "dependency-type"?: string;
          "applies-to"?: string;
        }
      >;
    }[];
  };
  expect(config.version).toBe(2);
  expect(config.updates.map((entry) => entry["package-ecosystem"])).toEqual([
    "bun",
    "github-actions",
  ]);
  for (const entry of config.updates) {
    expect(entry.directory).toBe("/");
    expect(entry.schedule.interval).toBe("weekly");
    expect(entry.schedule.timezone).toBe("Etc/UTC");
    expect(entry["open-pull-requests-limit"]).toBeGreaterThan(0);
    expect(entry["open-pull-requests-limit"]).toBeLessThanOrEqual(5);
    expect(entry.ignore).toBeUndefined();
    for (const [name, group] of Object.entries(entry.groups)) {
      expect(group.patterns.length).toBeGreaterThan(0);
      if (entry["package-ecosystem"] === "bun" && name === "xterm-core-fit") {
        expect(group["update-types"]).toBeUndefined();
        expect(group.patterns).toEqual(["@xterm/xterm", "@xterm/addon-fit"]);
      } else {
        expect(group["update-types"]).toEqual(["minor", "patch"]);
      }
      expect(group["dependency-type"]).toBeUndefined();
      expect(group["applies-to"]).toBeUndefined();
    }
  }
  expect(config.updates[0].groups["xterm-addons"].patterns).toEqual([
    "@xterm/*",
  ]);
  expect(config.updates[0].groups["xterm-addons"]["exclude-patterns"]).toEqual([
    "@xterm/xterm",
    "@xterm/addon-fit",
  ]);
  expect(config.updates[0].groups.codemirror.patterns).toEqual([
    "@codemirror/*",
    "@lezer/*",
    "codemirror",
  ]);
  expect(config.updates[0].groups["radix-ui"].patterns).toEqual([
    "@radix-ui/*",
    "cmdk",
  ]);
  expect(config.updates[0].groups["diff-highlighting"].patterns).toEqual([
    "diff2html",
    "highlight.js",
  ]);
  expect(config.updates[1].groups.actions.patterns).toEqual(["*"]);
});
