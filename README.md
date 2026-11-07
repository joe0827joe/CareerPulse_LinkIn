# CareerPulse_LinkIn / Resume Contract Studio

Local-first LinkedIn profile review and update toolkit. It combines a Manifest V3 browser extension, a local stdio MCP server, and an offline Python diff/contract pipeline.

> **Public source code only.** Personal LinkedIn targets, snapshots, logs, review runs, and generated release archives are deliberately excluded. The original ZIP contains sensitive personal data; do not upload the ZIP itself to a public repository.

## Architecture

```text
Agent / MCP client
  -> stdio MCP server (Node.js 18+)
  -> loopback HTTP bridge (127.0.0.1:37841)
  -> browser extension background service worker
  -> LinkedIn visible page content script
  -> user-reviewed form editing + readback verification

Python pipeline: offline snapshot -> diff -> review / rollback artifacts
```

| Directory | Responsibility |
|---|---|
| `linkedin-profile-audit-extension-2.1.1/` | Browser extension source (manifest version is 4.11.0; directory name is legacy) |
| `linkedin-profile-audit-extension-2.1.1/codex-plugin/linkedin-profile-resume-sync/` | MCP stdio service (plugin version 2.8.0) |
| `pipeline/` | Offline diff engine, contract generator and tests |
| `contracts/` | Generic JSON Schema and example contract |
| `package-release.ps1` | Package the extension and MCP plugin for local installation |

## Local setup

1. Load `linkedin-profile-audit-extension-2.1.1/` as an unpacked extension in Edge/Chrome.
2. Use the included MCP plugin with a Node.js 18+ runtime and an MCP-compatible client.
3. Log in to LinkedIn yourself, then use `set_resume_plan` with a **user-approved** profile URL and empty operations to start read-only discovery.
4. Inspect visible controls and field mappings before creating/editing entries. Confirm every save by reopening the entry. Never treat an unsaved form preview as a published change.

**Personal file-based workflow:** Copy the per-user targets into `pipeline/linkedin_profile_target_*.json`, then run `python pipeline/build_profile_contract.py`. The generated contract and extension `profile-targets.json` stay local; they are gitignored. Do not use the placeholder contract as a real profile target.

## Checks

```sh
python -m unittest discover -s pipeline -p 'test_*.py' -v
node --check linkedin-profile-audit-extension-2.1.1/codex-plugin/linkedin-profile-resume-sync/server.mjs
node --check linkedin-profile-audit-extension-2.1.1/background.js
node --check linkedin-profile-audit-extension-2.1.1/linkedin_profile_audit_v2.user.js
```

## Security / limitations

- No private LinkedIn API calls, auto-login or credential harvesting are intended by this source.
- The current loopback HTTP bridge does **not authenticate commands** and exposes permissive CORS; run it only in a trusted local environment. Hardening the bridge with per-session authentication is a pre-deployment security task.
- Browser DOM mappings may change; selectors must be validated against the live user-visible form. Browser publishing and end-to-end flows are **not** validated by offline unit tests.
- The offline diff engine includes some legacy, profile-specific extraction logic. Generalizing and fixture-testing the extractor is a separate technical debt item.

See `GETTING_STARTED.md` for usage details.
