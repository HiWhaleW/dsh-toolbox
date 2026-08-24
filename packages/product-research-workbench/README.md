# Product Research Workbench

A local-first MVP that turns pasted text and public web pages into traceable evidence cards, pain clusters, opportunity scores, and Markdown/HTML reports, with human evidence and project backup/restore.

## Install

```sh
mkdir -p dist
npm pack --workspace @dsh-toolbox/product-research-workbench --pack-destination dist
dsh plugin --profile web add ./dist/dsh-toolbox-product-research-workbench-0.2.1.tgz
```

Restart or reload the selected profile as required by your DSH release candidate.

## Tools

- `research_create` — create a local research project.
- `research_add_source` — add either pasted text or one public `http(s)` URL.
- `research_extract` — derive evidence cards locally using deterministic rules.
- `research_analyze` — group pain evidence and score opportunities.
- `research_report` — write Markdown, HTML, or both under the local data directory.
- `research_list` / `research_get` — inspect local projects and their provenance.
- `research_evidence_add` — add a human-reviewed evidence card.
- `research_export` / `research_import` — back up and restore full projects; raw source bodies require explicit opt-in.
- `research_source_delete` / `research_project_delete` — confirmed deletion with stale-analysis cleanup.

Suggested sequence:

```text
research_create → research_add_source → research_extract → research_analyze → research_report
```

## Configuration

The profile patch uses safe defaults. Add a `config` block to `cordis.patch.yml` if needed:

```yaml
config:
  dataDir: /absolute/local/path
  timeoutMs: 15000
  maxSourceBytes: 1048576
  maxRedirects: 3
  allowPrivateNetwork: false
```

`dataDir` defaults to `~/.local/share/dsh-toolbox/product-research-workbench`. URL requests are unauthenticated. Private, loopback, link-local, multicast, and metadata-network destinations are rejected by default. The response is capped before conversion to plain text.

## MVP limits

- Extraction and clustering are transparent deterministic heuristics, not an LLM call.
- English and Chinese pain language is supported, but taxonomy quality depends on source phrasing.
- HTML extraction is intentionally conservative and is not a full browser renderer.
- Authenticated social media crawling, CAPTCHA bypass, cloud sync, multi-user access, and auto-publishing are out of scope.
- The tested target is DSH `0.1.1-rc.2`; repeat an isolated install check before changing RCs.

The SQLite database and generated reports may contain private or copyrighted material. They are ignored by the repository defaults; review reports before sharing. See the repository privacy and security policies.

## License

Source-available under the PolyForm Noncommercial License 1.0.0. Commercial use is not permitted; see the packaged `LICENSE` file.
