/**
 * Core types for the virtual filesystem layer.
 *
 * A VirtualFS provides the filesystem operations that back a FUSE mount.
 * The bridge (pi-fuse binary) translates kernel FUSE calls into these
 * operations via a JSON-RPC protocol over stdin/stdout.
 */

// ============================================================================
// Inode types
// ============================================================================

/** Inode number. 1 is always the root directory. */
export type Ino = number;

/** Root inode number, per FUSE convention. */
export const ROOT_INO: Ino = 1;

/** File type classification. */
export type FileKind = "file" | "directory" | "symlink";

/** Attributes of a filesystem entry. */
export interface FileAttr {
	/** Inode number. Must be unique within the filesystem. */
	ino: Ino;
	/** Size in bytes (for files). Directories can use 0. */
	size: number;
	/** Type of entry. */
	kind: FileKind;
	/** Unix permission bits (optional, defaults: 0o444 file, 0o555 dir). */
	mode?: number;
}

/** A single directory entry. */
export interface DirEntry {
	/** Entry name (filename, not full path). */
	name: string;
	/** Inode number of this entry. */
	ino: Ino;
	/** Type of entry. */
	kind: FileKind;
}

// ============================================================================
// Protocol types (match the Rust side)
// ============================================================================

/** Request from the FUSE bridge to the TS handler. */
export type FuseRequest =
	| { op: "lookup"; id: number; parent: Ino; name: string }
	| { op: "getattr"; id: number; ino: Ino }
	| { op: "readdir"; id: number; ino: Ino; offset: number }
	| { op: "read"; id: number; ino: Ino; offset: number; size: number }
	| { op: "readlink"; id: number; ino: Ino }
	| { op: "write"; id: number; ino: Ino; offset: number; data: string }
	| { op: "create"; id: number; parent: Ino; name: string; mode: number }
	| { op: "mkdir"; id: number; parent: Ino; name: string; mode: number }
	| { op: "unlink"; id: number; parent: Ino; name: string }
	| { op: "rmdir"; id: number; parent: Ino; name: string }
	| { op: "rename"; id: number; parent: Ino; name: string; newparent: Ino; newname: string }
	| { op: "symlink"; id: number; parent: Ino; name: string; target: string }
	| { op: "truncate"; id: number; ino: Ino; size: number };

/** Response sent back to the FUSE bridge. */
export interface FuseResponse {
	id: number;
	error?: number | null;
	attr?: FileAttr | null;
	entries?: DirEntry[] | null;
	/** Base64-encoded file content. */
	data?: string | null;
	/** Symlink target path. */
	target?: string | null;
	/** Number of bytes written. */
	written?: number | null;
}

/** Event from the FUSE bridge (no response expected). */
export interface FuseEvent {
	event: string;
}

// ============================================================================
// VirtualFS interface
// ============================================================================

/**
 * Interface for implementing a virtual filesystem.
 *
 * Implementations provide the backing logic for a FUSE mount. The mount
 * manager spawns the pi-fuse binary and forwards all FUSE operations to
 * the VirtualFS implementation.
 *
 * Inode management:
 * - Inode 1 is always the root directory
 * - Implementations must assign stable inode numbers to entries
 * - The InodeMap helper can be used for path-to-inode mapping
 */
export interface VirtualFS {
	/** Human-readable name for this filesystem (used in logging). */
	readonly name: string;

	/**
	 * Look up a child entry by name within a parent directory.
	 * Return null if the entry doesn't exist.
	 */
	lookup(parent: Ino, name: string): Promise<FileAttr | null>;

	/**
	 * Get the attributes of an inode.
	 * Return null if the inode doesn't exist.
	 */
	getattr(ino: Ino): Promise<FileAttr | null>;

	/**
	 * List directory entries starting from the given offset.
	 * Return all entries after the offset. The bridge handles pagination.
	 * Should include "." and ".." entries.
	 */
	readdir(ino: Ino, offset: number): Promise<DirEntry[]>;

	/**
	 * Read file content.
	 * Return the requested slice as a Buffer.
	 */
	read(ino: Ino, offset: number, size: number): Promise<Buffer>;

	/**
	 * Read the target of a symbolic link.
	 * Return null if the inode is not a symlink.
	 */
	readlink?(ino: Ino): Promise<string | null>;

	/**
	 * Write data to a file at the given offset.
	 * Return the number of bytes written.
	 */
	write?(ino: Ino, offset: number, data: Buffer): Promise<number>;

	/**
	 * Create a new file in the given parent directory.
	 * Return the attributes of the created file, or null on failure.
	 */
	create?(parent: Ino, name: string, mode: number): Promise<FileAttr | null>;

	/**
	 * Create a directory.
	 * Return the new directory's attributes, or null on failure.
	 */
	mkdir?(parent: Ino, name: string, mode: number): Promise<FileAttr | null>;

	/**
	 * Remove a directory entry (file or symlink).
	 * Return true if removed, false if not found.
	 */
	unlink?(parent: Ino, name: string): Promise<boolean>;

	/**
	 * Remove an empty directory.
	 * Return true on success, false if not found or not empty.
	 */
	rmdir?(parent: Ino, name: string): Promise<boolean>;

	/**
	 * Rename/move a directory entry.
	 * Return true on success, false if the source doesn't exist.
	 */
	rename?(parent: Ino, name: string, newparent: Ino, newname: string): Promise<boolean>;

	/**
	 * Create a symbolic link.
	 * Return the attrs of the created symlink, or null on failure.
	 */
	symlink?(parent: Ino, name: string, target: string): Promise<FileAttr | null>;

	/**
	 * Truncate or extend a file to the given size.
	 * Return updated attributes, or null on failure.
	 */
	truncate?(ino: Ino, size: number): Promise<FileAttr | null>;

	/**
	 * Called when the filesystem is being unmounted.
	 * Use for cleanup (closing connections, freeing resources).
	 */
	destroy?(): Promise<void>;
}
