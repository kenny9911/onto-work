#!/usr/bin/env python3
"""Import reviewed, locked bundles from Agentic Operator. Never execute a bundle."""

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import tempfile

ROOT = Path(__file__).resolve().parent.parent
NAME = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*")


def digest(data):
    return hashlib.sha256(data).hexdigest()


def safe_path(root, relative):
    parts = PurePosixPath(relative).parts
    if (not parts or relative != "/".join(parts) or "\\" in relative
            or any(p in (".", "..") for p in parts) or parts[0] == "/"):
        raise ValueError(f"Unsafe bundle path: {relative}")
    current = root
    if current.is_symlink():
        raise ValueError(f"Linked root: {root}")
    for part in parts:
        current = current / part
        if current.is_symlink():
            raise ValueError(f"Linked path: {relative}")
    return current


def read_regular(root, relative):
    path = safe_path(root, relative)
    info = path.stat()
    if not path.is_file() or info.st_nlink != 1:
        raise ValueError(f"Not a single regular file: {relative}")
    return path.read_bytes()


def file_paths(root):
    found = set()
    for path in root.rglob("*"):
        if path.is_symlink():
            raise ValueError(f"Linked catalog entry: {path}")
        if path.is_file():
            found.add(path.relative_to(root).as_posix())
        elif not path.is_dir():
            raise ValueError(f"Special catalog entry: {path}")
    return found


def validate_curation(curation, selected):
    if curation.get("schemaVersion") != 1 or not curation.get("retained"):
        raise ValueError("Unsupported or empty shared curation")
    decisions = curation["retained"] + curation.get("removed", [])
    if len({entry["id"] for entry in decisions}) != len(decisions) or any(not entry.get("rationale") for entry in decisions):
        raise ValueError("Curation requires unique ids and explicit rationales")
    expected = {entry["id"]: entry for entry in curation["retained"]}
    if len(selected) != len(expected) or {entry.get("id") for entry in selected} != set(expected):
        raise ValueError("Shared selection must match retained curation; removed or unreviewed skills cannot be imported")
    for entry in selected:
        if any(entry[key] != expected[entry["id"]][key] for key in ("name", "sourceId")):
            raise ValueError(f"Shared identity differs from curation: {entry['id']}")


def check_catalog(shared, enforce_curation=True):
    manifest = json.loads(read_regular(shared, "skill-catalog.json"))
    if manifest.get("schemaVersion") != 1 or not manifest.get("skills"):
        raise ValueError("Unsupported or empty shared catalog")
    if enforce_curation:
        curation_bytes = read_regular(shared, "skill-curation.json")
        validate_curation(json.loads(curation_bytes), manifest["skills"])
        if digest(curation_bytes) != manifest.get("curationManifestSha256"):
            raise ValueError("Shared curation changed; import the reviewed selection")
    skills_root = safe_path(shared, "skills")
    expected = set()
    names = set()
    for skill in manifest["skills"]:
        name = skill["name"]
        if not NAME.fullmatch(name) or name in names:
            raise ValueError(f"Invalid or duplicate skill name: {name}")
        names.add(name)
        files = skill["files"]
        if not any(f["path"] == "SKILL.md" for f in files):
            raise ValueError(f"Missing SKILL.md: {name}")
        for f in files:
            relative = name + "/" + f["path"]
            if relative in expected:
                raise ValueError(f"Duplicate file: {relative}")
            expected.add(relative)
            data = read_regular(skills_root, relative)
            if len(data) != f["bytes"] or digest(data) != f["sha256"]:
                raise ValueError(f"Catalog integrity mismatch: {relative}")
    if file_paths(skills_root) != expected:
        raise ValueError("Unexpected or missing shared skill files")
    return manifest


