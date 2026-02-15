/**
 * FUSE mount manager.
 *
 * Spawns the pi-fuse Rust binary, connects it to a VirtualFS implementation
 * via JSON-RPC over stdin/stdout, and manages the mount lifecycle.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import type { FileSink } from "bun";
import type { FuseEvent, FuseRequest, FuseResponse, VirtualFS } from "./types";

// POSIX errno constants
const ENOENT = 2;
const EIO = 5;
const ENOSYS = 38;
const ENOTEMPTY = 39;

export interface MountOptions {
	/** Path to the pi-fuse binary. Defaults to searching workspace then PATH. */
	binaryPath?: string;
}

export interface FuseMount {
	/** The mount point path. */
	readonly mountPoint: string;
	/** Unmount the filesystem and clean up. */
	unmount(): Promise<void>;
	/** Whether the mount is currently active. */
	readonly mounted: boolean;
}

/**
 * Mount a VirtualFS at the given path.
 *
 * Creates the mount point directory if needed, spawns the pi-fuse binary,
 * and starts routing FUSE operations to the VirtualFS implementation.
 */
export async function mount(vfs: VirtualFS, mountPoint: string, options?: MountOptions): Promise<FuseMount> {
	// Ensure mount point exists
	await fs.mkdir(mountPoint, { recursive: true });

	const binaryPath = options?.binaryPath ?? (await findBinary());
	if (!binaryPath) {
		throw new Error("pi-fuse binary not found. Build with: cargo build -p pi-fuse --release");
	}

	logger.debug(`Mounting VFS '${vfs.name}' at ${mountPoint} using ${binaryPath}`);

	const proc = Bun.spawn([binaryPath, mountPoint], {
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});

	let mounted = false;
	const { promise: readyPromise, resolve: readyResolve, reject: readyReject } = Promise.withResolvers<void>();

	// Drain stderr to logger
	drainStderr(proc.stderr as ReadableStream<Uint8Array>, vfs.name);

	// Read stdout line by line and dispatch requests
	const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
	const decoder = new TextDecoder();
	let buffer = "";

	const processLoop = async () => {
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				// Keep the last (potentially incomplete) chunk
				buffer = lines.pop() ?? "";

				for (const line of lines) {
					if (!line.trim()) continue;
					try {
						const msg = JSON.parse(line);
						if (isEvent(msg)) {
							if (msg.event === "ready") {
								mounted = true;
								readyResolve();
							}
						} else {
							// It's a FUSE request — handle and respond
							handleRequest(vfs, msg as FuseRequest, proc.stdin);
						}
					} catch (e) {
						logger.error(`[${vfs.name}] Failed to parse message: ${line}`, { error: e });
					}
				}
			}
		} catch (e) {
			if (mounted) {
				logger.error(`[${vfs.name}] Read loop error`, { error: e });
			}
		} finally {
			mounted = false;
		}
	};

	// Start the read loop (don't await — it runs for the lifetime of the mount)
	processLoop();

	// Handle process exit
	proc.exited.then(code => {
		if (mounted) {
			logger.warn(`[${vfs.name}] pi-fuse exited unexpectedly with code ${code}`);
		}
		mounted = false;
		// If we never got ready, reject the promise
		readyReject(new Error(`pi-fuse exited with code ${code} before ready`));
	});

	// Wait for the ready signal (with timeout)
	const timeout = setTimeout(() => {
		readyReject(new Error("pi-fuse mount timed out (10s)"));
	}, 10_000);

	try {
		await readyPromise;
	} finally {
		clearTimeout(timeout);
	}

	logger.debug(`VFS '${vfs.name}' mounted at ${mountPoint}`);

	return {
		get mountPoint() {
			return mountPoint;
		},
		get mounted() {
			return mounted;
		},
		async unmount() {
			if (!mounted) return;
			mounted = false;
			logger.debug(`Unmounting VFS '${vfs.name}' from ${mountPoint}`);

			// Kill the FUSE process — AutoUnmount will handle the unmount
			proc.kill();
			await proc.exited;

			// Fallback: fusermount if still mounted
			try {
				await Bun.spawn(["fusermount", "-u", mountPoint], { stdout: "ignore", stderr: "ignore" }).exited;
			} catch {
				// Ignore — mount may already be gone
			}

			await vfs.destroy?.();
			logger.debug(`VFS '${vfs.name}' unmounted`);
		},
	};
}

// ============================================================================
// Request dispatch
// ============================================================================

function isEvent(msg: unknown): msg is FuseEvent {
	return typeof msg === "object" && msg !== null && "event" in msg;
}

/** Handle a single FUSE request and write the response to the bridge's stdin. */
function handleRequest(vfs: VirtualFS, req: FuseRequest, stdin: FileSink): void {
	// Fire and forget — the response is sent asynchronously
	dispatch(vfs, req)
		.then(resp => writeResponse(stdin, resp))
		.catch(e => {
			logger.error(`[${vfs.name}] Error handling ${req.op}`, { error: e });
			writeResponse(stdin, { id: req.id, error: EIO });
		});
}

