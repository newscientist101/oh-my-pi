/**
 * Composite filesystem that mounts multiple VirtualFS implementations
 * under a single FUSE mount point.
 *
 * Each child filesystem is mounted at a top-level directory:
 *   /git/     -> GitFS
 *   /tasks/   -> TaskFS
 *   /sessions/ -> SessionFS
 *
 * The composite handles root-level readdir/lookup and delegates
 * all other operations to the appropriate child.
 */

import * as path from "node:path";
import { InodeMap } from "./inode-map";
import { type DirEntry, type FileAttr, type Ino, ROOT_INO, type VirtualFS } from "./types";

interface MountEntry {
	/** Directory name at root level (e.g. "git"). */
	name: string;
	/** The child filesystem. */
	fs: VirtualFS;
	/** Inode number assigned to this mount's root directory. */
	rootIno: Ino;
}

/**
 * Create a composite VFS that mounts child filesystems at top-level paths.
 *
 * @param mounts - Map of directory name to VirtualFS (e.g. { git: gitFs, tasks: taskFs })
 */
export function createCompositeFS(mounts: Record<string, VirtualFS>): VirtualFS {
	const inodes = new InodeMap();
	const entries: MountEntry[] = [];

	for (const [name, fs] of Object.entries(mounts)) {
		const rootIno = inodes.getOrAssign(`/${name}`);
		entries.push({ name, fs, rootIno });
	}

	/** Find which child owns this inode. */
	function resolve(ino: Ino): { entry: MountEntry; childIno: Ino } | null {
		// Check if it's a mount root
		for (const entry of entries) {
			if (ino === entry.rootIno) {
				return { entry, childIno: ROOT_INO };
			}
		}

		// Check path prefix
		const p = inodes.getPath(ino);
		if (!p) return null;

		for (const entry of entries) {
			const prefix = `/${entry.name}`;
			if (p === prefix || p.startsWith(`${prefix}/`)) {
				return { entry, childIno: ino };
			}
		}
		return null;
	}

	return {
		name: "composite",

		async lookup(parent: Ino, name: string): Promise<FileAttr | null> {
			if (parent === ROOT_INO) {
				// Looking up a mount point
				const entry = entries.find(e => e.name === name);
				if (!entry) return null;
				return { ino: entry.rootIno, size: 0, kind: "directory" };
			}

			const target = resolve(parent);
			if (!target) return null;

			const attr = await target.entry.fs.lookup(target.childIno, name);
			if (!attr) return null;

			// Map the child's inode into our global namespace
			const parentPath = inodes.getPath(parent) ?? "/";
			const childPath = path.join(parentPath, name);
			const globalIno = inodes.getOrAssign(childPath);

			return { ...attr, ino: globalIno };
		},

		async getattr(ino: Ino): Promise<FileAttr | null> {
			if (ino === ROOT_INO) {
				return { ino: ROOT_INO, size: 0, kind: "directory" };
			}

			// Check if it's a mount root
			const mountEntry = entries.find(e => e.rootIno === ino);
			if (mountEntry) {
				return { ino, size: 0, kind: "directory" };
			}

			const target = resolve(ino);
			if (!target) return null;

			const attr = await target.entry.fs.getattr(target.childIno);
			if (!attr) return null;
			return { ...attr, ino };
		},

		async readdir(ino: Ino, offset: number): Promise<DirEntry[]> {
			if (ino === ROOT_INO) {
				// List mount points
				const result: DirEntry[] = [
					{ name: ".", ino: ROOT_INO, kind: "directory" },
					{ name: "..", ino: ROOT_INO, kind: "directory" },
					...entries.map(e => ({
						name: e.name,
						ino: e.rootIno,
						kind: "directory" as const,
					})),
				];
				return result.slice(offset);
			}

			const target = resolve(ino);
			if (!target) return [];

			const childEntries = await target.entry.fs.readdir(target.childIno, offset);

			// Remap child inodes to global namespace
			const parentPath = inodes.getPath(ino) ?? "/";
			return childEntries.map(e => {
				if (e.name === "." || e.name === "..") return e;
				const childPath = path.join(parentPath, e.name);
				const globalIno = inodes.getOrAssign(childPath);
				return { ...e, ino: globalIno };
			});
		},

		async read(ino: Ino, offset: number, size: number): Promise<Buffer> {
			const target = resolve(ino);
			if (!target) return Buffer.alloc(0);
			return target.entry.fs.read(target.childIno, offset, size);
		},

		async readlink(ino: Ino): Promise<string | null> {
			const target = resolve(ino);
			if (!target) return null;
			return target.entry.fs.readlink?.(target.childIno) ?? null;
		},

		async destroy(): Promise<void> {
			await Promise.all(entries.map(e => e.fs.destroy?.()));
		},
	};
}
