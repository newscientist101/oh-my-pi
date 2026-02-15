//! FUSE filesystem implementation that bridges to the parent process.

use std::{
	ffi::OsStr,
	sync::atomic::{AtomicU64, Ordering},
	time::Duration,
};

use fuser::{
	Errno, FileAttr, FileHandle, FileType, Filesystem, Generation, INodeNo, KernelConfig, LockOwner,
	OpenFlags, ReplyAttr, ReplyData, ReplyDirectory, ReplyEntry, Request,
};
use log::debug;

use crate::protocol::{self, FileKind};

/// Short TTL — we don't cache attributes since the TS side is the source of
/// truth.
const TTL: Duration = Duration::from_secs(1);

/// Next request ID.
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

fn next_id() -> u64 {
	NEXT_ID.fetch_add(1, Ordering::Relaxed)
}

fn errno(code: i32) -> Errno {
	Errno::from_i32(code)
}

const fn to_file_type(kind: FileKind) -> FileType {
	match kind {
		FileKind::File => FileType::RegularFile,
		FileKind::Directory => FileType::Directory,
		FileKind::Symlink => FileType::Symlink,
	}
}

fn to_file_attr(attr: &protocol::Attr) -> FileAttr {
	let kind = to_file_type(attr.kind);
	let perm = attr.mode.unwrap_or(match attr.kind {
		FileKind::File | FileKind::Symlink => 0o444,
		FileKind::Directory => 0o555,
	});
	let now = std::time::SystemTime::now();
	// SAFETY: getuid/getgid are trivial POSIX calls with no preconditions.
	let uid = unsafe { libc::getuid() };
	// SAFETY: getuid/getgid are trivial POSIX calls with no preconditions.
	let gid = unsafe { libc::getgid() };
	let nlink = if attr.kind == FileKind::Directory {
		2
	} else {
		1
	};

	FileAttr {
		ino: INodeNo(attr.ino),
		size: attr.size,
		blocks: attr.size.div_ceil(512),
		atime: now,
		mtime: now,
		ctime: now,
		crtime: now,
		kind,
		perm,
		nlink,
		uid,
		gid,
		rdev: 0,
		blksize: 4096,
		flags: 0,
	}
}

pub struct BridgeFs;

impl BridgeFs {
	pub const fn new() -> Self {
		Self
	}
}

impl Filesystem for BridgeFs {
	fn init(&mut self, _req: &Request, _config: &mut KernelConfig) -> Result<(), std::io::Error> {
		// Signal readiness to parent now that the FUSE mount is established
		crate::protocol::io::send_event(&crate::protocol::Event::Ready);
		Ok(())
	}

	fn lookup(&self, _req: &Request, parent: INodeNo, name: &OsStr, reply: ReplyEntry) {
		let name_str = name.to_string_lossy().to_string();
		debug!("lookup: parent={}, name={name_str}", parent.0);

		let req = protocol::Request::Lookup { id: next_id(), parent: parent.0, name: name_str };

		match protocol::io::call(&req) {
			Ok(resp) => {
				if let Some(e) = resp.error {
					reply.error(errno(e));
					return;
				}
				if let Some(attr) = resp.attr {
					reply.entry(&TTL, &to_file_attr(&attr), Generation(0));
				} else {
					reply.error(Errno::ENOENT);
				}
			},
			Err(e) => {
				log::error!("lookup call failed: {e}");
				reply.error(Errno::ENOENT);
			},
		}
	}

	fn getattr(&self, _req: &Request, ino: INodeNo, _fh: Option<FileHandle>, reply: ReplyAttr) {
		debug!("getattr: ino={}", ino.0);

		let req = protocol::Request::GetAttr { id: next_id(), ino: ino.0 };

		match protocol::io::call(&req) {
			Ok(resp) => {
				if let Some(e) = resp.error {
					reply.error(errno(e));
					return;
				}
				if let Some(attr) = resp.attr {
					reply.attr(&TTL, &to_file_attr(&attr));
				} else {
					reply.error(Errno::ENOENT);
				}
			},
			Err(e) => {
				log::error!("getattr call failed: {e}");
				reply.error(Errno::ENOENT);
			},
		}
	}

