/**
 * Tests for GitFS.
 *
 * Creates a temporary git repo with known content and verifies that
 * GitFS exposes it correctly through the VirtualFS interface.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";
import { GitFS } from "../src/git-fs";
import { ROOT_INO } from "../src/types";

let tmpDir: string;
let gitFs: GitFS;

beforeAll(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "git-fs-test-"));

	// Initialize a git repo with some content
	await $`git init ${tmpDir}`.quiet();
	await $`git -C ${tmpDir} config user.email test@test.com`.quiet();
	await $`git -C ${tmpDir} config user.name Test`.quiet();

	// Create files on main branch
	await Bun.write(path.join(tmpDir, "README.md"), "# Hello\n");
	await fs.mkdir(path.join(tmpDir, "src"), { recursive: true });
	await Bun.write(path.join(tmpDir, "src/index.ts"), "console.log('hello');\n");
	await Bun.write(path.join(tmpDir, "src/util.ts"), "export const x = 1;\n");

	await $`git -C ${tmpDir} add -A`.quiet();
	await $`git -C ${tmpDir} commit -m "initial"`.quiet();

	// Create a tag
	await $`git -C ${tmpDir} tag v1.0.0`.quiet();

	// Create a feature branch with an extra file
	await $`git -C ${tmpDir} checkout -b feature`.quiet();
	await Bun.write(path.join(tmpDir, "src/feature.ts"), "export const f = true;\n");
	await $`git -C ${tmpDir} add -A`.quiet();
	await $`git -C ${tmpDir} commit -m "add feature"`.quiet();

	// Go back to main
	await $`git -C ${tmpDir} checkout main`.quiet();

	gitFs = new GitFS(tmpDir);
});

afterAll(async () => {
	await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("GitFS", () => {
	test("root readdir returns structural entries", async () => {
		const entries = await gitFs.readdir(ROOT_INO, 0);
		const names = entries.map(e => e.name);
		expect(names).toContain(".");
		expect(names).toContain("..");
		expect(names).toContain("HEAD");
		expect(names).toContain("branches");
		expect(names).toContain("tags");
		expect(names).toContain("commits");
	});

	test("root getattr returns directory", async () => {
		const attr = await gitFs.getattr(ROOT_INO);
		expect(attr).not.toBeNull();
		expect(attr!.kind).toBe("directory");
	});

	test("HEAD is a symlink", async () => {
		const attr = await gitFs.lookup(ROOT_INO, "HEAD");
		expect(attr).not.toBeNull();
		expect(attr!.kind).toBe("symlink");
	});

	test("HEAD symlink points to current branch", async () => {
		const attr = await gitFs.lookup(ROOT_INO, "HEAD");
		expect(attr).not.toBeNull();
		const target = await gitFs.readlink(attr!.ino);
		expect(target).toBe("branches/main");
	});

	test("branches directory lists branches", async () => {
		const branchesAttr = await gitFs.lookup(ROOT_INO, "branches");
		expect(branchesAttr).not.toBeNull();

		const entries = await gitFs.readdir(branchesAttr!.ino, 0);
		const names = entries.map(e => e.name).filter(n => n !== "." && n !== "..");
		expect(names).toContain("main");
		expect(names).toContain("feature");
	});

	test("tags directory lists tags", async () => {
		const tagsAttr = await gitFs.lookup(ROOT_INO, "tags");
		expect(tagsAttr).not.toBeNull();

		const entries = await gitFs.readdir(tagsAttr!.ino, 0);
		const names = entries.map(e => e.name).filter(n => n !== "." && n !== "..");
		expect(names).toContain("v1.0.0");
	});

	test("commits directory is empty (virtual, lookup-only)", async () => {
		const commitsAttr = await gitFs.lookup(ROOT_INO, "commits");
		expect(commitsAttr).not.toBeNull();

		const entries = await gitFs.readdir(commitsAttr!.ino, 0);
		const names = entries.map(e => e.name).filter(n => n !== "." && n !== "..");
		expect(names).toHaveLength(0);
	});

	test("lookup branch resolves to directory", async () => {
		const branchesAttr = await gitFs.lookup(ROOT_INO, "branches");
		const mainAttr = await gitFs.lookup(branchesAttr!.ino, "main");
		expect(mainAttr).not.toBeNull();
		expect(mainAttr!.kind).toBe("directory");
	});

	test("readdir on branch shows files", async () => {
		const branchesAttr = await gitFs.lookup(ROOT_INO, "branches");
		const mainAttr = await gitFs.lookup(branchesAttr!.ino, "main");

		const entries = await gitFs.readdir(mainAttr!.ino, 0);
		const names = entries.map(e => e.name).filter(n => n !== "." && n !== "..");
		expect(names).toContain("README.md");
		expect(names).toContain("src");
	});

	test("lookup and read a file in a branch", async () => {
		const branchesAttr = await gitFs.lookup(ROOT_INO, "branches");
		const mainAttr = await gitFs.lookup(branchesAttr!.ino, "main");
		const readmeAttr = await gitFs.lookup(mainAttr!.ino, "README.md");

		expect(readmeAttr).not.toBeNull();
		expect(readmeAttr!.kind).toBe("file");

		const content = await gitFs.read(readmeAttr!.ino, 0, 4096);
		expect(content.toString()).toBe("# Hello\n");
	});

	test("nested directory traversal works", async () => {
		const branchesAttr = await gitFs.lookup(ROOT_INO, "branches");
		const mainAttr = await gitFs.lookup(branchesAttr!.ino, "main");
		const srcAttr = await gitFs.lookup(mainAttr!.ino, "src");

		expect(srcAttr).not.toBeNull();
		expect(srcAttr!.kind).toBe("directory");

		const entries = await gitFs.readdir(srcAttr!.ino, 0);
		const names = entries.map(e => e.name).filter(n => n !== "." && n !== "..");
		expect(names).toContain("index.ts");
		expect(names).toContain("util.ts");
		// feature.ts should NOT be on main
		expect(names).not.toContain("feature.ts");
	});

	test("feature branch has extra file", async () => {
		const branchesAttr = await gitFs.lookup(ROOT_INO, "branches");
		const featureAttr = await gitFs.lookup(branchesAttr!.ino, "feature");
		const srcAttr = await gitFs.lookup(featureAttr!.ino, "src");

		const entries = await gitFs.readdir(srcAttr!.ino, 0);
		const names = entries.map(e => e.name).filter(n => n !== "." && n !== "..");
		expect(names).toContain("feature.ts");
		expect(names).toContain("index.ts");
		expect(names).toContain("util.ts");
	});

	test("read file content from feature branch", async () => {
		const branchesAttr = await gitFs.lookup(ROOT_INO, "branches");
		const featureAttr = await gitFs.lookup(branchesAttr!.ino, "feature");
		const srcAttr = await gitFs.lookup(featureAttr!.ino, "src");
		const fileAttr = await gitFs.lookup(srcAttr!.ino, "feature.ts");

		expect(fileAttr).not.toBeNull();
		const content = await gitFs.read(fileAttr!.ino, 0, 4096);
		expect(content.toString()).toBe("export const f = true;\n");
	});

	test("tag resolves to correct tree", async () => {
		const tagsAttr = await gitFs.lookup(ROOT_INO, "tags");
		const tagAttr = await gitFs.lookup(tagsAttr!.ino, "v1.0.0");

		expect(tagAttr).not.toBeNull();
		expect(tagAttr!.kind).toBe("directory");

		// v1.0.0 was tagged on the initial commit (same as main)
		const entries = await gitFs.readdir(tagAttr!.ino, 0);
		const names = entries.map(e => e.name).filter(n => n !== "." && n !== "..");
		expect(names).toContain("README.md");
		expect(names).toContain("src");
	});

	test("commit lookup by SHA works", async () => {
		// Get the SHA of main's HEAD
		const result = await $`git -C ${tmpDir} rev-parse main`.quiet();
		const sha = result.text().trim();

		const commitsAttr = await gitFs.lookup(ROOT_INO, "commits");
		const commitAttr = await gitFs.lookup(commitsAttr!.ino, sha);

		expect(commitAttr).not.toBeNull();
		expect(commitAttr!.kind).toBe("directory");

		const entries = await gitFs.readdir(commitAttr!.ino, 0);
		const names = entries.map(e => e.name).filter(n => n !== "." && n !== "..");
		expect(names).toContain("README.md");
	});

	test("invalid commit SHA returns null", async () => {
		const commitsAttr = await gitFs.lookup(ROOT_INO, "commits");
		const attr = await gitFs.lookup(commitsAttr!.ino, "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef");
		expect(attr).toBeNull();
	});

	test("nonexistent branch returns null", async () => {
		const branchesAttr = await gitFs.lookup(ROOT_INO, "branches");
		const attr = await gitFs.lookup(branchesAttr!.ino, "nonexistent-branch");
		expect(attr).toBeNull();
	});

	test("nonexistent file in branch returns null", async () => {
		const branchesAttr = await gitFs.lookup(ROOT_INO, "branches");
		const mainAttr = await gitFs.lookup(branchesAttr!.ino, "main");
		const attr = await gitFs.lookup(mainAttr!.ino, "does-not-exist.txt");
		expect(attr).toBeNull();
	});

	test("partial read returns correct slice", async () => {
		const branchesAttr = await gitFs.lookup(ROOT_INO, "branches");
		const mainAttr = await gitFs.lookup(branchesAttr!.ino, "main");
		const readmeAttr = await gitFs.lookup(mainAttr!.ino, "README.md");

		// Read only "# He" (offset=0, size=4)
		const content = await gitFs.read(readmeAttr!.ino, 0, 4);
		expect(content.toString()).toBe("# He");

		// Read with offset
		const content2 = await gitFs.read(readmeAttr!.ino, 2, 3);
		expect(content2.toString()).toBe("Hel");
	});

	test("refresh clears ref caches", async () => {
		// Ensure we've looked up main
		const branchesAttr = await gitFs.lookup(ROOT_INO, "branches");
		await gitFs.lookup(branchesAttr!.ino, "main");

		// Refresh should not throw
		gitFs.refresh();

		// Should still work after refresh
		const mainAttr = await gitFs.lookup(branchesAttr!.ino, "main");
		expect(mainAttr).not.toBeNull();
	});

	test("getattr on known file inode works", async () => {
		const branchesAttr = await gitFs.lookup(ROOT_INO, "branches");
		const mainAttr = await gitFs.lookup(branchesAttr!.ino, "main");
		const readmeAttr = await gitFs.lookup(mainAttr!.ino, "README.md");

		const attr = await gitFs.getattr(readmeAttr!.ino);
		expect(attr).not.toBeNull();
		expect(attr!.kind).toBe("file");
		expect(attr!.mode).toBe(0o444);
	});

	test("readdir offset works", async () => {
		const allEntries = await gitFs.readdir(ROOT_INO, 0);
		const offsetEntries = await gitFs.readdir(ROOT_INO, 2);
		expect(offsetEntries).toEqual(allEntries.slice(2));
	});
});
