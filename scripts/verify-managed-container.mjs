// Offline kernel-isolation probe. Does not create an Agents API session or run a model.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const image = process.argv[2];
assert.match(image || "", /^(?:[a-zA-Z0-9._:/-]+@)?sha256:[a-f0-9]{64}$/, "Supply a reviewed local image ID or registry digest.");
const directory = await mkdtemp(join(tmpdir(), "managed-container-probe-"));
try {
  const workspace = join(directory, "workspace");
  const outside = join(directory, "outside.txt");
  await mkdir(workspace, { mode: 0o755 });
  await writeFile(join(workspace, "README.md"), "committed snapshot canary", { mode: 0o644 });
  await writeFile(outside, "unmounted host canary", { mode: 0o600 });
  const code = `
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    assert.equal(process.getuid(), 10001);
    assert.equal(fs.readFileSync('/workspace/README.md', 'utf8'), 'committed snapshot canary');
    assert.throws(() => fs.writeFileSync('/workspace/changed.txt', 'no'), { code: 'EROFS' });
    assert.throws(() => fs.writeFileSync('/etc/changed.txt', 'no'));
    const rootMount = fs.readFileSync('/proc/mounts', 'utf8').split(String.fromCharCode(10)).map(line => line.split(' ')).find(fields => fields[1] === '/');
    assert.ok(rootMount?.[3].split(',').includes('ro'));
    assert.equal(fs.existsSync(${JSON.stringify(outside)}), false);
    assert.equal(fs.existsSync('/var/run/docker.sock'), false);
    assert.equal(process.env.AGENTS_API_KEY, undefined);
    assert.equal(process.env.OPENAI_API_KEY, undefined);
    fs.writeFileSync('/tmp/scratch.txt', 'scratch works');
    fs.writeFileSync('/home/codex/scratch.txt', 'home works');
    console.log('PASS: non-root, read-only source/root, unmounted host data/socket, writable scratch, no application keys');
  `;
  const { stdout } = await run("docker", ["run", "--rm", "--init", "--pull=never", "--network=none",
    "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--user", "10001:10001",
    "--pids-limit", "128", "--memory", "2g", "--cpus", "2",
    "--tmpfs", "/tmp:rw,nosuid,nodev,size=268435456",
    "--tmpfs", "/home/codex:rw,nosuid,nodev,mode=700,uid=10001,gid=10001,size=268435456",
    "--mount", `type=bind,source=${workspace},target=/workspace,readonly`, "--workdir", "/workspace",
    "--env", "HOME=/home/codex", "--env", "CODEX_HOME=/home/codex/.codex", "--entrypoint", "node", image, "-e", code,
  ], { timeout: 30_000, maxBuffer: 16_384 });
  process.stdout.write(stdout);
} finally { await rm(directory, { recursive: true, force: true }); }
