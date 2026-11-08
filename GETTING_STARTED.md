# Local usage (developer quickstart)

Requirements: Python 3.11+ (offline pipeline), Node.js 18+ (MCP service), and Edge/Chrome with extension support.

### Browser extension

In `edge://extensions/` turn on Developer mode and choose **Load unpacked**, then select `linkedin-profile-audit-extension-2.1.1/`. The extension is not a Chrome Web Store publication.

### MCP service

Point the MCP client to `linkedin-profile-audit-extension-2.1.1/codex-plugin/linkedin-profile-resume-sync/server.mjs` using Node.js, or install the local plugin manifest supported by your MCP client. The service exposes a local bridge at `127.0.0.1:37841` (unless overridden via `LINKEDIN_RESUME_PORT`). The bridge rejects ordinary website origins and requires one-time pairing plus a session bearer token to use command endpoints. For more restrictive access, set `LINKEDIN_RESUME_EXTENSION_ID` to the 32-character ID shown at `edge://extensions/`. This is not a security boundary against a compromised local OS or MCP client.

First pair the extension to the running MCP service:

1. Start the MCP server from your MCP client and call **`begin_bridge_pairing`**. It returns a one-time code that expires in 120 seconds.
2. At `edge://extensions/`, optionally copy the extension's ID and set `LINKEDIN_RESUME_EXTENSION_ID` in the MCP server environment to restrict origins (restart the server after setting it).
3. Click the Resume Contract Studio extension icon, paste the code in the popup, and press **配對 Bridge**. A successful pairing stores a random session token in extension-only storage. `bridge_status` should report `paired: true` and, after a poll, `connected: true`.
4. Re-pair whenever the MCP service restarts or the browser session is lost. A new pairing code revokes an earlier token. If commands were stranded while the browser was offline, call `begin_bridge_pairing` with `force: true` to cancel them before re-pairing. **Do not share pairing codes or bearer tokens.**

The extension currently uses the default fixed bridge port `37841`; do not override `LINKEDIN_RESUME_PORT` for an interactive browser session. `LINKEDIN_RESUME_PORT=0` is only for isolated automated tests.

For a new user: log in manually, open the LinkedIn profile, call `set_resume_plan` with a canonical profile URL and no operations, inspect the visible page/form, provide the user-approved operations with validated field mappings, and use the review/save/verify tools. A successful form fill is not proof of a saved profile entry.

### Read-only smoke verification

Run `node --test tests/bridge_readonly_smoke.test.mjs` from the repository root. This synthetic test does **not** use your LinkedIn login or change any profile. For live verification, manually sign in and pair the extension, set a plan with `operations: []`, then use only `status`, `scan`, `inspect_page`, or `read_history` through `send_command` / `wait_result`. Do **not** use `apply_operation` or `apply_and_save_operation` during a read-only smoke test. A green CI cannot verify live LinkedIn selectors.

### Offline pipeline

```sh
python -m unittest discover -s pipeline -p 'test_*.py' -v
python pipeline/resume_diff.py --help
python pipeline/build_profile_contract.py --help
```

Provide your own target configuration and your own extracted snapshot locally; they must not enter this public Git repository. See `contracts/linkedin-profile-sync-contract.template.json` for the generic format and `contracts/linkedin-profile-sync-contract.schema.json` for the schema. Browser control identifiers and URLs in examples are placeholders and must be inspected, not blindly reused.

### Release package

On Windows PowerShell: `./package-release.ps1`. The generated `release/` outputs are local build artifacts and ignored by Git.
