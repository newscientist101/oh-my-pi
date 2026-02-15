/**
 * Bidirectional mapping between filesystem paths and inode numbers.
 *
 * VirtualFS implementations use this to assign stable inode numbers
 * to paths. The root directory ("/") is always inode 1.
 */

import { type Ino, ROOT_INO } from "./types";

export class InodeMap {
	#pathToIno = new Map<string, Ino>();
	#inoToPath = new Map<Ino, string>();
	#nextIno: Ino = ROOT_INO + 1;

	constructor() {
		// Root is always inode 1
		this.#pathToIno.set("/", ROOT_INO);
		this.#inoToPath.set(ROOT_INO, "/");
	}

	/**
	 * Get or assign an inode number for the given path.
	 * If the path already has an inode, return it. Otherwise assign a new one.
	 */
	getOrAssign(path: string): Ino {
		const normalized = normalizePath(path);
		const existing = this.#pathToIno.get(normalized);
		if (existing !== undefined) return existing;

		const ino = this.#nextIno++;
		this.#pathToIno.set(normalized, ino);
		this.#inoToPath.set(ino, normalized);
		return ino;
	}

	/** Assign a specific inode number to a path (used for renames). */
	assign(path: string, ino: Ino): void {
		const normalized = normalizePath(path);
		this.#pathToIno.set(normalized, ino);
		this.#inoToPath.set(ino, normalized);
	}

	/** Look up an inode by path. Returns undefined if not mapped. */
	getIno(path: string): Ino | undefined {
		return this.#pathToIno.get(normalizePath(path));
	}

	/** Look up a path by inode. Returns undefined if not mapped. */
	getPath(ino: Ino): string | undefined {
		return this.#inoToPath.get(ino);
	}

	/** Remove a mapping. */
	remove(path: string): void {
		const normalized = normalizePath(path);
		const ino = this.#pathToIno.get(normalized);
		if (ino !== undefined) {
			this.#pathToIno.delete(normalized);
			this.#inoToPath.delete(ino);
		}
	}

	/** Clear all mappings except root. */
	clear(): void {
		this.#pathToIno.clear();
		this.#inoToPath.clear();
		this.#nextIno = ROOT_INO + 1;
		this.#pathToIno.set("/", ROOT_INO);
		this.#inoToPath.set(ROOT_INO, "/");
	}

	/** Number of mapped entries. */
	get size(): number {
		return this.#pathToIno.size;
	}
}

/** Normalize a path: ensure leading slash, remove trailing slash (except root). */
function normalizePath(p: string): string {
	let normalized = p.startsWith("/") ? p : `/${p}`;
	if (normalized.length > 1 && normalized.endsWith("/")) {
		normalized = normalized.slice(0, -1);
	}
	return normalized;
}
