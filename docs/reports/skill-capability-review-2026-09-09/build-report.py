"""Build the review artifacts and validate the evidence; does not run any model."""
from pathlib import Path
from collections import Counter
from datetime import datetime, timezone
import csv
import hashlib
import html
import json
import re

ROOT = Path(__file__).resolve().parent
inventory = json.loads((ROOT / 'inventory.json').read_text())
probes = json.loads((ROOT / 'runtime-probe-results.json').read_text())
reviews = []
for part in range(1, 4):
    reviews.extend(json.loads((ROOT / f'evaluations-{part}.json').read_text()))
by_id = {r['id']: r for r in reviews}
assert len(by_id) == len(reviews) == len(inventory['skills']) == 53
assert set(by_id) == {s['id'] for s in inventory['skills']}
activation = {r['id']: r for r in probes['activation']}
assert set(activation) == set(by_id)
norm = lambda s: re.sub(r'\s+', ' ', s).strip()
sha = lambda p: hashlib.sha256(Path(p).read_bytes()).hexdigest()
shared_root = Path('/Users/kenny/CSI-AICOE/onto-work-skills/shared')
shared_catalog_path = shared_root / 'skill-catalog.json'
shared_catalog = json.loads(shared_catalog_path.read_text())
shared_by_name = {s['name']: s for s in shared_catalog['skills']}
shared_copy_checks = []
body = lambda text: re.sub(r'^---\r?\n.*?\r?\n---(?:\r?\n|$)', '', text, count=1, flags=re.S)
for s in inventory['skills']:
    if s['ontoWork']:
        native = shared_by_name[s['name']]
        assert native['revision'] == s['revision']
        root = shared_root / 'skills' / native['name']
        for file in native['files']:
            assert sha(root / file['path']) == file['sha256'], (native['name'], file['path'])
        entrypoint = root / 'SKILL.md'
        assert body(entrypoint.read_text()) == body(Path(s['entrypoint']).read_text()), s['id']
        record = {'id': s['id'], 'entrypoint': str(entrypoint), 'entrypointSha256': sha(entrypoint),
                  'instructionBodyMatchesReviewedSource': True, 'bundleFileHashesVerified': len(native['files'])}
        s['ontoWorkCopy'] = record
        shared_copy_checks.append(record)
assert len(shared_copy_checks) == len(shared_catalog['skills']) == 14
resources, citations, cases = {}, 0, []
skills = []
for source in inventory['skills']:
    review = by_id[source['id']]
    assert review['riskLevel'] in {'low', 'moderate', 'high'}
    assert review['recommendation'] in {'retain', 'adapt', 'host-only', 'domain-only', 'retire-duplicate'}
    assert review['benefit'] and review['assessment'] and review['strengths']
    assert set(review['modelAssessments']) == {'astra', 'fable'}
    assert sha(source['entrypoint']) == source['entrypointSha256'], source['id']
    assert len(review['testCases']) == 2, source['id']
    assert {c['kind'] for c in review['testCases']} == {'positive', 'regression'}
    for path in review['resourcesReviewed']:
        assert Path(path).is_file(), path
        resources[path] = sha(path)
    assert source['entrypoint'] in review['resourcesReviewed'], source['id']
    assert review['risks'] and any(r['evidence'] for r in review['risks'])
    for risk in review['risks']:
        assert risk['mechanism'] and risk['impact'] and risk['mitigation']
        for evidence in risk['evidence']:
            path = Path(evidence['path'])
            lines = path.read_text().splitlines()
            start, end = evidence['lineStart'], evidence['lineEnd']
            assert 1 <= start <= end <= len(lines), evidence
            assert norm(evidence['quote']) in norm('\n'.join(lines[start-1:end])), evidence
            evidence['sourceSha256'] = sha(path)
            resources[str(path)] = sha(path)
            citations += 1
    for number, case in enumerate(review['testCases'], 1):
        assert case['prompt'] and case['passCriteria']
        case['status'] = 'planned-not-executed'
        cases.append({
            **case,
            'caseId': f"{source['id']}:{case['kind']}:{number}",
            'skillId': source['id'], 'status': 'planned-not-executed',
            'set': 'development-challenge',
        })
    skills.append({**source, **review,
                   'evidenceLevel': 'static-source-review',
                   'behavioralAssurance': 'not-established',
                   'activationProbe': activation[source['id']]})

for item in probes['sourceHashes']:
    assert sha(item['path']) == item['sha256'], item['path']

