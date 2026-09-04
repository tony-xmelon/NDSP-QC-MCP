import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoots = ["packages/typescript", "apps/android/src", "apps/windows/src"];
const internalPackageName = {
  "qc-client": "@ndsp-qc/client",
  "qc-core": "@ndsp-qc/core",
  "qc-form-factors": "@ndsp-qc/form-factors",
  "qc-ui": "@ndsp-qc/ui"
};
const allowedInternalImports = {
  "@ndsp-qc/client": new Set(),
  "@ndsp-qc/core": new Set(["@ndsp-qc/client"]),
  "@ndsp-qc/form-factors": new Set(),
  "@ndsp-qc/ui": new Set(["@ndsp-qc/client", "@ndsp-qc/core", "@ndsp-qc/form-factors"])
};

function sourceFiles(directory) {
  return readdirSync(directory).flatMap((entry) => {
    const path = resolve(directory, entry);
    return statSync(path).isDirectory() ? sourceFiles(path) : /\.[cm]?[jt]sx?$/.test(entry) ? [path] : [];
  });
}

export function importedSpecifiers(source) {
  const specifiers = [];
  const staticImport = /(?:import|export)\s+(?:type\s+)?(?:[^"'`]*?\s+from\s*)?["']([^"']+)["']/g;
  const dynamicImport = /\bimport\(\s*["']([^"']+)["']\s*\)/g;
  for (const expression of [staticImport, dynamicImport]) {
    for (const match of source.matchAll(expression)) specifiers.push(match[1]);
  }
  return specifiers;
}

function sharedPackageFor(file) {
  const path = relative(repositoryRoot, file).split(sep);
  return path[0] === "packages" && path[1] === "typescript" ? internalPackageName[path[2]] : undefined;
}

function internalPackageFor(specifier) {
  return Object.values(internalPackageName).find((name) => specifier === name || specifier.startsWith(`${name}/`));
}

export function boundaryViolations(file, specifier) {
  const normalizedFile = relative(repositoryRoot, file).replaceAll("\\", "/");
  const failures = [];
  const sharedPackage = sharedPackageFor(file);
  const importedInternal = internalPackageFor(specifier);

  if (specifier.includes("/src/") && importedInternal) failures.push("imports another workspace package through its private src directory");
  if (sharedPackage && (/^@(?:capacitor|tauri-apps)\//.test(specifier) || specifier.includes("src-tauri") || specifier.includes("android/app"))) {
    failures.push("shared packages cannot depend on a native host API");
  }
  if (sharedPackage && importedInternal && importedInternal !== sharedPackage && !allowedInternalImports[sharedPackage]?.has(importedInternal)) {
    failures.push(`${sharedPackage} cannot depend on ${importedInternal}`);
  }

  const resolvedImport = specifier.startsWith(".") ? resolve(dirname(file), specifier).replaceAll("\\", "/") : "";
  if (normalizedFile.startsWith("apps/android/src/") && (specifier.startsWith("@ndsp-qc/windows") || resolvedImport.includes("/apps/windows/"))) {
    failures.push("Android cannot import the Windows application");
  }
  if (normalizedFile.startsWith("apps/windows/src/") && (specifier.startsWith("@ndsp-qc/android") || resolvedImport.includes("/apps/android/"))) {
    failures.push("Windows cannot import the Android application");
  }
  return failures;
}

export function verifyPackageBoundaries() {
  const violations = [];
  for (const root of sourceRoots) {
    for (const file of sourceFiles(resolve(repositoryRoot, root))) {
      const source = readFileSync(file, "utf8");
      for (const specifier of importedSpecifiers(source)) {
        for (const reason of boundaryViolations(file, specifier)) {
          violations.push(`${relative(repositoryRoot, file)}: ${reason}: ${specifier}`);
        }
      }
    }
  }
  return violations;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const violations = verifyPackageBoundaries();
  if (violations.length) {
    console.error(`Package boundary check failed:\n${violations.map((item) => `- ${item}`).join("\n")}`);
    process.exitCode = 1;
  } else {
    console.log("Package boundaries verified: shared packages are platform-neutral and app composition roots are isolated.");
  }
}
