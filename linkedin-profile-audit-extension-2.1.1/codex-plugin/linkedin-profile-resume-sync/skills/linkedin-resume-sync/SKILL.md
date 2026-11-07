---
name: linkedin-resume-sync
description: Use the local Resume Contract Studio MCP bridge to inspect, plan, update, and verify a user-approved LinkedIn resume through the companion Edge extension.
---

# Resume Contract Studio

Use `bridge_status` first. The user only needs the extension, MCP connection, a logged-in LinkedIn tab, their profile URL, and a request in natural language. Do not ask them to create JSON, run Python, or prepare a workspace.

Call `set_resume_plan` with an empty operations list for the selected public profile, then use `inspect_page` and `activate_control` to explore the visible profile and open the real edit/add forms. Reinspect after every navigation or control activation. Build the plan from the inspected form: each create or replace operation includes its observed URL, fields, and exact visible labels or a unique editable selector. The plan supports arbitrary profile sections and field names; it is passed from MCP to the extension for each command and never relies on packaged sample content.

Use `send_command` then `wait_result` for browser actions. For an operation, use `preview_operation` first when the user needs a before/after comparison; it opens the mapped form if needed and compares visible values without filling or saving. If `read_history` reports a `review_selection` array for the active locale, only those selected operation IDs can be applied; an empty selection blocks every apply. Use `open_operation`, `inspect_current_form`, `apply_operation`, and `apply_and_save_operation` only when the user has authorized saving. Follow with `verify_operation`, then reopen the saved item to confirm it persisted. For create operations, use `check_operation_identity` on the fully loaded visible listing before filling, and do not retry an uncertain save without checking for the item. Preserve undeclared fields, media, links, dates, and associations.

Before calling a profile complete, audit each relevant LinkedIn section: Introduction, About, Experience, Education, Services, Career break, Skills, Featured, Licenses & certifications, Projects, Courses, Recommendations, Volunteer experience, Publications, Patents, Honors & awards, Test scores, Languages, Organizations, and Causes. Mark every section as not requested, absent, mapped, verified, or blocked. Standard text, checkbox, single-select, and list autocomplete controls are supported only after inspection. File uploads, multiple-selects, radio groups, recommendation actions, and account/privacy controls are blocked unless separately implemented and tested.

Never call undocumented LinkedIn APIs. Stop if LinkedIn requests login, CAPTCHA, account verification, or if the visible form cannot be mapped. Finish with `export_logger` and `read_history`. `verify_operation` only proves the current visible form matches; report any section that cannot be reopened and confirmed. Legacy file-based contracts remain supported for existing workspaces, but they are optional.
