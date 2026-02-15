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

	async write(ino: Ino, offset: number, data: Buffer): Promise<number> {
		const node = this.#nodes.get(ino);
		if (!node || node.kind !== "file") return 0;

		const end = offset + data.length;
		if (end > node.content.length) {
			const expanded = Buffer.alloc(end);
			node.content.copy(expanded);
			node.content = expanded;
		}
		data.copy(node.content, offset);
		return data.length;
	}

	async create(parent: Ino, name: string, mode: number): Promise<FileAttr | null> {
		const parentPath = this.#inodes.getPath(parent);
		if (!parentPath) return null;

		const childPath = parentPath === "/" ? `/${name}` : `${parentPath}/${name}`;
		const ino = this.#inodes.getOrAssign(childPath);
		this.#nodes.set(ino, { kind: "file", content: Buffer.alloc(0), mode });
		return { ino, size: 0, kind: "file", mode };
	}

	async mkdir(parent: Ino, name: string, mode: number): Promise<FileAttr | null> {
		const parentPath = this.#inodes.getPath(parent);
		if (!parentPath) return null;

		const childPath = parentPath === "/" ? `/${name}` : `${parentPath}/${name}`;
		const ino = this.#inodes.getOrAssign(childPath);
		this.#nodes.set(ino, { kind: "directory", mode });
		return { ino, size: 0, kind: "directory", mode };
	}

	async unlink(parent: Ino, name: string): Promise<boolean> {
		const parentPath = this.#inodes.getPath(parent);
		if (!parentPath) return false;

		const childPath = parentPath === "/" ? `/${name}` : `${parentPath}/${name}`;
		const ino = this.#inodes.getIno(childPath);
		if (ino === undefined) return false;

		this.#nodes.delete(ino);
		this.#inodes.remove(childPath);
		return true;
	}

	async rmdir(parent: Ino, name: string): Promise<boolean> {
		const parentPath = this.#inodes.getPath(parent);
		if (!parentPath) return false;

		const childPath = parentPath === "/" ? `/${name}` : `${parentPath}/${name}`;
		const ino = this.#inodes.getIno(childPath);
		if (ino === undefined) return false;

		const node = this.#nodes.get(ino);
		if (!node || node.kind !== "directory") return false;

		// Check for children
		const prefix = `${childPath}/`;
		for (const childIno of this.#nodes.keys()) {
			const p = this.#inodes.getPath(childIno);
			if (p?.startsWith(prefix)) return false;
		}

		this.#nodes.delete(ino);
		this.#inodes.remove(childPath);
		return true;
	}

	async rename(parent: Ino, name: string, newparent: Ino, newname: string): Promise<boolean> {
		const parentPath = this.#inodes.getPath(parent);
		if (!parentPath) return false;

		const oldPath = parentPath === "/" ? `/${name}` : `${parentPath}/${name}`;
		const ino = this.#inodes.getIno(oldPath);
		if (ino === undefined) return false;

		const newparentPath = this.#inodes.getPath(newparent);
		if (!newparentPath) return false;

		const newPath = newparentPath === "/" ? `/${newname}` : `${newparentPath}/${newname}`;

		this.#inodes.remove(oldPath);
		this.#inodes.assign(newPath, ino);
		return true;
	}

	async truncate(ino: Ino, size: number): Promise<FileAttr | null> {
		const node = this.#nodes.get(ino);
		if (!node || node.kind !== "file") return null;

		if (size < node.content.length) {
			node.content = node.content.subarray(0, size) as Buffer;
		} else if (size > node.content.length) {
			const expanded = Buffer.alloc(size);
			node.content.copy(expanded);
			node.content = expanded;
		}

		return { ino, size: node.content.length, kind: "file", mode: node.mode };
	}

	async symlink(parent: Ino, name: string, target: string): Promise<FileAttr | null> {
		const parentPath = this.#inodes.getPath(parent);
		if (!parentPath) return null;

		const childPath = parentPath === "/" ? `/${name}` : `${parentPath}/${name}`;
		const ino = this.#inodes.getOrAssign(childPath);
		this.#nodes.set(ino, { kind: "symlink", target });
		return { ino, size: 0, kind: "symlink" };
	}

	#getAttr(ino: Ino): FileAttr | null {
		const node = this.#nodes.get(ino);
		if (!node) return null;

		const size = node.kind === "file" ? node.content.length : 0;
		const mode = "mode" in node ? node.mode : undefined;
		return { ino, size, kind: node.kind, mode };
	}
}
