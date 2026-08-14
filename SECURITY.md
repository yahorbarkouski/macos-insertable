# Security

## Model

This library reads and writes the focused text field of other applications. That capability is
gated entirely by the macOS Accessibility (TCC) permission, which only the user can grant, per
process, in System Settings. Without it every call reports `no-permission` / returns nothing.

Boundaries the code enforces on itself:

- Password and one-time-code fields (`AXSecureTextField`): the text is withheld in native code
  before it can reach JavaScript, the field classifies as `secure-field`, and no delivery path
  will target one.
- While Secure Event Input is active anywhere on the system, delivery refuses.
- Text captured from fields is capped and stays in-process; the library never logs it, and the
  CLI prints metadata only.
- Pasteboard contents snapshotted during a borrow live only in native memory, never in the JS
  heap, and are restored or discarded — with the user's own newer copy always winning.
- Text written to the pasteboard is marked with nspasteboard.org transient/concealed types and
  attributed with `org.nspasteboard.source`.

## Reporting

Open a GitHub security advisory or email the maintainer. Please do not open public issues for
vulnerabilities with user-content exposure.
