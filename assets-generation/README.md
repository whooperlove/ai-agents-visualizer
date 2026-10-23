# Character atlas generation records

How `public/assets/office-characters.png` was produced.

- `prompts/office-characters.txt` — the prompt used to generate the atlas.
- `provenance/` — the prompt as submitted and the run metadata (tool used, hashes, token usage).
- `qa/` — the alpha measurements, the visual check notes and the white / black diagnostic composites.

Machine-specific values in these records are replaced by placeholders so the records can be shared:

| Placeholder | Stands for |
| --- | --- |
| `<queue-job-dir>` | the working directory of the local image-generation queue job |
| `<codex-home>` | the Codex home directory that held the generated image |

Paths inside this repository are repository-relative, and the Codex session id and rollout path were removed. The unredacted originals are kept locally as `*.local.*` files, which Git ignores.
