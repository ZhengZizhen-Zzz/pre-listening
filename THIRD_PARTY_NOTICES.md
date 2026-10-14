# Third-party code and references

## Bundled dependencies

- **PDF.js** — Mozilla contributors, Apache-2.0. Installed from the pinned npm package and copied to `public/vendor/pdfjs/` by `scripts/prepare-vendor.mjs`; license included there. Legacy compatibility build in `legacy-5.6.205/`.
- PDF.js CMaps, standard fonts and WASM components retain their respective notices in the same directories. These include Foxit, Liberation fonts, OpenJPEG, QCMS and JBIG2 components.
- **esbuild** — installed by the package manager; MIT license in the dependency package.
- **LibreOffice** — optional, separately installed by users; not redistributed in this repository.
- **Pillow / PyObjC** — optional macOS OCR dependencies installed by users; not vendored here.

## Design references

The following were studied as design references. Their service code was not incorporated; question criteria, answer review and rewrite interactions are independently implemented in this project's existing JavaScript / Node stack.

- [DeepInterview](https://github.com/ngoanpv/DeepInterview/tree/bd6d136fffc509265bc2355e95101e0ad7f56eac): questions with associated criteria and per-question evaluation.
- [iamspeaker](https://github.com/spark798/iamspeaker/tree/5be74a21457ae2c556058bde57084af8ce5d5079): linking actual speech, revised wording and reasons.
- [interviewOps](https://github.com/AnkitParekh007/interviewOps/tree/039fc9af4e9f2ebb34a32b5a0372b46ddd02fed4): modular evaluation criteria.

The original application code has no general open-source license grant at this time; public visibility does not override the separate licenses of bundled dependencies.
