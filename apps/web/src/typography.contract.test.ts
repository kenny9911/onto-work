import { readFileSync, readdirSync } from "node:fs";
import { extname, join } from "node:path";
import { describe, expect, it } from "vitest";

const sourceRoot = join(process.cwd(), "src");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return [".ts", ".tsx"].includes(extname(entry.name)) && !entry.name.includes(".test.")
      ? [path]
      : [];
  });
}

describe("typography contract", () => {
  it("uses the font pairing from the Claude Design source", () => {
    const entry = readFileSync(join(sourceRoot, "main.tsx"), "utf8");
    const styles = readFileSync(join(sourceRoot, "styles.css"), "utf8");

    expect(entry).toContain('import "@fontsource-variable/geist";');
    expect(entry).toContain('import "@fontsource-variable/jetbrains-mono";');
    expect(entry).not.toContain("geist-mono");
    expect(styles).toContain('"Geist", "Noto Sans SC"');
    expect(styles).toContain('"JetBrains Mono Variable", "JetBrains Mono"');
  });

  it("centralizes compact sizes instead of hiding readable text below 12px", () => {
    const violations = [join(sourceRoot, "App.tsx"), ...sourceFiles(join(sourceRoot, "components"))]
      .flatMap((path) => {
        const source = readFileSync(path, "utf8");
        return [...source.matchAll(/\btext-\[(\d*\.?\d+)(px|rem)\]/g)]
          .filter((match) => {
            const value = Number(match[1]);
            return match[2] === "px" ? value < 12 : value * 16 < 12;
          })
          .map((match) => `${path.slice(sourceRoot.length)}: ${match[0]}`);
      });

    expect(violations).toEqual([]);
  });

  it("defines semantic roles for telemetry, controls, prose, and titles", () => {
    const styles = readFileSync(join(sourceRoot, "styles.css"), "utf8");

    for (const token of ["micro", "meta", "code", "control", "body", "title", "display"]) {
      expect(styles).toContain(`--text-ui-${token}:`);
      expect(styles).toContain(`--text-ui-${token}--line-height:`);
    }
  });
});
