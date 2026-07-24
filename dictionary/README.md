# Letter Rush dictionary source

The game lexicon is generated from the ENABLE 2K word list at pinned
`BartMassey/wordlists` commit
`af52415c13af809bd8757a40f17f46e79d09583c`.

- Source archive: `source/enable2k.txt.gz`
- Source SHA-256:
  `2c1093669cd16439bdb0a693a0058626c9c9f82e59244c9b0bde89515d44d3ad`
- Upstream public-domain notice: `LICENSE-ENABLE.txt`
- Local additions: `custom-allowed.txt`
- Local removals: `custom-blocked.txt`
- Game dictionary version: `enable2k-af52415-v1`
- Generated word count: `173,528`

Run `npm run dictionary:generate` after changing a source or override file.
Generated first-letter modules are lazy-loaded so a phone parses only the
bucket needed for the submitted word. The generated SQL seed is used by the
authoritative database validator. `npm run build` also runs generation first,
and generation reads only the committed archive and override files.
