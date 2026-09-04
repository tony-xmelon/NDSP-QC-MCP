#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { validateReleaseReports } from "./hardware-conformance-lib.mjs";

const root = resolve(import.meta.dirname, "..");
const paths = process.argv.slice(2);
if (paths.length !== 2) {
  console.error("Usage: node tools/verify-hardware-release.mjs <windows-report.json> <android-report.json>");
  process.exit(2);
}
try {
  const contract = JSON.parse(await readFile(resolve(root, "contracts/qc-actions.v1.json"), "utf8"));
  const reports = await Promise.all(paths.map(async (path) => {
    const absolutePath = resolve(path);
    try {
      return JSON.parse(await readFile(absolutePath, "utf8"));
    } catch (error) {
      const detail = error?.code === "ENOENT" ? "does not exist" : `could not be read: ${error?.message ?? error}`;
      throw new Error(`Hardware evidence report ${absolutePath} ${detail}.`);
    }
  }));
  const result = validateReleaseReports(contract, reports);
  console.log(JSON.stringify({ hardwareReleaseGate: "passed", ...result }, null, 2));
} catch (error) {
  console.error(`Hardware release gate failed: ${error?.message ?? error}`);
  process.exitCode = 1;
}
