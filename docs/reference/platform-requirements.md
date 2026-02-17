# Platform Requirements

Sequant is currently designed around GitHub as the issue tracking and code hosting platform. This document explains the dependency, provides workarounds for non-GitHub users, and outlines the roadmap for multi-platform support.

## Current GitHub Dependency

Sequant uses the GitHub CLI (`gh`) for:

- **Issue fetching** — Reading issue details, labels, and comments
- **Progress updates** — Posting plan and status comments to issues
- **PR creation** — Creating pull requests from feature branches
- **Workflow triggers** — Extracting acceptance criteria from issue bodies

### Why GitHub?

GitHub was chosen as the initial platform because:

1. **Mature CLI** — The `gh` CLI provides comprehensive API access
2. **Issue-PR linking** — Native support for "Closes #123" syntax
3. **Widespread adoption** — Most open-source projects use GitHub
4. **API consistency** — Stable, well-documented API

## Workarounds for Non-GitHub Users

If your team uses GitLab, Bitbucket, or another platform, you can still use Sequant with manual issue tracking.

### Option 1: Manual Issue Mode

Create issues manually and reference them by description instead of number:

```bash
# Instead of:
/spec 123

# Use a description:
/spec "Add user authentication with OAuth"
```

The workflow phases will still function, but:

- No automatic issue comments (plans, progress updates)
- No automatic PR linking
- You'll need to manually copy outputs to your issue tracker

### Option 2: GitHub Mirror

Some teams maintain a GitHub mirror for issue tracking while using another platform for code:

1. Create a GitHub repository for issues only
2. Run Sequant workflows against GitHub issues
3. Manually sync PRs to your main platform

This provides full Sequant functionality but requires maintaining two systems.

### Option 3: Local Tracking

Use Sequant without any remote issue tracker:

1. Create local markdown files for issues in `issues/` directory
2. Reference issues by filename: `/spec issues/add-auth.md`
3. Track progress in the same files

Example local issue format:

```markdown
<!-- issues/add-auth.md -->
# Add user authentication

## Acceptance Criteria
- [ ] Users can sign up with email
- [ ] Users can log in with password
- [ ] Sessions expire after 24 hours

## Progress
- [ ] Spec complete
- [ ] Implementation started
- [ ] QA passed
```

## Roadmap: Multi-Platform Support

Support for additional platforms is planned in phases:

### Phase 2: Provider Abstraction (Planned)

Create an `IssueProvider` interface that abstracts platform-specific operations:

```typescript
interface IssueProvider {
  fetchIssue(id: string): Promise<Issue>;
  postComment(id: string, body: string): Promise<void>;
  createPullRequest(options: PROptions): Promise<PR>;
}
```

This will allow swapping providers without changing skill logic.

### Phase 3: GitLab Support (Planned)

GitLab will be the first alternative platform, using the [`glab` CLI](https://gitlab.com/gitlab-org/cli):

```bash
# Future usage
sequant init --provider gitlab
```

Key considerations:

- GitLab issues have similar metadata (labels, milestones, comments)
- `glab` CLI provides equivalent functionality to `gh`
- GitLab merge requests map to GitHub PRs

### Phase 4: Bitbucket Support (Future)

Bitbucket support is under consideration:

- No official CLI (would use REST API directly)
- Different issue/PR model (Jira integration common)
- Lower priority due to complexity

## Contributing

Want to help add support for your platform? See the [contribution guidelines](../CONTRIBUTING.md) and:

1. Open an issue describing your platform's requirements
2. Propose an `IssueProvider` implementation
3. Include test coverage for the new provider

## Related Issues

- [#7 - Support GitLab and Bitbucket](https://github.com/sequant-io/sequant/issues/7)
