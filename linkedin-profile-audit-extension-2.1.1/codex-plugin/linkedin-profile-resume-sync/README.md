# Resume Contract Studio

Local Codex Plugin for the companion Edge extension in this repository.

## Prerequisites

- Node.js 18 or newer.
- The unpacked Edge extension from `../../` is loaded.
- A signed-in LinkedIn profile tab is open.

## Data and permissions

The MCP server listens only on `127.0.0.1:37841`. The Edge extension polls that local endpoint and performs commands against visible LinkedIn forms. No undocumented LinkedIn API is called. A new user starts with `set_resume_plan` and an empty `operations` array, then uses read-only `inspect_page` and `inspect_current_form` to build mappings from the actual page. The resulting session plan is attached to every browser command, so it does not use a fixed profile or packaged target content. After a save, reopen the entry and use `verify_operation`, then export the Logger. Commands and form snapshots can contain professional profile data and should not be shared publicly.

## Failure behavior

The tools return a timeout if the extension is not loaded or no matching LinkedIn tab is open. Login, CAPTCHA, verification, ambiguous form mappings, and complex unsupported widgets require user attention. A legacy workspace contract remains optional for existing users.
