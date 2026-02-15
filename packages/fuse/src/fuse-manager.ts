/**
 * FuseManager: lifecycle manager for FUSE mounts in agent sessions.
 *
 * Agents declare which virtual filesystems they need (e.g., "git").
 * The manager mounts them at session start and unmounts at dispose.
 *
 * Usage:
 *   const manager = new FuseManager();
 *   manager.register("git", () => new GitFS(repoPath));
 *   await manager.mount("/tmp/agent-mounts/session-123");
 *   // ... agent runs, can access /tmp/agent-mounts/session-123/git/...
 *   await manager.unmount();
 *
 * The manager creates a composite mount with each registered filesystem
 * under its name: /mountpoint/<name>/...
 */

import * as fs from "node:fs/promises";
import { logger } from "@oh-my-pi/pi-utils";
import { createCompositeFS } from "./composite-fs";
import type { FuseMount, MountOptions } from "./mount";
import { mount as fuseMount } from "./mount";
import type { VirtualFS } from "./types";

/** Factory function that creates a VirtualFS instance. */
export type VirtualFSFactory = () => VirtualFS | Promise<VirtualFS>;

export class FuseManager {
	/** Registered filesystem factories, keyed by mount name. */
	#factories = new Map<string, VirtualFSFactory>();

	/** Active mount (null when not mounted). */
	#mount: FuseMount | null = null;

	/** Active VFS instances (for cleanup). */
	#instances: VirtualFS[] = [];

	/** Register a filesystem factory under a given name. */
	register(name: string, factory: VirtualFSFactory): void {
		this.#factories.set(name, factory);
	}

	/** Whether any filesystems are registered. */
	get hasFilesystems(): boolean {
		return this.#factories.size > 0;
	}

	/** Whether currently mounted. */
	get mounted(): boolean {
		return this.#mount?.mounted ?? false;
	}

	/** The mount point path, or null if not mounted. */
	get mountPoint(): string | null {
		return this.#mount?.mountPoint ?? null;
	}

	/** Names of registered filesystems. */
	get registeredNames(): string[] {
		return [...this.#factories.keys()];
	}

	/**
	 * Instantiate all registered filesystems and mount them.
	 *
	 * If only one filesystem is registered, it's mounted directly.
	 * If multiple, they're combined under a composite mount.
	 *
	 * @param mountPoint - Directory to mount at (created if needed).
	 * @param options - Mount options (binary path, etc.).
	 */
	async mount(mountPoint: string, options?: MountOptions): Promise<void> {
		if (this.#mount) {
			logger.warn("FuseManager: already mounted, unmounting first");
			await this.unmount();
		}

		if (this.#factories.size === 0) {
			logger.debug("FuseManager: no filesystems registered, skipping mount");
			return;
		}

		// Create all VFS instances
		const mounts: Record<string, VirtualFS> = {};
		for (const [name, factory] of this.#factories) {
			try {
				const vfs = await factory();
				mounts[name] = vfs;
				this.#instances.push(vfs);
			} catch (err) {
				logger.error("FuseManager: failed to create filesystem", {
					name,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}

		if (Object.keys(mounts).length === 0) {
			logger.warn("FuseManager: all filesystem factories failed, skipping mount");
			return;
		}

		// Single filesystem: mount directly. Multiple: composite.
		const names = Object.keys(mounts);
		const vfs = names.length === 1 ? mounts[names[0]] : createCompositeFS(mounts);

		try {
			this.#mount = await fuseMount(vfs, mountPoint, options);
			logger.debug("FuseManager: mounted", {
				mountPoint,
				filesystems: names,
			});
		} catch (err) {
			logger.error("FuseManager: mount failed", {
				mountPoint,
				error: err instanceof Error ? err.message : String(err),
			});
			// Clean up instances
			for (const instance of this.#instances) {
				await instance.destroy?.().catch(() => {});
			}
			this.#instances = [];
		}
	}

	/** Unmount and clean up all resources. */
	async unmount(): Promise<void> {
		if (this.#mount) {
			try {
				await this.#mount.unmount();
			} catch (err) {
				logger.warn("FuseManager: unmount error", {
					error: err instanceof Error ? err.message : String(err),
				});
			}
			this.#mount = null;
		}

		this.#instances = [];

		logger.debug("FuseManager: unmounted");
	}
}