def build_catalog(source, selection, target):
    """Build a complete staged tree after validating the reviewed source lock."""
    curation_bytes = read_regular(target, "skill-curation.json")
    validate_curation(json.loads(curation_bytes), selection["skills"])
    lock_bytes = read_regular(source, "sources.lock.json")
    if digest(lock_bytes) != selection["sourceLockSha256"]:
        raise ValueError("Source lock changed; review upstream changes and update skill-sources.json")
    lock = json.loads(lock_bytes)
    locked = {f["path"]: f for f in lock["files"]}
    manifest = {"schemaVersion": 1, "curationManifestSha256": digest(curation_bytes), "skills": []}
    names = set()
    for selected in selection["skills"]:
        name = selected["name"]
        if not NAME.fullmatch(name) or name in names:
            raise ValueError(f"Invalid or duplicate selected name: {name}")
        names.add(name)
        prefix = selected["path"] + "/"
        files = {path: path[len(prefix):] for path in locked if path.startswith(prefix)}
        if "SKILL.md" not in files.values():
            raise ValueError(f"Selected skill not in source lock: {selected['id']}")
        if file_paths(safe_path(source, selected["path"])) != set(files.values()):
            raise ValueError(f"Unexpected source files: {selected['id']}")
        for notice in selected.get("noticePaths", []):
            files[notice] = ".source-notices/" + PurePosixPath(notice).name
        entry = {k: selected[k] for k in ("id", "name", "sourceId", "sourceUrl", "revision", "license")}
        entry["files"] = []
        for source_path, output_path in sorted(files.items(), key=lambda item: item[1]):
            data = read_regular(source, source_path)
            expected = locked[source_path]
            if len(data) != expected["bytes"] or digest(data) != expected["sha256"]:
                raise ValueError(f"Source integrity mismatch: {source_path}")
            if output_path == "SKILL.md":
                text = data.decode("utf-8")
                if not text.startswith("---\n"):
                    raise ValueError(f"Missing frontmatter: {source_path}")
                frontmatter, body = text[4:].split("\n---", 1)
                replacement = "# Modified by onto-work: namespaced the skill name; other source content preserved.\nname: " + name
                frontmatter, count = re.subn(r"^name:.*$", replacement, frontmatter, flags=re.M)
                if count != 1:
                    raise ValueError(f"Ambiguous skill name: {source_path}")
                data = ("---\n" + frontmatter + "\n---" + body).encode("utf-8")
            output = safe_path(target, "skills/" + name + "/" + output_path)
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_bytes(data)
            output.chmod(0o755 if expected.get("mode") == "100755" else 0o644)
            entry["files"].append({"path": output_path, "sha256": digest(data), "bytes": len(data)})
        manifest["skills"].append(entry)
    (target / "skill-catalog.json").write_text(json.dumps(manifest, indent=2) + "\n")
    check_catalog(target)
    return manifest


def install(source, shared, selection, update=False):
    if shared.is_symlink():
        raise ValueError("Shared directory must not be a link")
    shared.mkdir(parents=True, exist_ok=True)
    curation_bytes = read_regular(shared, "skill-curation.json")
    with tempfile.TemporaryDirectory(prefix=".skill-import-", dir=shared.parent) as temporary:
        staged = Path(temporary)
        (staged / "skill-curation.json").write_bytes(curation_bytes)
        manifest = build_catalog(source, selection, staged)
        old = None
        if (shared / "skill-catalog.json").exists():
            # Verify the complete old managed tree before a reviewed scope change.
            # Its curation can differ from the next selection being installed.
            old = check_catalog(shared, enforce_curation=False)
            if old == manifest:
                return manifest, False
            if not update:
                raise ValueError("Catalog update requires reviewed --update; local edits are never overwritten")
        elif (shared / "skills").exists():
            raise ValueError("Refusing to replace an unowned skills directory")
        if read_regular(shared, "skill-curation.json") != curation_bytes:
            raise ValueError("Shared curation changed during import")
        backup = staged / "previous-skills"
        if old:
            os.rename(shared / "skills", backup)
        try:
            os.rename(staged / "skills", shared / "skills")
            os.replace(staged / "skill-catalog.json", shared / "skill-catalog.json")
        except BaseException:
            if (shared / "skills").exists():
                shutil.rmtree(shared / "skills")
            if backup.exists():
                os.rename(backup, shared / "skills")
            raise
        return manifest, True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=ROOT.parent / "agentic-operator" / "skills-library")
    parser.add_argument("--check", action="store_true", help="Verify local shared files; no source repository needed")
    parser.add_argument("--update", action="store_true", help="Replace a clean catalog with a reviewed selection")
    args = parser.parse_args()
    shared = ROOT / "shared"
    if args.check:
        manifest = check_catalog(shared)
        action = "Verified"
    else:
        selection = json.loads(read_regular(shared, "skill-sources.json"))
        manifest, changed = install(args.source, shared, selection, args.update)
        action = "Imported" if changed else "Unchanged"
    count = sum(len(skill["files"]) for skill in manifest["skills"])
    print(f"{action}: {len(manifest['skills'])} shared skills, {count} files")


if __name__ == "__main__":
    main()
