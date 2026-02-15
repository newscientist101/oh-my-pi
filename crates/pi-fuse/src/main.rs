//! pi-fuse: FUSE bridge that delegates filesystem operations to a parent
//! process via JSON-RPC over stdin/stdout.
//!
//! Protocol:
//! - Rust (this binary) writes JSON request lines to stdout
//! - Parent process reads them, handles the FS logic, writes JSON response
//!   lines to our stdin
//! - Each request has an `id` field for correlation
//!
//! Usage: pi-fuse <mountpoint>

mod protocol;
mod vfs;

use std::{env, path::PathBuf, process};

use fuser::{Config, MountOption, SessionACL};
use log::info;

use crate::vfs::BridgeFs;

fn main() {
	env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("warn"))
		.target(env_logger::Target::Stderr)
		.init();

	let args: Vec<String> = env::args().collect();
	if args.len() < 2 {
		eprintln!("Usage: pi-fuse <mountpoint>");
		process::exit(1);
	}

	let mountpoint = PathBuf::from(&args[1]);
	if !mountpoint.exists() {
		eprintln!("Mount point does not exist: {}", mountpoint.display());
		process::exit(1);
	}

	let bridge = BridgeFs::new();

	info!("Mounting at {}", mountpoint.display());

	let mut options = Config::default();
	options.mount_options =
		vec![MountOption::FSName("pi-fuse".to_string()), MountOption::AutoUnmount];
	options.acl = SessionACL::All;

	// This blocks until unmounted
	if let Err(e) = fuser::mount2(bridge, &mountpoint, &options) {
		eprintln!("Mount failed: {e}");
		process::exit(1);
	}
}