counts = dict(Counter(s['riskLevel'] for s in skills))
actions = dict(Counter(s['recommendation'] for s in skills))
shared = [s for s in skills if s['ontoWork']]
assert len(shared) == 14 and len(cases) == 106
summary = {
    'skillsReviewed': len(skills), 'ontoWorkSharedSkills': len(shared),
    'riskCounts': counts, 'recommendationCounts': actions,
    'ontoWorkRiskCounts': dict(Counter(s['riskLevel'] for s in shared)),
    'individualActivation': dict(Counter(p['status'] for p in probes['activation'])),
    'sourceCitationsValidated': citations, 'examinedFilesHashed': len(resources),
    'plannedCases': len(cases), 'executedModelCases': 0,
    'entrypointWords': sum(s['entrypointWords'] for s in skills),
    'entrypointBytes': sum(s['entrypointBytes'] for s in skills),
}
external_sources = [
    {'title': 'Official Astra guidance', 'url': 'https://developers.openai.com/api/docs/guides/latest-model', 'accessed': '2026-09-09'},
    {'title': 'Official Fable 5.1 prompting guidance', 'url': 'https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-fable-5-1', 'accessed': '2026-09-09'},
    {'title': 'Anthropic skill authoring guidance', 'url': 'https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices', 'accessed': '2026-09-09'},
]
manifest = {
    'schemaVersion': '1.0', 'reviewDate': '2026-09-09',
    'title': 'Skill capability review — Fable 5.1 and GPT-6 Astra',
    'scope': inventory['scope'],
    'conclusion': 'Non-degradation is not established. Concrete integration blockers and unnecessary instruction constraints require repair and paired evaluation.',
    'sourceCheckout': {'path': '/Users/kenny/CSI-AICOE/agentic-operator', 'headAtReview': '08e4c2abf4a9edcfeb21fbee94d0c9e16f92e423'},
    'ontoWorkSharedCopyVerification': {'path': str(shared_root),
        'mergedRevision': 'e18db784f510da71a120ef708aee866c8b048b47',
        'catalogSha256': sha(shared_catalog_path), 'skills': shared_copy_checks,
        'checkoutNote': 'The report destination checkout has unrelated in-progress work and does not contain this shared directory. It was not synchronized or changed by the review.'},
    'changesApplied': {'skills': False, 'runtime': False, 'modelSettings': False, 'productionRecords': False},
    'behavioralBenchmark': {
        'executed': False, 'modelCalls': 0, 'models': ['claude-fable-5-1', 'gpt-6-astra'],
        'observedQualityDelta': None, 'regressionRate': None, 'nonInferiorityEstablished': False,
        'reason': 'This request was handled as a source and integration review. Proposed cases have not been executed on either named model.',
    },
    'caveats': [
        'Risk labels are expert judgments, not measured regression rates or failure probabilities.',
        'All entrypoints were reviewed; linked resources were selected for relevance, not exhaustively audited.',
        'Activation probes exercise the provider-neutral runtime defaults in memory, not live tenant publications or native Codex loading.',
        'A prefix mutation was reproduced; no Fable API rejection or reasoning loss was observed.',
        'The proposed development cases are not independent held-out evidence.',
        'Aggregate file words/bytes are not token counts and are not all injected into each prompt.',
    ],
    'summary': summary, 'officialSources': external_sources,
    'runtimeEvidence': probes,
    'examinedSourceFiles': [{'path': p, 'sha256': h} for p, h in sorted(resources.items())],
    'skills': skills,
}
(ROOT / 'evaluation-manifest.json').write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + '\n')
(ROOT / 'evaluation-cases.json').write_text(json.dumps({
    'schemaVersion': '1.0', 'status': 'planned-not-executed', 'set': 'development-challenge',
    'models': ['claude-fable-5-1', 'gpt-6-astra'],
    'conditions': ['no-skill', 'natural-discovery', 'explicitly-loaded'],
    'warning': 'No outcomes are recorded. Use fresh held-out cases after adapting against this set. Keep each model pair aligned on tools, permissions, settings and fixtures.',
    'cases': cases,
}, indent=2, ensure_ascii=False) + '\n')

with (ROOT / 'skill-summary.csv').open('w', newline='') as out:
    writer = csv.writer(out)
    writer.writerow(['id', 'risk', 'recommendation', 'onto_work_shared', 'individual_activation', 'entrypoint_words', 'assessment'])
    for s in skills:
        writer.writerow([s['id'], s['riskLevel'], s['recommendation'], s['ontoWork'], s['activationProbe']['status'], s['entrypointWords'], s['assessment']])

link = lambda label, path: f'[{label}](<{path}>)'
escape_cell = lambda value: str(value).replace('|', '\\|').replace('\n', ' ')
methodology = (ROOT / 'methodology.md').read_text()
intro, remaining = methodology.split('## What “degradation” means', 1)
overview = f'''## Review totals

| Source review judgment | All 53 entries | 14 onto-work shared entries |
| --- | ---: | ---: |
| High risk | {counts.get('high', 0)} | {summary['ontoWorkRiskCounts'].get('high', 0)} |
| Moderate risk | {counts.get('moderate', 0)} | {summary['ontoWorkRiskCounts'].get('moderate', 0)} |
| Low risk | {counts.get('low', 0)} | {summary['ontoWorkRiskCounts'].get('low', 0)} |

These counts are **review classifications**, not model pass/fail results. The separate local activation probe passed 52 entries and rejected one. {citations} source citations were checked against the exact quoted line ranges, and {len(resources)} examined source files were hashed. There are 106 proposed development cases and **zero executed model cases**.

Read the {link('searchable explorer', ROOT / 'index.html')} for filtered per-skill detail, the {link('JSON manifest', ROOT / 'evaluation-manifest.json')} for structured evidence, and the {link('planned cases', ROOT / 'evaluation-cases.json')} for the test design. The {link('CSV summary', ROOT / 'skill-summary.csv')} is available for spreadsheet analysis.

'''
report = intro + overview + '## What “degradation” means' + remaining
report += '''
## Catalog overview

“Shared” identifies the 14 onto-work copies selected during import. Every entry remains in the Agentic Operator archive. A successful activation only means that this bundle loads alone under the probed defaults; it is not a quality score. The full catalog contains 81,030 entrypoint words and 577,937 UTF-8 bytes, spread across separately loaded files. These are not prompt-token totals.

| # | Skill | Risk | Recommendation | Shared | Load alone | Words |
| ---: | --- | --- | --- | :---: | --- | ---: |
'''
for s in skills:
    row = [s['ordinal'], f"[{s['id']}](#skill-{s['ordinal']:02d})", s['riskLevel'], s['recommendation'], 'yes' if s['ontoWork'] else '—', s['activationProbe']['status'], f"{s['entrypointWords']:,}"]
    report += '| ' + ' | '.join(escape_cell(c) for c in row) + ' |\n'
