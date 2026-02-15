/**
 * In-memory VirtualFS implementation.
 *
 * Useful for testing and as a reference for implementing VirtualFS.
 * Supports files, directories, and symlinks.
 */

import { InodeMap } from "./inode-map";
import { type DirEntry, type FileAttr, type Ino, ROOT_INO, type VirtualFS } from "./types";

interface FileNode {
	kind: "file";
	content: Buffer;
	mode?: number;
}

interface DirNode {
	kind: "directory";
	mode?: number;
}

interface SymlinkNode {
	kind: "symlink";
	target: string;
}

type FsNode = FileNode | DirNode | SymlinkNode;

export class MemoryFS implements VirtualFS {
	readonly name: string;
	#inodes = new InodeMap();
	#nodes = new Map<Ino, FsNode>();

	constructor(name = "memory") {
		this.name = name;
		// Create root directory
		this.#nodes.set(ROOT_INO, { kind: "directory" });
	}

	/** Add a file at the given path. */
	addFile(filePath: string, content: string | Buffer, mode?: number): Ino {
		this.#ensureParentDirs(filePath);
		const ino = this.#inodes.getOrAssign(filePath);
		const buf = typeof content === "string" ? Buffer.from(content) : content;
		this.#nodes.set(ino, { kind: "file", content: buf, mode });
		return ino;
	}

	/** Add a directory at the given path. */
	addDirectory(dirPath: string, mode?: number): Ino {
		this.#ensureParentDirs(dirPath);
		const ino = this.#inodes.getOrAssign(dirPath);
		if (!this.#nodes.has(ino)) {
			this.#nodes.set(ino, { kind: "directory", mode });
		}
		return ino;
	}

	/** Add a symlink at the given path. */
	addSymlink(linkPath: string, target: string): Ino {
		this.#ensureParentDirs(linkPath);
		const ino = this.#inodes.getOrAssign(linkPath);
		this.#nodes.set(ino, { kind: "symlink", target });
		return ino;
	}

	/** Ensure all parent directories exist. */
	#ensureParentDirs(filePath: string): void {
		const parts = filePath.split("/").filter(Boolean);
		let current = "";
		for (let i = 0; i < parts.length - 1; i++) {
			current += `/${parts[i]}`;
			const ino = this.#inodes.getOrAssign(current);
			if (!this.#nodes.has(ino)) {
				this.#nodes.set(ino, { kind: "directory" });
			}
		}
	}

	// === VirtualFS implementation ===

	async lookup(parent: Ino, name: string): Promise<FileAttr | null> {
		const parentPath = this.#inodes.getPath(parent);
		if (!parentPath) return null;

		const childPath = parentPath === "/" ? `/${name}` : `${parentPath}/${name}`;
		const ino = this.#inodes.getIno(childPath);
		if (ino === undefined) return null;

		return this.#getAttr(ino);
	}

	async getattr(ino: Ino): Promise<FileAttr | null> {
		return this.#getAttr(ino);
	}

	async readdir(ino: Ino, offset: number): Promise<DirEntry[]> {
		const dirPath = this.#inodes.getPath(ino);
		if (!dirPath) return [];

		const prefix = dirPath === "/" ? "/" : `${dirPath}/`;
		const result: DirEntry[] = [
			{ name: ".", ino, kind: "directory" },
			{ name: "..", ino: ROOT_INO, kind: "directory" },
		];

		// Find direct children
		for (const [childIno, node] of this.#nodes) {
			const childPath = this.#inodes.getPath(childIno);
			if (!childPath || childPath === dirPath) continue;

			// Must be a direct child: starts with prefix, no more slashes
			if (!childPath.startsWith(prefix)) continue;
			const remaining = childPath.slice(prefix.length);
			if (remaining.includes("/")) continue;

			result.push({
				name: remaining,
				ino: childIno,
				kind: node.kind,
			});
		}

		return result.slice(offset);
	}

	async read(ino: Ino, offset: number, size: number): Promise<Buffer> {
		const node = this.#nodes.get(ino);
		if (!node || node.kind !== "file") return Buffer.alloc(0);
		return node.content.subarray(offset, offset + size) as Buffer;
	}

	async readlink(ino: Ino): Promise<string | null> {
		const node = this.#nodes.get(ino);
		if (!node || node.kind !== "symlink") return null;
		return node.target;
	}

	#getAttr(ino: Ino): FileAttr | null {
		const node = this.#nodes.get(ino);
		if (!node) return null;

		const size = node.kind === "file" ? node.content.length : 0;
		const mode = "mode" in node ? node.mode : undefined;
		return { ino, size, kind: node.kind, mode };
	}
}
