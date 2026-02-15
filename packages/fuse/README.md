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
