/**
 * Read-only VirtualFS that exposes a git repository as a browseable filesystem.
 *
 * Layout:
 *   /HEAD           -> symlink to current branch or commit
 *   /branches/
 *     main/
 *       src/index.ts
 *       package.json
 *     feature-x/
 *       ...
 *   /tags/
 *     v1.0.0/
 *       ...
 *   /commits/
 *     <sha>/         (virtual: no enumeration, lookup-only)
 *       ...
 *
 * All tree/blob resolution is lazy — only one tree level is resolved per readdir,
 * and blob content is fetched on demand. Git objects are cached by SHA (immutable,
 * naturally deduplicates across refs sharing the same files).
 */

import { $ } from "bun";
import { InodeMap } from "./inode-map";
import { type DirEntry, type FileAttr, type Ino, ROOT_INO, type VirtualFS } from "./types";

// =============================================================================
// Types
// =============================================================================

interface TreeEntry {
	mode: string;
	type: "blob" | "tree" | "commit";
	sha: string;
	name: string;
}

interface GitNode {
	kind: "file" | "directory" | "symlink";
	/** Git object SHA — used for lazy content resolution. */
	sha: string;
	/** Unix mode from git (for executable detection). */
	gitMode: string;
}

/** Sentinel directory nodes that aren't backed by a git tree object. */
interface VirtualDirNode {
	kind: "directory";
	sha: null;
	gitMode: "040000";
}

type FsNode = GitNode | VirtualDirNode;

// Virtual directory markers
const ROOT_NODE: VirtualDirNode = { kind: "directory", sha: null, gitMode: "040000" };
const VIRTUAL_DIR: VirtualDirNode = { kind: "directory", sha: null, gitMode: "040000" };

// =============================================================================
// GitFS
// =============================================================================

export class GitFS implements VirtualFS {
	readonly name: string;
	#repoPath: string;
	#inodes = new InodeMap();
	#nodes = new Map<Ino, FsNode>();

	/**
	 * Cache: git tree SHA -> parsed entries.
	 * Trees are immutable by SHA, so this never needs invalidation.
	 */
	#treeCache = new Map<string, TreeEntry[]>();

	/**
	 * Cache: git blob SHA -> content buffer.
	 * LRU-ish: we cap the cache size and evict oldest entries.
	 */
	#blobCache = new Map<string, Buffer>();
	static readonly MAX_BLOB_CACHE = 256;

	/** Cache: ref name -> resolved commit SHA. Cleared on refresh. */
	#refCache = new Map<string, string>();

	/** Cache: commit SHA -> tree SHA. */
	#commitTreeCache = new Map<string, string>();

	/** Resolved children for a directory inode (avoids repeated readdir work). */
	#childrenCache = new Map<Ino, DirEntry[]>();

	constructor(repoPath: string, name = "git") {
		this.name = name;
		this.#repoPath = repoPath;

		// Set up root and structural directories
		this.#nodes.set(ROOT_INO, ROOT_NODE);

		const branchesIno = this.#inodes.getOrAssign("/branches");
		this.#nodes.set(branchesIno, VIRTUAL_DIR);

		const tagsIno = this.#inodes.getOrAssign("/tags");
		this.#nodes.set(tagsIno, VIRTUAL_DIR);

		const commitsIno = this.#inodes.getOrAssign("/commits");
		this.#nodes.set(commitsIno, VIRTUAL_DIR);
	}

	// =========================================================================
	// VirtualFS implementation
	// =========================================================================

	async lookup(parent: Ino, name: string): Promise<FileAttr | null> {
		const parentPath = this.#inodes.getPath(parent);
		if (!parentPath) return null;

		const childPath = parentPath === "/" ? `/${name}` : `${parentPath}/${name}`;

		// HEAD symlink
		if (parent === ROOT_INO && name === "HEAD") {
			return this.#resolveHead();
		}

		// /branches/<name> — lazily resolve branch ref
		if (parentPath === "/branches") {
			return this.#resolveRef(childPath, `refs/heads/${name}`);
		}

		// /tags/<name> — lazily resolve tag ref
		if (parentPath === "/tags") {
			return this.#resolveRef(childPath, `refs/tags/${name}`);
		}

		// /commits/<sha> — resolve by commit SHA
		if (parentPath === "/commits") {
			return this.#resolveCommitDir(childPath, name);
		}

		// Nested path inside a ref tree — ensure parent is resolved, then find child
		await this.#ensureChildrenResolved(parent);

		const ino = this.#inodes.getIno(childPath);
		if (ino === undefined) return null;
		return this.#makeAttr(ino);
	}