async function dispatch(vfs: VirtualFS, req: FuseRequest): Promise<FuseResponse> {
	switch (req.op) {
		case "lookup": {
			const attr = await vfs.lookup(req.parent, req.name);
			if (!attr) return { id: req.id, error: ENOENT };
			return { id: req.id, attr };
		}

		case "getattr": {
			const attr = await vfs.getattr(req.ino);
			if (!attr) return { id: req.id, error: ENOENT };
			return { id: req.id, attr };
		}

		case "readdir": {
			const entries = await vfs.readdir(req.ino, req.offset);
			return { id: req.id, entries };
		}

		case "read": {
			const buf = await vfs.read(req.ino, req.offset, req.size);
			const data = buf.toString("base64");
			return { id: req.id, data };
		}

		case "readlink": {
			if (!vfs.readlink) return { id: req.id, error: ENOSYS };
			const target = await vfs.readlink(req.ino);
			if (!target) return { id: req.id, error: ENOENT };
			return { id: req.id, target };
		}

		case "write": {
			if (!vfs.write) return { id: req.id, error: ENOSYS };
			const buf = Buffer.from(req.data, "base64");
			const written = await vfs.write(req.ino, req.offset, buf);
			return { id: req.id, written };
		}

		case "create": {
			if (!vfs.create) return { id: req.id, error: ENOSYS };
			const createAttr = await vfs.create(req.parent, req.name, req.mode);
			if (!createAttr) return { id: req.id, error: EIO };
			return { id: req.id, attr: createAttr };
		}

		case "mkdir": {
			if (!vfs.mkdir) return { id: req.id, error: ENOSYS };
			const mkdirAttr = await vfs.mkdir(req.parent, req.name, req.mode);
			if (!mkdirAttr) return { id: req.id, error: EIO };
			return { id: req.id, attr: mkdirAttr };
		}

		case "unlink": {
			if (!vfs.unlink) return { id: req.id, error: ENOSYS };
			const unlinkOk = await vfs.unlink(req.parent, req.name);
			if (!unlinkOk) return { id: req.id, error: ENOENT };
			return { id: req.id };
		}

		case "rmdir": {
			if (!vfs.rmdir) return { id: req.id, error: ENOSYS };
			const rmdirOk = await vfs.rmdir(req.parent, req.name);
			if (!rmdirOk) return { id: req.id, error: ENOTEMPTY };
			return { id: req.id };
		}

		case "rename": {
			if (!vfs.rename) return { id: req.id, error: ENOSYS };
			const renameOk = await vfs.rename(req.parent, req.name, req.newparent, req.newname);
			if (!renameOk) return { id: req.id, error: ENOENT };
			return { id: req.id };
		}

		case "symlink": {
			if (!vfs.symlink) return { id: req.id, error: ENOSYS };
			const symlinkAttr = await vfs.symlink(req.parent, req.name, req.target);
			if (!symlinkAttr) return { id: req.id, error: EIO };
			return { id: req.id, attr: symlinkAttr };
		}

		case "truncate": {
			if (!vfs.truncate) return { id: req.id, error: ENOSYS };
			const truncAttr = await vfs.truncate(req.ino, req.size);
			if (!truncAttr) return { id: req.id, error: ENOENT };
			return { id: req.id, attr: truncAttr };
		}

		default: {
			const _exhaustive: never = req;
			return { id: (req as FuseRequest).id, error: ENOSYS };
		}
	}
}

function writeResponse(stdin: FileSink, resp: FuseResponse): void {
	const line = `${JSON.stringify(resp)}\n`;
	stdin.write(line);
	stdin.flush();
}

// ============================================================================
// Helpers
// ============================================================================

async function drainStderr(stream: ReadableStream<Uint8Array>, name: string): Promise<void> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			const text = decoder.decode(value, { stream: true }).trim();
			if (text) logger.debug(`[${name}/stderr] ${text}`);
		}
	} catch {
		// Stream closed
	}
}

/** Locate the pi-fuse binary. */
async function findBinary(): Promise<string | null> {
	// 1. Check workspace target directory
	const workspaceBin = path.resolve(import.meta.dir, "../../../target/release/pi-fuse");
	try {
		await fs.access(workspaceBin);
		return workspaceBin;
	} catch {
		// Not found
	}

	// 2. Check debug build
	const debugBin = path.resolve(import.meta.dir, "../../../target/debug/pi-fuse");
	try {
		await fs.access(debugBin);
		return debugBin;
	} catch {
		// Not found
	}

	// 3. Check PATH
	const which = Bun.which("pi-fuse");
	if (which) return which;

	return null;
}
