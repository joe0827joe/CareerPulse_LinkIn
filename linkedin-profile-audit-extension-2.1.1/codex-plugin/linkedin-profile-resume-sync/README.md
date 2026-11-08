# Resume Contract Studio

Local Codex Plugin for the companion Edge extension in this repository.

## Prerequisites

- Node.js 18 or newer.
- The unpacked Edge extension from `../../` is loaded.
- A signed-in LinkedIn profile tab is open.

## Data and permissions

The MCP server listens only on `127.0.0.1:37841`. To enable polling, call `begin_bridge_pairing` in the MCP client, open the extension action popup, and enter the returned one-time code within 120 seconds. The Edge extension then authenticates subsequent requests with a 256-bit session bearer token, stored in extension-only session storage; re-pair after each server restart. Optionally restrict the extension ID with `LINKEDIN_RESUME_EXTENSION_ID`. The Edge extension polls the authenticated local endpoint and performs commands against visible LinkedIn forms. No undocumented LinkedIn API is called. A new user starts with `set_resume_plan` and an empty `operations` array, then uses read-only `inspect_page` and `inspect_current_form` to build mappings from the actual page. The resulting session plan is attached to every browser command, so it does not use a fixed profile or packaged target content. After a save, reopen the entry and use `verify_operation`, then export the Logger. Commands and form snapshots can contain professional profile data and should not be shared publicly.

## Failure behavior

The tools return a timeout if the extension is not loaded or no matching LinkedIn tab is open. Login, CAPTCHA, verification, ambiguous form mappings, and complex unsupported widgets require user attention. A legacy workspace contract remains optional for existing users.


## Read-only smoke acceptance

With a paired browser and an empty-operations plan, run `read_only_smoke`. It checks read-only message transport and the selected profile, and compares ledger counts before and after; it does not issue any LinkedIn save command or return raw page text. It does not prove write selectors or saved changes. Write operations require an explicit fresh selection in the extension review panel.
