# Superseded: CRE Stub

The first plain-JS stub of the privacy-timed executor, kept for the record. The working code is [`backend/cre/`](../../cre/) and the deployed workflow is [`opaque-cre/`](../../../opaque-cre/).

The rule it described still holds: a spend is opened only after `compliant && (privacyScore >= minPrivacyScore || now >= deadline)`, and an immediate payment is one whose minimum score is zero.