	async getattr(ino: Ino): Promise<FileAttr | null> {
		if (ino === ROOT_INO) {
			return { ino: ROOT_INO, size: 0, kind: "directory", mode: 0o555 };
		}

		// HEAD is special — it's a symlink
		const headIno = this.#inodes.getIno("/HEAD");
		if (ino === headIno) {
			return { ino, size: 0, kind: "symlink" };
		}

		return this.#makeAttr(ino);
	}

	async readdir(ino: Ino, offset: number): Promise<DirEntry[]> {
		const dirPath = this.#inodes.getPath(ino);
		if (!dirPath) return [];

		const dotEntries: DirEntry[] = [
			{ name: ".", ino, kind: "directory" },
			{ name: "..", ino: ROOT_INO, kind: "directory" },
		];

		// Root: structural dirs + HEAD symlink
		if (ino === ROOT_INO) {
			const headIno = this.#inodes.getOrAssign("/HEAD");
			const entries: DirEntry[] = [
				...dotEntries,
				{ name: "HEAD", ino: headIno, kind: "symlink" },
				{ name: "branches", ino: this.#inodes.getOrAssign("/branches"), kind: "directory" },
				{ name: "tags", ino: this.#inodes.getOrAssign("/tags"), kind: "directory" },
				{ name: "commits", ino: this.#inodes.getOrAssign("/commits"), kind: "directory" },
			];
			return entries.slice(offset);
		}

		// /branches — list all branches
		if (dirPath === "/branches") {
			const branches = await this.#listRefs("refs/heads/");
			const entries: DirEntry[] = [...dotEntries];
			for (const name of branches) {
				const branchPath = `/branches/${name}`;
				const branchIno = this.#inodes.getOrAssign(branchPath);
				if (!this.#nodes.has(branchIno)) {
					this.#nodes.set(branchIno, VIRTUAL_DIR);
				}
				entries.push({ name, ino: branchIno, kind: "directory" });
			}
			return entries.slice(offset);
		}

		// /tags — list all tags
		if (dirPath === "/tags") {
			const tags = await this.#listRefs("refs/tags/");
			const entries: DirEntry[] = [...dotEntries];
			for (const name of tags) {
				const tagPath = `/tags/${name}`;
				const tagIno = this.#inodes.getOrAssign(tagPath);
				if (!this.#nodes.has(tagIno)) {
					this.#nodes.set(tagIno, VIRTUAL_DIR);
				}
				entries.push({ name, ino: tagIno, kind: "directory" });
			}
			return entries.slice(offset);
		}

		// /commits — virtual: no enumeration
		if (dirPath === "/commits") {
			return dotEntries.slice(offset);
		}

		// Tree directory — resolve children
		await this.#ensureChildrenResolved(ino);
		const children = this.#childrenCache.get(ino);
		if (!children) return dotEntries.slice(offset);

		return [...dotEntries, ...children].slice(offset);
	}

	async read(ino: Ino, offset: number, size: number): Promise<Buffer> {
		const node = this.#nodes.get(ino);
		if (!node || node.kind !== "file" || !node.sha) return Buffer.alloc(0);

		const content = await this.#readBlob(node.sha);
		return content.subarray(offset, offset + size) as Buffer;
	}

	async readlink(ino: Ino): Promise<string | null> {
		const path = this.#inodes.getPath(ino);
		if (path === "/HEAD") {
			return this.#readHeadTarget();
		}

		// Git symlinks store their target as blob content
		const node = this.#nodes.get(ino);
		if (!node || node.kind !== "symlink" || !node.sha) return null;

		const content = await this.#readBlob(node.sha);
		return content.toString("utf-8");
	}

	// =========================================================================
	// Git operations
	// =========================================================================

	/** List ref names under a prefix (e.g., "refs/heads/" -> ["main", "feature"]). */
	async #listRefs(prefix: string): Promise<string[]> {
		const fmt = "%(refname:strip=2)";
		const result = await $`git -C ${this.#repoPath} for-each-ref --format=${fmt} ${prefix}`.quiet().nothrow();
		if (result.exitCode !== 0) return [];
		return result.text().trim().split("\n").filter(Boolean);
	}

	/** Resolve a ref to a commit SHA, with caching. */
	async #resolveRefToSha(ref: string): Promise<string | null> {
		const cached = this.#refCache.get(ref);
		if (cached) return cached;

		// Use rev-parse with ^{commit} to dereference tags to commits
		const result = await $`git -C ${this.#repoPath} rev-parse --verify ${`${ref}^{commit}`}`.quiet().nothrow();
		if (result.exitCode !== 0) return null;

		const sha = result.text().trim();
		if (!sha) return null;

		this.#refCache.set(ref, sha);
		return sha;
	}

	/** Get the tree SHA for a commit. */
	async #getCommitTree(commitSha: string): Promise<string | null> {
		const cached = this.#commitTreeCache.get(commitSha);
		if (cached) return cached;

		const result = await $`git -C ${this.#repoPath} rev-parse --verify ${`${commitSha}^{tree}`}`.quiet().nothrow();
		if (result.exitCode !== 0) return null;

		const treeSha = result.text().trim();
		if (!treeSha) return null;

		this.#commitTreeCache.set(commitSha, treeSha);
		return treeSha;
	}

