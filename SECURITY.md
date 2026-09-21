# Security policy

crawlmeter sits in the request path of other people's sites, so security
reports are taken seriously and handled before anything else.

## Reporting a vulnerability

**Please do not open a public issue.** Use GitHub's private vulnerability
reporting instead: go to the repository's **Security** tab and choose
**Report a vulnerability**. Only the maintainers can see the report.

Useful things to include:

- the version of crawlmeter and of Node.js;
- the adapter (Express or Next.js) and the mode (`observe` or `enforce`);
- the smallest request or configuration that shows the problem.

You should get a first answer within a week. Once a fix is released, the
advisory is published with credit to the reporter, unless you prefer
otherwise.

## Supported versions

Only the latest published release receives fixes.

## What counts

Anything that lets a request get past the rules the site owner configured is
in scope, for example:

- being classified at a higher confidence level than the evidence supports
  (a forged `X-Forwarded-For` reaching `ip-range`, say);
- getting paid content without a valid, settled payment in `enforce` mode;
- a crafted request that crashes the host application or makes it stop
  serving content;
- crawlmeter sending data anywhere other than the destinations documented in
  the README.

## What crawlmeter never does

These are commitments, and each is enforced by a test:

- no telemetry: the package never contacts a server of ours;
- no install scripts, and no runtime dependencies;
- no code evaluation, no child processes, no file writes outside the store
  the site owner configured.
