"""Build the portable v1 profile-sync contract from the per-locale review targets.

The contract is data only: the extension may use it to fill visible forms, but it
can never contain credentials or authorize an undocumented LinkedIn API call.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT = ROOT / "contracts" / "linkedin-profile-sync-contract.json"
DEFAULT_EXTENSION_TARGETS = ROOT / "linkedin-profile-audit-extension-2.1.1" / "profile-targets.json"


def verification_for(operation: dict) -> dict:
    fields = operation["fields"]
    if operation["operation"] == "manual_review":
        return {"strategy": "manual"}
    if "text" in fields:
        return {"strategy": "exact_text", "expected": fields["text"]}
    if "description" in fields:
        return {"strategy": "contains_text", "expected": fields["description"]}
    if "name" in fields:
        return {"strategy": "contains_text", "expected": fields["name"]}
    return {"strategy": "manual"}


def build_contract(targets: list[dict]) -> dict:
    profile_urls = {target["profile_url"] for target in targets}
    if len(profile_urls) != 1:
        raise ValueError("Locale targets must name exactly one public profile URL")
    primary_locales = {target.get("shared_content_primary_locale") for target in targets}
    if len(primary_locales) != 1 or not isinstance(next(iter(primary_locales)), str) or not next(iter(primary_locales)):
        raise ValueError("Locale targets must name exactly one shared-content primary locale")
    shared_primary_locale = targets[0]["shared_content_primary_locale"]
    shared_operation_sets = {tuple(target.get("shared_content_operation_ids", [])) for target in targets}
    if len(shared_operation_sets) != 1:
        raise ValueError("Locale targets must declare the same shared-content operation IDs")
    shared_operation_ids = list(shared_operation_sets.pop())
    known_operation_ids = {operation["id"] for target in targets for operation in target["operations"]}
    if not shared_operation_ids or not set(shared_operation_ids) <= known_operation_ids:
        raise ValueError("Shared-content operation IDs must name approved operations")
    operations = []
    for target in targets:
        locale = target["profile_locale"]
        for operation in target["operations"]:
            item = {
                "id": operation["id"],
                "locale": locale,
                "section": operation["section"],
                "operation": operation["operation"],
                "url": operation["url"],
                "fields": operation["fields"],
                "evidence": [operation["evidence"]],
                "verification": verification_for(operation),
            }
            if "field_mapping" in operation:
                item["field_mapping"] = operation["field_mapping"]
            operations.append(item)
        for index, follow_up in enumerate(target.get("manual_follow_ups", []), start=1):
            section = {"education_and_certifications": "education", "projects": "project"}.get(follow_up["section"], follow_up["section"])
            reason = follow_up.get("reason", "Requires manual verification before creating a public profile entry.")
            operations.append({
                "id": f"manual_{locale}_{index}",
                "locale": locale,
                "section": section,
                "operation": "manual_review",
                "fields": {"recommendation": follow_up["recommendation"]},
                "evidence": [reason],
                "verification": {"strategy": "manual"},
                "manual_reason": reason,
            })
    return {
        "schema_version": "1.0",
        "artifact_type": "linkedin_profile_sync_contract",
        "profile": {"public_profile_url": profile_urls.pop()},
        "locales": [target["profile_locale"] for target in targets],
        "shared_content_primary_locale": shared_primary_locale,
        "shared_content_operation_ids": shared_operation_ids,
        "operations": operations,
        "restrictions": {
            "visible_ui_only": True,
            "direct_network_writes": False,
            "automatic_delete": False,
        },
    }


def build_extension_targets(targets: list[dict]) -> dict:
    """Derive only the visible-form fields understood by the companion extension."""
    profile_urls = {target["profile_url"] for target in targets}
    if len(profile_urls) != 1:
        raise ValueError("Locale targets must name exactly one public profile URL")
    primary_locales = {target.get("shared_content_primary_locale") for target in targets}
    if len(primary_locales) != 1 or not isinstance(next(iter(primary_locales)), str) or not next(iter(primary_locales)):
        raise ValueError("Locale targets must name exactly one shared-content primary locale")
    shared_operation_sets = {tuple(target.get("shared_content_operation_ids", [])) for target in targets}
    if len(shared_operation_sets) != 1:
        raise ValueError("Locale targets must declare the same shared-content operation IDs")
    shared_operation_ids = list(shared_operation_sets.pop())
    known_operation_ids = {operation["id"] for target in targets for operation in target["operations"]}
    if not shared_operation_ids or not set(shared_operation_ids) <= known_operation_ids:
        raise ValueError("Shared-content operation IDs must name approved operations")
    payload = {"schema_version": "2.0", "artifact_type": "linkedin_extension_targets",
               "profile_url": profile_urls.pop(), "shared_content_primary_locale": targets[0]["shared_content_primary_locale"],
               "shared_content_operation_ids": shared_operation_ids, "targets": {}, "operations": {}}
    for target in targets:
        # Profile content is deliberately not projected into a fixed extension
        # shape.  The portable operation list below is the only write contract.
        locale_target = {}
        portable_operations = []
        for operation in target["operations"]:
            portable_operations.append({key: operation[key] for key in ("id", "section", "operation", "url", "fields", "field_mapping", "identity") if key in operation})
        payload["targets"][target["profile_locale"]] = locale_target
        payload["operations"][target["profile_locale"]] = portable_operations
    return payload


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--extension-targets-output", type=Path, default=DEFAULT_EXTENSION_TARGETS)
    parser.add_argument("--target", type=Path, action="append", help="Per-locale target JSON; repeat for every locale. Without this flag, all pipeline/linkedin_profile_target_*.json files are used.")
    args = parser.parse_args()
    target_paths = args.target or sorted((ROOT / "pipeline").glob("linkedin_profile_target_*.json"))
    if not target_paths:
        raise ValueError("No locale target JSON files found; pass --target for each intended locale")
    targets = [json.loads(path.read_text(encoding="utf-8")) for path in target_paths]
    contract = build_contract(targets)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(contract, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    extension_targets = build_extension_targets(targets)
    args.extension_targets_output.parent.mkdir(parents=True, exist_ok=True)
    args.extension_targets_output.write_text(json.dumps(extension_targets, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
