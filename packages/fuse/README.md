# @oh-my-pi/pi-fuse

Virtual filesystem layer using FUSE. Exposes arbitrary data sources as mounted directories that agents can navigate with standard Unix tools (`ls`, `cat`, `grep`, `find`).

## Architecture

```
VirtualFS (TypeScript)  <-->  JSON-RPC (stdin/stdout)  <-->  pi-fuse (Rust/fuser)  <-->  kernel FUSE
```

- **VirtualFS interface**: Implement `lookup`, `getattr`, `readdir`, `read`, and optionally `readlink` to define your filesystem.
- **pi-fuse binary**: A Rust binary (`crates/pi-fuse`) that handles the FUSE kernel protocol and bridges operations to the TypeScript process via JSON lines.
- **Mount manager**: Spawns the binary, routes requests, manages lifecycle.

## Usage

```typescript
import { MemoryFS, mount } from "@oh-my-pi/pi-fuse";

const fs = new MemoryFS("demo");
fs.addFile("/hello.txt", "Hello from FUSE!");
fs.addFile("/data/config.json", '{"key": "value"}');
fs.addDirectory("/empty-dir");
fs.addSymlink("/link", "/hello.txt");

const mnt = await mount(fs, "/tmp/my-mount");
// Agent can now: cat /tmp/my-mount/hello.txt
// Agent can now: ls /tmp/my-mount/data/

await mnt.unmount();
```

## Composite Filesystem

Combine multiple VirtualFS implementations under a single mount:

```typescript
import { createCompositeFS, mount } from "@oh-my-pi/pi-fuse";

const composite = createCompositeFS({
  git: myGitFS,
  tasks: myTaskFS,
  sessions: mySessionFS,
});

const mnt = await mount(composite, "/tmp/agent-workspace");
// /tmp/agent-workspace/git/...
// /tmp/agent-workspace/tasks/...
// /tmp/agent-workspace/sessions/...
```

## Git Filesystem

Expose a git repository's branches, tags, and commits as a read-only directory tree:

```typescript
import { GitFS, mount } from "@oh-my-pi/pi-fuse";

const gitFs = new GitFS("/path/to/repo");
const mnt = await mount(gitFs, "/tmp/git-mount");

// Browse branches:
//   ls /tmp/git-mount/branches/main/src/
//   cat /tmp/git-mount/branches/feature/README.md

// Browse tags:
//   ls /tmp/git-mount/tags/v1.0.0/

// Browse commits by SHA:
//   cat /tmp/git-mount/commits/abc1234.../package.json

// HEAD is a symlink to the current branch:
//   readlink /tmp/git-mount/HEAD  ->  branches/main

await mnt.unmount();
```

### Layout

```
/HEAD              -> symlink to branches/<current> or commits/<sha>
/branches/
  main/            -> tree at main's HEAD
  feature-x/       -> tree at feature-x's HEAD
/tags/
  v1.0.0/          -> tree at the tagged commit
/commits/
  <sha>/           -> tree at any commit (virtual: lookup-only, not enumerated)
```

All resolution is lazy — tree entries are fetched one level at a time, blob content on demand. Git objects are cached by SHA (immutable, naturally deduplicates across refs). Call `gitFs.refresh()` to pick up new commits and branches.

## Custom VirtualFS

```typescript
import { InodeMap, ROOT_INO, type VirtualFS } from "@oh-my-pi/pi-fuse";

class MyFS implements VirtualFS {
  name = "my-fs";
  #inodes = new InodeMap();

  async lookup(parent, name) { /* ... */ }
  async getattr(ino) { /* ... */ }
  async readdir(ino, offset) { /* ... */ }
  async read(ino, offset, size) { /* ... */ }
}
```

## Requirements

- Linux with FUSE3 (`libfuse3-3`)
- `user_allow_other` in `/etc/fuse.conf` (for agent access)
- The `pi-fuse` binary: `cargo build -p pi-fuse --release`

## Protocol

The Rust binary and TypeScript process communicate via newline-delimited JSON over stdin/stdout:

1. Rust sends `{"event":"ready"}` when mounted
2. For each FUSE operation, Rust writes a request: `{"op":"read","id":1,"ino":5,"offset":0,"size":4096}`
3. TypeScript processes the request and writes a response: `{"id":1,"data":"SGVsbG8="}`
4. File content is base64-encoded in transit
