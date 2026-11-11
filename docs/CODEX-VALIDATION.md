# Codex adapter validation

Date: 2026-11-11, Asia/Singapore.

Upstream: HRuiCcc/RuiC-oc-ferry, commit `3d85a08c631e1350b01485bfde4ded5a9c1a177d`.

Environment: Windows 10 x64, Node.js 24.22.1, Electron 45.2.3, Codex CLI 0.165.0, isolated OpenCode 1.19.5.

## Passed

- `npm test`: 106 tests passed, 0 failed.
- `node --test test/responses.test.js`: 7 adapter tests passed, 0 failed after the final configuration changes.
- `git diff --check`: passed.
- JavaScript syntax checks for the launcher and smoke scripts: passed.
- A real Codex CLI request through `opencode/beam-free` returned `FERRY_OK` and completed with exit code 0.
- Real Codex CLI recognized model-generated `exec_command`, MCP and freeform `apply_patch` calls; tool execution was subsequently denied by the nested CLI policy.
- Temporary `CODEX_HOME` install, repeated install and restore passed. Restored configuration matched the original bytes.
- The user's actual Codex configuration still selects its existing `custom` provider. The adapter did not replace it.

## Incomplete or failed

- Real shell execution: rejected by the nested CLI policy (`blocked by policy`).
- Real `apply_patch` write: rejected (`writing is blocked by read-only sandbox; rejected by user approval settings`). No smoke output file was created.
- Real MCP fixture: rejected (`MCP tool call requires approval, but approval policy is never`).
- Follow-up live text and HTTP tool-roundtrip requests: upstream retry state, then the smoke deadlines expired. No successful real-model complete tool roundtrip is claimed.
- Windows NSIS installer and unpacked app built; installer and app executable headers and packaged source files verified.
- Reproduced `NSIS Error: Error writing temporary file` when launching the installer directly from the low-integrity workspace. Copying it to a normal-integrity temp location allowed setup to open and install the app. The build now stamps the installer with the normal medium integrity label.
- After the build fix, launching the installer from the workspace opened the NSIS setup wizard without the temporary-file error.
- Installed app window rendered successfully and showed 7 models from the existing local bridge. A separate instance with a temporary `CODEX_HOME` also rendered; its fresh live probes timed out, so connect/restore clicks were not tested against that temporary pool.
- Config install/restore and preservation behavior passed the dedicated temporary-config tests. No real user Codex configuration was changed during this check.
- Long-session compaction is not implemented.

Offline HTTP tests validate the request/response lifecycle and tool-history roundtrip with a controlled backend. Those tests do not prove the reliability of an upstream free model.

No approval policy was loosened to make a test pass. No Windows startup entry was added. A separate local bridge was started for validation on port 41981; it uses the `OC Ferry Codex` data directory.