	/** Parse a git tree object into entries. Cached by SHA. */
	async #readTree(treeSha: string): Promise<TreeEntry[]> {
		const cached = this.#treeCache.get(treeSha);
		if (cached) return cached;

		const result = await $`git -C ${this.#repoPath} ls-tree ${treeSha}`.quiet().nothrow();
		if (result.exitCode !== 0) return [];

		const entries: TreeEntry[] = [];
		for (const line of result.text().trim().split("\n")) {
			if (!line) continue;
			// Format: <mode> <type> <sha>\t<name>
			const tabIdx = line.indexOf("\t");
			if (tabIdx === -1) continue;

			const meta = line.slice(0, tabIdx).split(" ");
			const name = line.slice(tabIdx + 1);

			if (meta.length < 3) continue;
			entries.push({
				mode: meta[0],
				type: meta[1] as TreeEntry["type"],
				sha: meta[2],
				name,
			});
		}

		this.#treeCache.set(treeSha, entries);
		return entries;
	}

	/** Read a blob's content. Cached by SHA with LRU eviction. */
	async #readBlob(sha: string): Promise<Buffer> {
		const cached = this.#blobCache.get(sha);
		if (cached) return cached;

		const result = await $`git -C ${this.#repoPath} cat-file blob ${sha}`.quiet().nothrow();
		if (result.exitCode !== 0) return Buffer.alloc(0);

		const buf = Buffer.from(await result.arrayBuffer());

		// LRU eviction: if cache is full, remove oldest entry
		if (this.#blobCache.size >= GitFS.MAX_BLOB_CACHE) {
			const oldest = this.#blobCache.keys().next().value;
			if (oldest !== undefined) this.#blobCache.delete(oldest);
		}
		this.#blobCache.set(sha, buf);

		return buf;
	}

	// =========================================================================
	// Resolution helpers
	// =========================================================================

	/** Resolve HEAD as a symlink pointing to the current branch or commit. */
	async #resolveHead(): Promise<FileAttr | null> {
		const ino = this.#inodes.getOrAssign("/HEAD");
		this.#nodes.set(ino, { kind: "symlink", sha: null, gitMode: "120000" });
		return { ino, size: 0, kind: "symlink" };
	}

	/** Read the HEAD symlink target. */
	async #readHeadTarget(): Promise<string | null> {
		// Check if HEAD is a symbolic ref (branch)
		const symResult = await $`git -C ${this.#repoPath} symbolic-ref HEAD`.quiet().nothrow();
		if (symResult.exitCode === 0) {
			const ref = symResult.text().trim();
			// refs/heads/main -> branches/main
			if (ref.startsWith("refs/heads/")) {
				return `branches/${ref.slice("refs/heads/".length)}`;
			}
		}

		// Detached HEAD — point to commits/<sha>
		const shaResult = await $`git -C ${this.#repoPath} rev-parse HEAD`.quiet().nothrow();
		if (shaResult.exitCode === 0) {
			return `commits/${shaResult.text().trim()}`;
		}

		return null;
	}

	/** Resolve a branch/tag ref as a directory backed by its commit tree. */
	async #resolveRef(fsPath: string, gitRef: string): Promise<FileAttr | null> {
		const commitSha = await this.#resolveRefToSha(gitRef);
		if (!commitSha) return null;

		const treeSha = await this.#getCommitTree(commitSha);
		if (!treeSha) return null;

		const ino = this.#inodes.getOrAssign(fsPath);
		this.#nodes.set(ino, { kind: "directory", sha: treeSha, gitMode: "040000" });
		return { ino, size: 0, kind: "directory", mode: 0o555 };
	}

	/** Resolve /commits/<sha> as a directory. */
	async #resolveCommitDir(fsPath: string, sha: string): Promise<FileAttr | null> {
		// Validate it's a real commit
		const treeSha = await this.#getCommitTree(sha);
		if (!treeSha) return null;

		const ino = this.#inodes.getOrAssign(fsPath);
		this.#nodes.set(ino, { kind: "directory", sha: treeSha, gitMode: "040000" });
		return { ino, size: 0, kind: "directory", mode: 0o555 };
	}

	/** Ensure children of a directory inode are resolved from its git tree. */
	async #ensureChildrenResolved(parentIno: Ino): Promise<void> {
		if (this.#childrenCache.has(parentIno)) return;

		const node = this.#nodes.get(parentIno);
		if (!node || node.kind !== "directory" || !node.sha) return;

		const parentPath = this.#inodes.getPath(parentIno);
		if (!parentPath) return;

		const treeEntries = await this.#readTree(node.sha);
		const children: DirEntry[] = [];

		for (const entry of treeEntries) {
			const childPath = `${parentPath}/${entry.name}`;
			const childIno = this.#inodes.getOrAssign(childPath);
			const childNode = this.#gitEntryToNode(entry);
			this.#nodes.set(childIno, childNode);
			children.push({ name: entry.name, ino: childIno, kind: childNode.kind });
		}

		this.#childrenCache.set(parentIno, children);
	}

	/** Convert a git tree entry to an FsNode. */
	#gitEntryToNode(entry: TreeEntry): GitNode {
		switch (entry.type) {
			case "tree":
				return { kind: "directory", sha: entry.sha, gitMode: entry.mode };
			case "blob":
				// Git mode 120000 = symlink
				if (entry.mode === "120000") {
					return { kind: "symlink", sha: entry.sha, gitMode: entry.mode };
				}
				return { kind: "file", sha: entry.sha, gitMode: entry.mode };
			case "commit":
				// Submodule — expose as a directory placeholder
				return { kind: "directory", sha: entry.sha, gitMode: entry.mode };
		}
	}

	/** Build a FileAttr from a stored node. */
	#makeAttr(ino: Ino): FileAttr | null {
		const node = this.#nodes.get(ino);
		if (!node) return null;

		switch (node.kind) {
			case "directory":
				return { ino, size: 0, kind: "directory", mode: 0o555 };
			case "file": {
				// Executable bit from git mode (100755)
				const mode = node.gitMode === "100755" ? 0o555 : 0o444;
				// We don't know size without reading the blob; report 0 for getattr.
				// FUSE read() returns the actual bytes regardless.
				return { ino, size: 0, kind: "file", mode };
			}
			case "symlink":
				return { ino, size: 0, kind: "symlink" };
		}
	}

	/** Invalidate ref caches to pick up new commits/branches. */
	refresh(): void {
		this.#refCache.clear();
		this.#childrenCache.clear();
		// Don't clear tree/blob/commitTree caches — they're SHA-keyed and immutable.
	}
}
