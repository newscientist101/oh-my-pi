import { describe, expect, test } from "bun:test";
import { InodeMap } from "../src/inode-map";
import { ROOT_INO } from "../src/types";

describe("InodeMap", () => {
	test("root is always inode 1", () => {
		const map = new InodeMap();
		expect(map.getIno("/")).toBe(ROOT_INO);
		expect(map.getPath(ROOT_INO)).toBe("/");
	});

	test("getOrAssign returns stable inodes", () => {
		const map = new InodeMap();
		const ino1 = map.getOrAssign("/foo");
		const ino2 = map.getOrAssign("/foo");
		expect(ino1).toBe(ino2);
		expect(ino1).not.toBe(ROOT_INO);
	});

	test("different paths get different inodes", () => {
		const map = new InodeMap();
		const a = map.getOrAssign("/a");
		const b = map.getOrAssign("/b");
		expect(a).not.toBe(b);
	});

	test("normalizes trailing slashes", () => {
		const map = new InodeMap();
		const ino1 = map.getOrAssign("/foo/");
		const ino2 = map.getOrAssign("/foo");
		expect(ino1).toBe(ino2);
	});

	test("normalizes missing leading slash", () => {
		const map = new InodeMap();
		const ino1 = map.getOrAssign("foo");
		const ino2 = map.getOrAssign("/foo");
		expect(ino1).toBe(ino2);
	});

	test("bidirectional lookup", () => {
		const map = new InodeMap();
		const ino = map.getOrAssign("/test/path");
		expect(map.getPath(ino)).toBe("/test/path");
		expect(map.getIno("/test/path")).toBe(ino);
	});

	test("remove works", () => {
		const map = new InodeMap();
		const ino = map.getOrAssign("/to-remove");
		map.remove("/to-remove");
		expect(map.getIno("/to-remove")).toBeUndefined();
		expect(map.getPath(ino)).toBeUndefined();
	});

	test("clear preserves root", () => {
		const map = new InodeMap();
		map.getOrAssign("/foo");
		map.getOrAssign("/bar");
		map.clear();
		expect(map.size).toBe(1);
		expect(map.getIno("/")).toBe(ROOT_INO);
		expect(map.getIno("/foo")).toBeUndefined();
	});
});
