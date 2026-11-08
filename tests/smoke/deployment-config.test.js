import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
// Static checks that catch "works on my machine" deployment mistakes.
const root = path.resolve(import.meta.dirname, "../..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const exists = (file) => fs.existsSync(path.join(root, file));

function sourceFiles(dir, out = []) {
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(rel, out);
    else if (entry.name.endsWith(".js")) out.push(rel);
  }
  return out;
}

describe(".env.example", () => {
  // Provided by the platform / optional features, so not required in .env.example.
  const EXEMPT = new Set([
    "NODE_ENV",
    "AWS_LAMBDA_FUNCTION_NAME", // injected by AWS Lambda
    "PERSONAL_STORAGE_USER_IDS", // optional personal R2 routing
    "PERSONAL_R2_BUCKET",
    "PERSONAL_R2_ENDPOINT",
    "PERSONAL_R2_ACCESS_KEY_ID",
    "PERSONAL_R2_SECRET_ACCESS_KEY",
    "PERSONAL_R2_ACCOUNT_ID",
    "PERSONAL_R2_API_TOKEN",
  ]);

  const documented = new Set(
    read(".env.example")
      .split("\n")
      .map((line) => line.match(/^\s*#?\s*([A-Z][A-Z0-9_]*)\s*=/)?.[1])
      .filter(Boolean),
  );

  const used = new Set();
  const dirs = ["config", "controllers", "middleWares", "routes", "services", "utils", "jobs", "models", "observability"];
  for (const file of [...dirs.flatMap((d) => (exists(d) ? sourceFiles(d) : [])), "server.js", "bootstrap.js", "lambda.js"]) {
    if (!exists(file)) continue;
    for (const m of read(file).matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) used.add(m[1]);
  }

  it("documents every environment variable the code reads", () => {
    const missing = [...used].filter((name) => !documented.has(name) && !EXEMPT.has(name)).sort();
    expect(missing, `add these to .env.example: ${missing.join(", ")}`).toEqual([]);
  });

  it("does not contain real-looking secrets", () => {
    const text = read(".env.example");
    expect(text).not.toMatch(/mongodb\+srv:\/\/[^<\s]+:[^<\s]+@/); // credentials in a connection string
    expect(text).not.toMatch(/rzp_(live|test)_[A-Za-z0-9]{10,}/);
    expect(text).not.toMatch(/re_[A-Za-z0-9]{20,}/);
  });
});

describe("deployment files", () => {
  const pkg = JSON.parse(read("package.json"));

  it("package.json is an ES-module project with a working start script", () => {
    expect(pkg.type).toBe("module");
    expect(pkg.scripts.start).toBeTruthy();
    const entry = pkg.scripts.start.match(/(\S+\.js)\s*$/)?.[1];
    expect(entry, "start script should end with the entry .js file").toBeTruthy();
    expect(exists(entry)).toBe(true);
  });

  it("exposes test scripts for CI", () => {
    expect(pkg.scripts.test).toMatch(/vitest/);
  });

  it("PM2 config starts an existing entry file under the name the EC2 workflow reloads", () => {
    const pm2 = read("ecosystem.config.cjs");
    const script = pm2.match(/script:\s*"([^"]+)"/)?.[1];
    const name = pm2.match(/name:\s*"([^"]+)"/)?.[1];
    expect(exists(script)).toBe(true);
    expect(read(".github/workflows/deploy-ec2.yml")).toContain(`pm2 reload ${name}`);
  });

  it("keeps secrets out of git", () => {
    expect(read(".gitignore")).toMatch(/^\.env$/m);

    const trackedEnvFiles = execFileSync(
      "git",
      ["ls-files", "--", ".env"],
      { encoding: "utf8" }
    ).trim();

    expect(trackedEnvFiles).toBe("");
  });

  it("every deploy workflow runs the test suite before deploying", () => {
    for (const wf of fs.readdirSync(path.join(root, ".github/workflows"))) {
      if (!wf.startsWith("deploy")) continue;
      const text = read(`.github/workflows/${wf}`);
      expect(text, `${wf} should run tests first`).toMatch(/npm test|npm run test|needs:\s*\[?\s*test/);
    }
  });
});
