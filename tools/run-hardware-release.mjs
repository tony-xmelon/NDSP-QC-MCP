#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";
import { verifyReleaseBundle } from "./release-candidates.mjs";

const root = resolve(import.meta.dirname, "..");

function usage() {
  throw new Error("Usage: node tools/run-hardware-release.mjs <windows|android> --config <path> [--execute]");
}

export function selectPlatformCandidate(candidates, platform) {
  const platformRoot = `${resolve(root, "artifacts", platform)}${sep}`.toLowerCase();
  const matches = candidates.filter((candidate) => resolve(candidate).toLowerCase().startsWith(platformRoot));
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one current ${platform} release candidate, found ${matches.length}.`);
  }
  return matches[0];
}

export function hardwareReleaseArguments(platform, configPath, candidate, execute = false) {
  const output = resolve(root, "artifacts", "hardware-conformance", `${platform}.json`);
  return {
    output,
    args: [
      resolve(root, "tools", "hardware-conformance.mjs"),
      "--config", resolve(configPath),
      ...(execute ? ["--execute"] : []),
      "--all",
      "--require-all",
      "--release-candidate", candidate,
      "--output", output,
    ],
  };
}

export function runHardwareRelease(argv = process.argv.slice(2)) {
  const [platform] = argv;
  if (!(["windows", "android"].includes(platform))) usage();
  const configPath = argv[2];
  if (argv[1] !== "--config" || !configPath || configPath.startsWith("--")
      || argv.length > 4 || (argv.length === 4 && argv[3] !== "--execute")) usage();

  const candidates = verifyReleaseBundle();
  if (candidates.length !== 2) {
    throw new Error(`Hardware release testing requires one Windows and one Android candidate; verified ${candidates.length}.`);
  }
  const candidate = selectPlatformCandidate(candidates, platform);
  const { args, output } = hardwareReleaseArguments(platform, configPath, candidate, argv[3] === "--execute");
  console.log(`${platform} candidate: ${candidate}`);
  console.log(`${platform} evidence: ${output}`);
  const result = spawnSync(process.execPath, args, { cwd: root, env: process.env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status ?? 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    runHardwareRelease();
  } catch (error) {
    console.error(error?.message ?? error);
    process.exitCode = 1;
  }
}
