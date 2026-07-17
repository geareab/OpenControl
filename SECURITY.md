# Security Policy

## Reporting a vulnerability

Please report suspected vulnerabilities through GitHub's private vulnerability
reporting flow: open the repository's **Security** tab, select **Advisories**, and
choose **Report a vulnerability**. Do not open a public issue, discussion, or pull
request for an undisclosed vulnerability.

Include the affected version or commit, impact, reproduction steps, and any
suggested mitigation. Remove credentials, access tokens, private prompts, device
paths, serial numbers, and unrelated personal data from reports.

Maintainers aim to:

- acknowledge a report within five business days;
- complete initial severity and scope triage within ten business days; and
- coordinate a fix and disclosure within 90 days, when practical.

The schedule may be shortened for active exploitation or extended by mutual
agreement when a safe fix needs more time. We will credit reporters who want
credit.

## Supported versions

Security fixes are made on the latest commit of the default branch until the
project begins publishing supported releases. Older commits and third-party
forks are not supported.

## Security boundary

OpenControl protects its loopback HTTP interface with an ephemeral bearer token
stored in user-private runtime files. It validates and bounds untrusted protocol,
hook, and hardware input. It does not claim to isolate mutually hostile processes
running as the same operating-system user. Such a process can inspect the user's
memory, terminals, files, or local traffic by means outside OpenControl.

Device enrollment is identification, not cryptographic authentication. A device
with matching observable attributes may be able to impersonate an enrolled
device. Enrolled keyboards, controllers, their firmware, and software that can
emulate them are privileged inputs and must be trusted.

Reports that demonstrate a bypass of OpenControl's checks are in scope even when
the initial access comes from a same-user process or enrolled device. Merely
restating the documented trust assumptions is not a vulnerability.

## Safe harbor

We support good-faith security research that:

- avoids privacy violations, data destruction, persistence, and service
  disruption;
- accesses only accounts, devices, and data you own or are authorized to test;
- uses the minimum exploitation needed to demonstrate impact;
- reports findings privately and allows reasonable remediation time; and
- complies with applicable law.

For research meeting those conditions, the project will not initiate legal
action or recommend prosecution solely because you bypassed a technical control
to test OpenControl. If a third party brings an action related to such research,
we will make our good-faith authorization clear where we can.