	fn readdir(
		&self,
		_req: &Request,
		ino: INodeNo,
		_fh: FileHandle,
		offset: u64,
		mut reply: ReplyDirectory,
	) {
		debug!("readdir: ino={}, offset={offset}", ino.0);

		let req =
			protocol::Request::ReadDir { id: next_id(), ino: ino.0, offset: offset as i64 };

		match protocol::io::call(&req) {
			Ok(resp) => {
				if let Some(e) = resp.error {
					reply.error(errno(e));
					return;
				}
				if let Some(entries) = resp.entries {
					for (i, entry) in entries.iter().enumerate() {
						let entry_offset = offset + i as u64 + 1;
						let kind = to_file_type(entry.kind);
						let full = reply.add(INodeNo(entry.ino), entry_offset, kind, &entry.name);
						if full {
							break;
						}
					}
				}
				reply.ok();
			},
			Err(e) => {
				log::error!("readdir call failed: {e}");
				reply.error(Errno::EIO);
			},
		}
	}

	fn read(
		&self,
		_req: &Request,
		ino: INodeNo,
		_fh: FileHandle,
		offset: u64,
		size: u32,
		_flags: OpenFlags,
		_lock_owner: Option<LockOwner>,
		reply: ReplyData,
	) {
		debug!("read: ino={}, offset={offset}, size={size}", ino.0);

		let req = protocol::Request::Read { id: next_id(), ino: ino.0, offset: offset as i64, size };

		match protocol::io::call(&req) {
			Ok(resp) => {
				if let Some(e) = resp.error {
					reply.error(errno(e));
					return;
				}
				if let Some(data_b64) = resp.data {
					match base64_decode(&data_b64) {
						Ok(bytes) => reply.data(&bytes),
						Err(e) => {
							log::error!("base64 decode failed: {e}");
							reply.error(Errno::EIO);
						},
					}
				} else {
					reply.data(&[]);
				}
			},
			Err(e) => {
				log::error!("read call failed: {e}");
				reply.error(Errno::EIO);
			},
		}
	}

	fn readlink(&self, _req: &Request, ino: INodeNo, reply: ReplyData) {
		debug!("readlink: ino={}", ino.0);

		let req = protocol::Request::ReadLink { id: next_id(), ino: ino.0 };

		match protocol::io::call(&req) {
			Ok(resp) => {
				if let Some(e) = resp.error {
					reply.error(errno(e));
					return;
				}
				if let Some(target) = resp.target {
					reply.data(target.as_bytes());
				} else {
					reply.error(Errno::ENOSYS);
				}
			},
			Err(e) => {
				log::error!("readlink call failed: {e}");
				reply.error(Errno::EIO);
			},
		}
	}
}

/// Simple base64 decoder (avoids adding a dependency).
#[allow(clippy::many_single_char_names, reason = "standard base64 variable naming")]
fn base64_decode(input: &str) -> Result<Vec<u8>, String> {
	const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
	let mut lookup = [255u8; 256];
	for (idx, &ch) in TABLE.iter().enumerate() {
		lookup[ch as usize] = idx as u8;
	}

	let input = input.trim_end_matches('=');
	let mut out = Vec::with_capacity(input.len() * 3 / 4);
	let bytes = input.as_bytes();
	let mut pos = 0;

	while pos + 3 < bytes.len() {
		let a = lookup[bytes[pos] as usize];
		let b = lookup[bytes[pos + 1] as usize];
		let c = lookup[bytes[pos + 2] as usize];
		let d = lookup[bytes[pos + 3] as usize];
		if a == 255 || b == 255 || c == 255 || d == 255 {
			return Err("invalid base64 character".into());
		}
		out.push((a << 2) | (b >> 4));
		out.push((b << 4) | (c >> 2));
		out.push((c << 6) | d);
		pos += 4;
	}

	let remaining = bytes.len() - pos;
	if remaining == 2 {
		let a = lookup[bytes[pos] as usize];
		let b = lookup[bytes[pos + 1] as usize];
		out.push((a << 2) | (b >> 4));
	} else if remaining == 3 {
		let a = lookup[bytes[pos] as usize];
		let b = lookup[bytes[pos + 1] as usize];
		let c = lookup[bytes[pos + 2] as usize];
		out.push((a << 2) | (b >> 4));
		out.push((b << 4) | (c >> 2));
	}

	Ok(out)
}
