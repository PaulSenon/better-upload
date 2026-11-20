---
"@open-upload/core": patch
"@open-upload/client": patch
---

Large files: parts uploading in parallel share one sign request (about 10× fewer control requests); upload limits are capped at what multipart can store (`maxUploadSize()`, e.g. 48.8 TiB on AWS rather than 50 TiB); SHA part checksums hash ahead within a 128 MiB memory budget.
