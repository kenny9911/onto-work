import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("importer", Path(__file__).with_name("import-shared-skills.py"))
importer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(importer)


class CatalogImportTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        root = Path(self.temporary.name)
        self.source, self.shared = root / "source", root / "shared"
        self.shared.mkdir()
        bundle = self.source / "upstream/vendor/skills/example"
        bundle.mkdir(parents=True)
        (bundle / "SKILL.md").write_text("---\nname: example\ndescription: Inspect an example.\n---\nRead assets/raw.bin.\n")
        (bundle / "assets").mkdir()
        (bundle / "assets/raw.bin").write_bytes(bytes(range(256)))
        (bundle / "LICENSE.txt").write_text("Example license fixture\n")
        (self.source / "upstream/vendor/README.md").write_text("Publisher notice\n")
        files = [{"path": p.relative_to(self.source).as_posix(), "bytes": p.stat().st_size,
                  "sha256": importer.digest(p.read_bytes()), "mode": "100644"}
                 for p in sorted(self.source.rglob("*")) if p.is_file()]
        lock = json.dumps({"schemaVersion": 1, "files": files}).encode()
        (self.source / "sources.lock.json").write_bytes(lock)
        self.selection = {"sourceLockSha256": importer.digest(lock), "skills": [{
            "id": "vendor/example", "sourceId": "vendor", "name": "vendor-example",
            "path": "upstream/vendor/skills/example", "sourceUrl": "https://example.com/source",
            "revision": "a" * 40, "license": "Apache-2.0",
            "noticePaths": ["upstream/vendor/README.md"]}]}
        self.curation = {"schemaVersion": 1, "retained": [{"id": "vendor/example", "name": "vendor-example",
            "sourceId": "vendor", "rationale": "Business example"}], "removed": []}
        self.save_curation()

    def save_curation(self):
        (self.shared / "skill-curation.json").write_text(json.dumps(self.curation))

    def install(self, update=False):
        return importer.install(self.source, self.shared, self.selection, update)

    def test_preserves_resources_licenses_and_notices_and_is_idempotent(self):
        manifest, changed = self.install()
        self.assertTrue(changed)
        skill = self.shared / "skills/vendor-example"
        self.assertEqual((skill / "assets/raw.bin").read_bytes(), bytes(range(256)))
        self.assertEqual((skill / "LICENSE.txt").read_text(), "Example license fixture\n")
        self.assertEqual((skill / ".source-notices/README.md").read_text(), "Publisher notice\n")
        self.assertIn("name: vendor-example\n", (skill / "SKILL.md").read_text())
        before = (skill / "SKILL.md").stat().st_mtime_ns
        self.assertEqual(self.install(), (manifest, False))
        self.assertEqual((skill / "SKILL.md").stat().st_mtime_ns, before)

    def test_changed_source_file_does_not_create_catalog(self):
        (self.source / "upstream/vendor/skills/example/assets/raw.bin").write_bytes(b"tampered")
        with self.assertRaisesRegex(ValueError, "Source integrity"):
            self.install()
        self.assertFalse((self.shared / "skills").exists())

    def test_new_source_lock_requires_review(self):
        (self.source / "sources.lock.json").write_text("{}")
        with self.assertRaisesRegex(ValueError, "Source lock changed"):
            self.install()

    def test_local_edits_are_never_overwritten_even_with_update(self):
        self.install()
        artifact = self.shared / "skills/vendor-example/assets/raw.bin"
        artifact.write_bytes(b"local edit")
        with self.assertRaisesRegex(ValueError, "Catalog integrity"):
            self.install(update=True)
        self.assertEqual(artifact.read_bytes(), b"local edit")

    def test_unlisted_source_files_and_links_are_rejected(self):
        artifact = self.source / "upstream/vendor/skills/example/extra"
        artifact.write_bytes(b"unreviewed")
        with self.assertRaisesRegex(ValueError, "Unexpected source"):
            self.install()
        artifact.unlink()
        artifact.symlink_to(self.source / "sources.lock.json")
        with self.assertRaisesRegex(ValueError, "Linked"):
            self.install()

    def test_catalog_closure_rejects_unlisted_skill(self):
        self.install()
        extra = self.shared / "skills/unreviewed"
        extra.mkdir()
        (extra / "SKILL.md").write_text("unexpected instructions")
        with self.assertRaisesRegex(ValueError, "Unexpected"):
            importer.check_catalog(self.shared)

    def test_reviewed_update_removes_old_selection_only_after_validation(self):
        self.install()
        self.selection["skills"][0]["name"] = "vendor-renamed"
        self.curation["retained"][0]["name"] = "vendor-renamed"
        self.save_curation()
        with self.assertRaisesRegex(ValueError, "requires reviewed --update"):
            self.install()
        self.assertTrue((self.shared / "skills/vendor-example").exists())
        self.install(update=True)
        self.assertFalse((self.shared / "skills/vendor-example").exists())
        self.assertTrue((self.shared / "skills/vendor-renamed/SKILL.md").exists())
        importer.check_catalog(self.shared)

    def test_removed_skill_cannot_be_reintroduced_from_an_older_source_lock(self):
        self.curation["removed"] = [{"id": "vendor/deploy", "name": "vendor-deploy", "sourceId": "vendor",
            "rationale": "Deployment-time scope is excluded"}]
        self.save_curation()
        self.selection["skills"].append(dict(self.selection["skills"][0], id="vendor/deploy", name="vendor-deploy"))
        with self.assertRaisesRegex(ValueError, "removed or unreviewed"):
            self.install(update=True)
        self.assertFalse((self.shared / "skills").exists())

    def test_curation_change_requires_reviewed_catalog_update(self):
        self.install()
        self.curation["retained"][0]["rationale"] = "Reviewed revised scope"
        self.save_curation()
        with self.assertRaisesRegex(ValueError, "curation changed"):
            importer.check_catalog(self.shared)
        with self.assertRaisesRegex(ValueError, "requires reviewed --update"):
            self.install()
        self.install(update=True)
        importer.check_catalog(self.shared)

    def test_authored_project_business_skill_is_preserved(self):
        authored = self.shared.parent / "customer-project/.agents/skills/customer-ontology/SKILL.md"
        authored.parent.mkdir(parents=True)
        authored.write_text("Authored business ontology")
        self.install()
        self.selection["skills"][0]["name"] = "vendor-renamed"
        self.curation["retained"][0]["name"] = "vendor-renamed"
        self.save_curation()
        self.install(update=True)
        self.assertEqual(authored.read_text(), "Authored business ontology")


if __name__ == "__main__":
    unittest.main()
