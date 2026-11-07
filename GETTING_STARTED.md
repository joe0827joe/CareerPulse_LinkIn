# Local usage (developer quickstart)

Requirements: Python 3.11+ (offline pipeline), Node.js 18+ (MCP service), and Edge/Chrome with extension support.

### Browser extension

In `edge://extensions/` turn on Developer mode and choose **Load unpacked**, then select `linkedin-profile-audit-extension-2.1.1/`. The extension is not a Chrome Web Store publication.

### MCP service

Point the MCP client to `linkedin-profile-audit-extension-2.1.1/codex-plugin/linkedin-profile-resume-sync/server.mjs` using Node.js, or install the local plugin manifest supported by your MCP client. The service exposes a local bridge at `127.0.0.1:37841` (unless overridden via `LINKEDIN_RESUME_PORT`). The bridge rejects ordinary website origins and permits only Chromium extension origins. For more restrictive access, set `LINKEDIN_RESUME_EXTENSION_ID` to the 32-character ID shown at `edge://extensions/` in the MCP server's environment. This is not authentication against local applications that can forge HTTP headers; use only on a trusted computer.

For a new user: log in manually, open the LinkedIn profile, call `set_resume_plan` with a canonical profile URL and no operations, inspect the visible page/form, provide the user-approved operations with validated field mappings, and use the review/save/verify tools. A successful form fill is not proof of a saved profile entry.

### Offline pipeline

```sh
python -m unittest discover -s pipeline -p 'test_*.py' -v
python pipeline/resume_diff.py --help
python pipeline/build_profile_contract.py --help
```

Provide your own target configuration and your own extracted snapshot locally; they must not enter this public Git repository. See `contracts/linkedin-profile-sync-contract.template.json` for the generic format and `contracts/linkedin-profile-sync-contract.schema.json` for the schema. Browser control identifiers and URLs in examples are placeholders and must be inspected, not blindly reused.

### Release package

On Windows PowerShell: `./package-release.ps1`. The generated `release/` outputs are local build artifacts and ignored by Git.