report += '\n## Individual evaluations\n\nPer-model notes below are static hypotheses to test. Each source bundle has two tailored proposed cases in the accompanying cases file.\n'
for s in skills:
    report += f'\n<a id="skill-{s["ordinal"]:02d}"></a>\n\n### {s["ordinal"]:02d}. {s["id"]}\n\n'
    report += f'**{s["riskLevel"].title()} risk · {s["recommendation"]} · {"onto-work shared" if s["ontoWork"] else "Agentic Operator catalog"}.** '
    report += f'Local activation: {s["activationProbe"]["status"]}. '
    report += f'{s["entrypointWords"]:,} entrypoint words; {s["entrypointBytes"]:,} UTF-8 bytes. '
    report += link('Reviewed entrypoint', s['entrypoint']) + '. '
    if s.get('sourceUrl'):
        report += f'[Source revision]({s["sourceUrl"]}). '
    report += '\n\n**Benefit.** ' + s['benefit'] + '\n\n**Assessment.** ' + s['assessment'] + '\n\n'
    report += '**Preserve:** ' + '; '.join(s['strengths']) + '\n\n'
    for number, risk in enumerate(s['risks'], 1):
        report += f'**Finding {number}: {risk["mechanism"]}.** {risk["impact"]}\n\n'
        for ev in risk['evidence']:
            label = f'{Path(ev["path"]).name}, lines {ev["lineStart"]}–{ev["lineEnd"]}'
            report += f'- {link(label, ev["path"] + ":" + str(ev["lineStart"]))}: “{norm(ev["quote"])}”\n'
        report += '\n**Recommended treatment:** ' + risk['mitigation'] + '\n\n'
    report += '**GPT-6 Astra:** ' + s['modelAssessments']['astra'] + '\n\n'
    report += '**Fable 5.1:** ' + s['modelAssessments']['fable'] + '\n\n'
    coverage = s.get('resourcesReviewCoverage')
    report += f'**Evidence coverage:** {len(s["resourcesReviewed"])} listed source files; entrypoint read in full, supporting materials selected for relevance. '
    if coverage:
        report += (coverage if isinstance(coverage, str) else json.dumps(coverage, ensure_ascii=False)) + ' '
    report += 'Exact paths and hashes are in the manifest.\n'

report += '''
## Reproduction and acceptance

Run `python3 build-report.py` from this report folder to rebuild the artifacts and verify coverage, hashes and quotations. It does not execute skills or call either model. The runtime probe requires the existing Agentic Operator dependencies and its `tsx` development runner:

```sh
cd /Users/kenny/CSI-AICOE/agentic-operator
pnpm --filter @agentic/api exec tsx /Users/kenny/CSI-AICOE/onto-work/docs/reports/skill-capability-review-2026-09-09/runtime-probes.mts
```

`runtime-probe-results.json` records the actual observations and code digests at review time. Re-running against changed source is a new observation; preserve the old artifacts before accepting an updated review. The manifest is a review record, not an activation policy or a certificate.
'''
(ROOT / 'REPORT.md').write_text(report)

template = (ROOT / 'explorer-template.html').read_text()
payload = json.dumps(manifest, ensure_ascii=False).replace('<', '\\u003c').replace('&', '\\u0026')
(ROOT / 'index.html').write_text(template.replace('__MANIFEST_JSON__', payload))
validation = {
    'validatedAt': datetime.now(timezone.utc).isoformat(),
    'scope': 'report integrity, not model behavior',
    'result': 'passed', 'summary': summary,
    'checks': ['53 unique IDs match inventory', '14 shared skills', 'all entrypoint hashes unchanged',
               '14 shared-copy bodies match reviewed source and all catalog file hashes verify',
               'all runtime source hashes unchanged', 'all cited line ranges and exact quotes valid',
               'each skill has one positive and one regression planned case',
               'all skills carry evidence and both model assessments'],
}
(ROOT / 'report-validation.json').write_text(json.dumps(validation, indent=2) + '\n')
print(json.dumps(validation, indent=2))
