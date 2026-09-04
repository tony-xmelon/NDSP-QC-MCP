import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function gitOutput(args) {
  return execFileSync("git", args, { cwd: repositoryRoot, encoding: "utf8" }).trim();
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function packageVersion(platform) {
  return JSON.parse(readFileSync(resolve(repositoryRoot, `apps/${platform}/package.json`), "utf8")).version;
}

export function releaseCandidateFileName(platform, version) {
  if (platform === "android") return `QC-Control-Android-${version}-debug.apk`;
  if (platform === "windows") return `QC-Control-Windows-${version}-x64-setup.exe`;
  throw new Error(`Unsupported release platform: ${platform}`);
}

function candidatePath(platform) {
  return resolve(repositoryRoot, "artifacts", platform, releaseCandidateFileName(platform, packageVersion(platform)));
}

function metadataPath(artifactPath) {
  return `${artifactPath}.source.json`;
}

export function candidateMetadataMatches(metadata, expected) {
  return metadata?.schemaVersion === 1
    && metadata.platform === expected.platform
    && metadata.sourceCommit === expected.sourceCommit
    && metadata.sourceDirty === false
    && metadata.size === expected.size
    && metadata.sha256 === expected.sha256;
}

export function stageReleaseCandidate(platform, source) {
  const sourcePath = resolve(source);
  if (!existsSync(sourcePath)) throw new Error(`Release artifact does not exist: ${sourcePath}`);
  const sourceCommit = gitOutput(["rev-parse", "HEAD"]);
  const sourceDirty = Boolean(gitOutput(["status", "--porcelain"]));
  if (sourceDirty) throw new Error("Release candidates can only be staged from a clean Git worktree.");
  const targetPath = candidatePath(platform);
  mkdirSync(dirname(targetPath), { recursive: true });
  if (sourcePath.toLowerCase() !== targetPath.toLowerCase()) copyFileSync(sourcePath, targetPath);
  const metadata = {
    schemaVersion: 1,
    platform,
    sourceCommit,
    sourceDirty,
    size: statSync(targetPath).size,
    sha256: sha256File(targetPath)
  };
  writeFileSync(metadataPath(targetPath), `${JSON.stringify(metadata, null, 2)}\n`);
  return targetPath;
}

export function currentReleaseCandidates() {
  const sourceCommit = gitOutput(["rev-parse", "HEAD"]);
  if (gitOutput(["status", "--porcelain"])) return [];
  return ["windows", "android"].flatMap((platform) => {
    const artifactPath = candidatePath(platform);
    const sourcePath = metadataPath(artifactPath);
    if (!existsSync(artifactPath) || !existsSync(sourcePath)) return [];
    const expected = {
      platform,
      sourceCommit,
      size: statSync(artifactPath).size,
      sha256: sha256File(artifactPath)
    };
    try {
      const metadata = JSON.parse(readFileSync(sourcePath, "utf8"));
      return candidateMetadataMatches(metadata, expected) ? [artifactPath] : [];
    } catch {
      return [];
    }
  });
}

function usage() {
  throw new Error("Usage: node tools/release-candidates.mjs stage <windows|android> <artifact> | list");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [command, platform, source] = process.argv.slice(2);
  if (command === "stage" && platform && source) {
    console.log(stageReleaseCandidate(platform, source));
  } else if (command === "list" && !platform && !source) {
    for (const artifact of currentReleaseCandidates()) console.log(artifact);
  } else {
    usage();
  }
}
