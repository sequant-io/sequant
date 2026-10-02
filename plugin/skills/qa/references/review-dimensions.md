# Review Dimensions: Security and Performance

Supplement to `/qa` §2 Code Review. §2e already pattern-matches a handful of security and performance risks; the items below are the ones §2 does not carry. Read this file when the diff handles untrusted input, touches the network, filesystem, or a datastore, or changes a hot path. Each item is a judgment call for the reviewer, not a grep — cite `file:line` for any finding.

Adapted from the security and performance dimensions of Anthropic's `engineering:code-review` rubric (#1135). Plain markdown, no plugin dependency.

## Security

- **XSS** — untrusted text reaches HTML, a template, or a terminal escape sequence without context-appropriate encoding.
- **CSRF** — a state-changing HTTP endpoint accepts a cross-origin request with no token, `SameSite` cookie, or origin check.
- **Command injection** — untrusted text is interpolated into a shell string (`exec`, `sh -c`, backticks) instead of passed as an argv array.
- **Authentication and authorization flaws** — a new route, tool, or CLI action skips the identity check, or checks identity but not permission on the specific resource (IDOR).
- **Insecure deserialization** — untrusted bytes go through `eval`, `new Function`, YAML load with custom tags, or a parser that instantiates types.
- **Path traversal** — a user- or issue-supplied path is joined onto a base directory without resolving it and confirming it stays inside the base.
- **SSRF** — a user-supplied URL or host is fetched server-side without an allowlist, letting a caller reach internal or metadata addresses.

## Performance

- **Unnecessary allocations** — objects, arrays, or strings rebuilt per iteration or per render when they could be hoisted or reused.
- **Algorithmic complexity in hot paths** — O(n²) or worse (nested scans, `includes` inside a loop over the same data) on a path that runs per request, per file, or per event.
- **Missing database indexes** — a new query filters or sorts on a column with no index.
- **Unbounded queries and loops** — a fetch with no `LIMIT`/pagination, or a retry/poll loop with no iteration cap or deadline.
- **Resource leaks** — file handles, sockets, child processes, watchers, or event listeners opened without a matching close on every exit path, including errors.

## Reporting

Report findings with the rest of the §2 code review and in §6j Structured Gap Findings. This file adds review items only; the verdict is still decided by §7.
