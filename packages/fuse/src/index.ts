/**
 * @oh-my-pi/pi-fuse - Virtual filesystem layer using FUSE.
 *
 * Provides a TypeScript interface for creating virtual filesystems that
 * are mounted via FUSE and accessible to agents as regular directories.
 *
 * Architecture:
 *   TypeScript (VirtualFS impl) <-> JSON-RPC <-> pi-fuse (Rust binary) <-> kernel FUSE
 *
 * Usage:
 *   const fs = new MemoryFS("demo");
 *   fs.addFile("/hello.txt", "Hello, world!");
 *   const mnt = await mount(fs, "/tmp/my-mount");
 *   // ... agent can now: cat /tmp/my-mount/hello.txt
 *   await mnt.unmount();
 */

export { createCompositeFS } from "./composite-fs";
export { GitFS } from "./git-fs";
export { InodeMap } from "./inode-map";
export { MemoryFS } from "./memory-fs";
export type { FuseMount, MountOptions } from "./mount";
export { mount } from "./mount";
export type {
	DirEntry,
	FileAttr,
	FileKind,
	FuseEvent,
	FuseRequest,
	FuseResponse,
	Ino,
	VirtualFS,
} from "./types";
export { ROOT_INO } from "./types";
