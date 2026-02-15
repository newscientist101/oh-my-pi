/**
 * Integration test: mounts a MemoryFS via FUSE and validates
 * that standard filesystem operations work through the mount.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { FuseMount } from "../src";
import { MemoryFS, mount } from "../src";

const MOUNT_POINT = path.join(os.tmpdir(), `pi-fuse-test-${process.pid}-${Date.now()}`);

let memfs: MemoryFS;
let fuseMnt: FuseMount;

beforeAll(async () => {
	memfs = new MemoryFS("test");
	memfs.addFile("/hello.txt", "Hello, FUSE!\n");
	memfs.addFile("/data/config.json", '{"key": "value"}\n');
	memfs.addDirectory("/empty-dir");
	memfs.addSymlink("/link", "/hello.txt");

	fuseMnt = await mount(memfs, MOUNT_POINT);
}, 15_000);

afterAll(async () => {
	await fuseMnt?.unmount();
	try {
		await fs.rmdir(MOUNT_POINT);
	} catch {
		// Ignore
	}
});

describe("MemoryFS via FUSE", () => {
	test("mount is active", () => {
		expect(fuseMnt.mounted).toBe(true);
	});

	test("read file", async () => {
		const content = await fs.readFile(path.join(MOUNT_POINT, "hello.txt"), "utf-8");
		expect(content).toBe("Hello, FUSE!\n");
	});

	test("read nested file", async () => {
		const content = await fs.readFile(path.join(MOUNT_POINT, "data", "config.json"), "utf-8");
		expect(content).toBe('{"key": "value"}\n');
	});

	test("readdir root", async () => {
		const entries = await fs.readdir(MOUNT_POINT);
		expect(entries).toContain("hello.txt");
		expect(entries).toContain("data");
		expect(entries).toContain("empty-dir");
		expect(entries).toContain("link");
	});

	test("readdir subdirectory", async () => {
		const entries = await fs.readdir(path.join(MOUNT_POINT, "data"));
		expect(entries).toContain("config.json");
	});

	test("readdir empty directory", async () => {
		const entries = await fs.readdir(path.join(MOUNT_POINT, "empty-dir"));
		expect(entries).toEqual([]);
	});

	test("stat file", async () => {
		const stat = await fs.stat(path.join(MOUNT_POINT, "hello.txt"));
		expect(stat.isFile()).toBe(true);
		expect(stat.size).toBe("Hello, FUSE!\n".length);
	});

	test("stat directory", async () => {
		const stat = await fs.stat(path.join(MOUNT_POINT, "data"));
		expect(stat.isDirectory()).toBe(true);
	});

	test("readlink", async () => {
		const target = await fs.readlink(path.join(MOUNT_POINT, "link"));
		expect(target).toBe("/hello.txt");
	});

	test("stat reports ENOENT for missing file", async () => {
		expect(fs.stat(path.join(MOUNT_POINT, "nonexistent"))).rejects.toMatchObject({
			code: "ENOENT",
		});
	});

	// === Write operations ===

	test("create and read file", async () => {
		const p = path.join(MOUNT_POINT, "created.txt");
		await fs.writeFile(p, "new content\n");
		const content = await fs.readFile(p, "utf-8");
		expect(content).toBe("new content\n");
	});

	test("write to existing file", async () => {
		const p = path.join(MOUNT_POINT, "hello.txt");
		await fs.writeFile(p, "overwritten\n");
		const content = await fs.readFile(p, "utf-8");
		expect(content).toBe("overwritten\n");
	});

	test("mkdir and readdir", async () => {
		const dir = path.join(MOUNT_POINT, "newdir");
		await fs.mkdir(dir);
		const stat = await fs.stat(dir);
		expect(stat.isDirectory()).toBe(true);
		const entries = await fs.readdir(dir);
		expect(entries).toEqual([]);
	});

	test("unlink file", async () => {
		const p = path.join(MOUNT_POINT, "to-delete.txt");
		await fs.writeFile(p, "delete me");
		await fs.unlink(p);
		expect(fs.stat(p)).rejects.toMatchObject({ code: "ENOENT" });
	});

	test("rmdir empty directory", async () => {
		const dir = path.join(MOUNT_POINT, "rmdir-test");
		await fs.mkdir(dir);
		await fs.rmdir(dir);
		expect(fs.stat(dir)).rejects.toMatchObject({ code: "ENOENT" });
	});

	test("rename file", async () => {
		const src = path.join(MOUNT_POINT, "rename-src.txt");
		const dst = path.join(MOUNT_POINT, "rename-dst.txt");
		await fs.writeFile(src, "rename me");
		await fs.rename(src, dst);
		expect(fs.stat(src)).rejects.toMatchObject({ code: "ENOENT" });
		const content = await fs.readFile(dst, "utf-8");
		expect(content).toBe("rename me");
	});

	test("create symlink via filesystem", async () => {
		const target = path.join(MOUNT_POINT, "hello.txt");
		const link = path.join(MOUNT_POINT, "new-link");
		await fs.symlink(target, link);
		const readTarget = await fs.readlink(link);
		expect(readTarget).toBe(target);
	});
});
