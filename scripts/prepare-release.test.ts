import { describe, expect, test } from "bun:test";
import {
  parseManifestVersion,
  parsePackageVersion,
  replaceManifestVersion,
  replacePackageVersion,
  resolveNextVersion,
} from "./prepare-release";

const PACKAGE_JSON = `{
  "name": "herdr-gui",
  "private": true,
  "version": "0.4.1",
  "scripts": {
    "test": "bun test"
  }
}
`;

const PLUGIN_MANIFEST = `id = "herdr.studio"
name = "Herdr Studio"
version = "0.4.1"
min_herdr_version = "0.7.2"
`;

describe("parsePackageVersion", () => {
  test("reads the top-level version", () => {
    expect(parsePackageVersion(PACKAGE_JSON)).toBe("0.4.1");
  });

  test("rejects package.json without a version", () => {
    expect(() => parsePackageVersion(`{ "name": "x" }`)).toThrow("version");
  });
});

describe("replacePackageVersion", () => {
  test("replaces only the version line and preserves the rest", () => {
    const next = replacePackageVersion(PACKAGE_JSON, "0.4.1", "0.4.2");
    expect(parsePackageVersion(next)).toBe("0.4.2");
    expect(next).toBe(
      PACKAGE_JSON.replace('"version": "0.4.1"', '"version": "0.4.2"'),
    );
  });

  test("rejects an unexpected current version", () => {
    expect(() => replacePackageVersion(PACKAGE_JSON, "9.9.9", "0.4.2")).toThrow(
      "expected",
    );
  });
});

describe("parseManifestVersion", () => {
  test("reads the top-level version", () => {
    expect(parseManifestVersion(PLUGIN_MANIFEST)).toBe("0.4.1");
  });

  test("rejects a manifest without a version", () => {
    expect(() => parseManifestVersion(`id = "x"`)).toThrow("version");
  });

  test("tolerates leading whitespace like the package version parser", () => {
    const indented = PLUGIN_MANIFEST.replace(
      'version = "0.4.1"',
      '  version = "0.4.1"',
    );
    expect(parseManifestVersion(indented)).toBe("0.4.1");
    expect(
      parseManifestVersion(replaceManifestVersion(indented, "0.4.1", "0.4.2")),
    ).toBe("0.4.2");
  });
});

describe("replaceManifestVersion", () => {
  test("replaces only the version line and preserves the rest", () => {
    const next = replaceManifestVersion(PLUGIN_MANIFEST, "0.4.1", "0.4.2");
    expect(parseManifestVersion(next)).toBe("0.4.2");
    expect(next).toBe(
      PLUGIN_MANIFEST.replace('version = "0.4.1"', 'version = "0.4.2"'),
    );
  });

  test("rejects an unexpected current version", () => {
    expect(() =>
      replaceManifestVersion(PLUGIN_MANIFEST, "9.9.9", "0.4.2"),
    ).toThrow("expected");
  });
});

describe("resolveNextVersion", () => {
  test("supports patch, minor, and major keywords", () => {
    expect(resolveNextVersion("0.4.1", "patch")).toBe("0.4.2");
    expect(resolveNextVersion("0.4.1", "minor")).toBe("0.5.0");
    expect(resolveNextVersion("0.4.1", "major")).toBe("1.0.0");
  });

  test("accepts an explicit version greater than the current one", () => {
    expect(resolveNextVersion("0.4.1", "0.4.10")).toBe("0.4.10");
    expect(resolveNextVersion("0.4.1", "0.5.0")).toBe("0.5.0");
  });

  test("rejects versions that are not greater than the current one", () => {
    expect(() => resolveNextVersion("0.4.1", "0.4.1")).toThrow("greater");
    expect(() => resolveNextVersion("0.4.1", "0.3.9")).toThrow("greater");
    expect(() => resolveNextVersion("0.4.1", "0.4.0")).toThrow("greater");
  });

  test("rejects malformed input", () => {
    expect(() => resolveNextVersion("0.4.1", "0.4")).toThrow("X.Y.Z");
    expect(() => resolveNextVersion("0.4.1", "next")).toThrow("X.Y.Z");
    expect(() => resolveNextVersion("0.4.1", "")).toThrow("X.Y.Z");
    expect(() => resolveNextVersion("0.4", "patch")).toThrow("X.Y.Z");
  });
});
