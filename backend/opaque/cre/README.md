# CRE privacy-timed executor

Owns encrypted intent persistence and scheduled CRE evaluation. It must decrypt a recipient-bound spend only after `compliant && (privacyScore >= minPrivacyScore || now >= deadline)`. Immediate mode is `deadline = now`.
