//! JSON-RPC protocol types for the FUSE bridge.
//!
//! The bridge sends `Request` objects to the parent process (stdout)
//! and receives `Response` objects back (stdin). Each request/response
//! pair is correlated by an `id` field.

use serde::{Deserialize, Serialize};

/// A filesystem operation request sent to the parent process.
#[derive(Debug, Serialize)]
#[serde(tag = "op")]
pub enum Request {
	/// Look up a directory entry by name.
	#[serde(rename = "lookup")]
	Lookup { id: u64, parent: u64, name: String },

	/// Get attributes of an inode.
	#[serde(rename = "getattr")]
	GetAttr { id: u64, ino: u64 },

	/// Read directory entries.
	#[serde(rename = "readdir")]
	ReadDir { id: u64, ino: u64, offset: i64 },

	/// Read file content.
	#[serde(rename = "read")]
	Read { id: u64, ino: u64, offset: i64, size: u32 },

	/// Read the target of a symbolic link.
	#[serde(rename = "readlink")]
	ReadLink { id: u64, ino: u64 },

	/// Write file content.
	#[serde(rename = "write")]
	Write { id: u64, ino: u64, offset: i64, data: String },

	/// Create a file in a directory.
	#[serde(rename = "create")]
	Create { id: u64, parent: u64, name: String, mode: u32 },

	/// Create a directory.
	#[serde(rename = "mkdir")]
	Mkdir { id: u64, parent: u64, name: String, mode: u32 },

	/// Remove a directory entry.
	#[serde(rename = "unlink")]
	Unlink { id: u64, parent: u64, name: String },

	/// Remove a directory.
	#[serde(rename = "rmdir")]
	Rmdir { id: u64, parent: u64, name: String },

	/// Rename a directory entry.
	#[serde(rename = "rename")]
	Rename { id: u64, parent: u64, name: String, newparent: u64, newname: String },

	/// Create a symbolic link.
	#[serde(rename = "symlink")]
	Symlink { id: u64, parent: u64, name: String, target: String },

	/// Truncate or extend a file to a given size.
	#[serde(rename = "truncate")]
	Truncate { id: u64, ino: u64, size: u64 },
}

/// File type as reported by the parent process.
#[derive(Debug, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum FileKind {
	File,
	Directory,
	Symlink,
}

/// Attributes of a filesystem entry.
#[derive(Debug, Deserialize)]
pub struct Attr {
	pub ino:  u64,
	pub size: u64,
	pub kind: FileKind,
	/// Unix permission bits (e.g. 0o755). Defaults to 0o444 for files, 0o555 for
	/// dirs.
	#[serde(default)]
	pub mode: Option<u16>,
}

/// A single directory entry.
#[derive(Debug, Deserialize)]
pub struct DirEntry {
	pub name: String,
	pub ino:  u64,
	pub kind: FileKind,
}

/// Response from the parent process.
#[derive(Debug, Deserialize)]
pub struct Response {
	pub id:      u64,
	/// Null on success, or an errno value on failure.
	pub error:   Option<i32>,
	/// Payload — interpretation depends on the request type.
	#[serde(default)]
	pub attr:    Option<Attr>,
	#[serde(default)]
	pub entries: Option<Vec<DirEntry>>,
	/// Base64-encoded file content for read responses.
	#[serde(default)]
	pub data:    Option<String>,
	/// Symlink target for readlink responses.
	#[serde(default)]
	pub target:  Option<String>,
	/// Number of bytes written for write responses.
	#[serde(default)]
	pub written: Option<u32>,
}

/// Events sent from the bridge to the parent (not expecting a response).
#[derive(Debug, Serialize)]
#[serde(tag = "event")]
pub enum Event {
	#[serde(rename = "ready")]
	Ready,
}

/// I/O helpers for the JSON-RPC protocol.
pub mod io {
	use std::{
		io::{self, BufRead, Write},
		sync::Mutex,
	};

	use serde::Serialize;

	use super::{Request, Response};

	// Stdout is used for sending requests/events to the parent.
	// Stdin is used for receiving responses.
	// Both must be locked to prevent interleaving in multi-threaded FUSE.
	static STDOUT: Mutex<()> = Mutex::new(());
	static STDIN: Mutex<()> = Mutex::new(());

	/// Send a request to the parent process and wait for the correlated
	/// response.
	pub fn call(req: &Request) -> io::Result<Response> {
		let id = match req {
			Request::Lookup { id, .. }
			| Request::GetAttr { id, .. }
			| Request::ReadDir { id, .. }
			| Request::Read { id, .. }
			| Request::ReadLink { id, .. }
			| Request::Write { id, .. }
			| Request::Create { id, .. }
			| Request::Mkdir { id, .. }
			| Request::Unlink { id, .. }
			| Request::Rmdir { id, .. }
			| Request::Rename { id, .. }
			| Request::Symlink { id, .. }
			| Request::Truncate { id, .. } => *id,
		};

		// Send request
		{
			let _lock = STDOUT.lock().expect("stdout lock poisoned");
			let mut out = io::stdout().lock();
			serde_json::to_writer(&mut out, req)?;
			out.write_all(b"\n")?;
			out.flush()?;
		}

		// Read response — we may need to skip responses for other ids
		// (shouldn't happen with synchronized I/O, but be defensive)
		loop {
			let _lock = STDIN.lock().expect("stdin lock poisoned");
			let mut line = String::new();
			io::stdin().lock().read_line(&mut line)?;
			if line.is_empty() {
				return Err(io::Error::new(
					io::ErrorKind::UnexpectedEof,
					"parent process closed stdin",
				));
			}
			let resp: Response = serde_json::from_str(line.trim())?;
			if resp.id == id {
				return Ok(resp);
			}
			// Wrong id — shouldn't happen, but log and retry
			log::warn!("Received response for id {} but expected {id}", resp.id);
		}
	}

	/// Send an event (no response expected).
	pub fn send_event<T: Serialize>(event: &T) {
		let _lock = STDOUT.lock().expect("stdout lock poisoned");
		let mut out = io::stdout().lock();
		let _ = serde_json::to_writer(&mut out, event);
		let _ = out.write_all(b"\n");
		let _ = out.flush();
	}
}
