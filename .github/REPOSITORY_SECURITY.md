# Repository launch security checklist

Complete these owner-only settings before making the repository public:

- Keep `CODEOWNERS` assigned to the real repository owner or security team.
  Require that owner for `.github/workflows/**`, `package.json`,
  `package-lock.json`, `scripts/**`, `SECURITY.md`, `NOTICE`,
  `THIRD_PARTY_NOTICES.md`, `LICENSE`, and `firmware/LICENSE`.
- Protect the default branch. Require pull requests, at least one approval,
  resolved conversations, passing host/QMK/security checks, and review after the
  most recent push. Disallow force pushes and branch deletion.
- Protect release tags matching `v*` and restrict their creation and deletion.
- Restrict GitHub Actions to approved actions, require actions to be pinned to a
  full commit SHA, and keep the default workflow token read-only.
- Enable private vulnerability reporting, dependency graph, Dependabot alerts,
  secret scanning, and push protection.
- For a new repository, scan the complete staged tree before the first commit.
  After the initial push, obtain a complete clone and scan every reachable
  commit and ref for secrets.
- Resolve every high- and medium-severity security finding and physically verify
  enrolled QMK and gamepad behavior before claiming hardware support.

There is deliberately no npm publish workflow. If publishing is introduced,
first move to `@geareab/opencontrol`, retain exact repository metadata,
protect a GitHub Environment, build without credentials, and publish from a
minimal OIDC trusted-publisher job with provenance. Do not add a long-lived npm
token.
