# Resuming a branch that has fallen behind (code-issue)

Read by the code-issue procedure only when resuming an existing feature branch.

If the feature branch already exists (resuming interrupted work) and has fallen behind:

```bash
git checkout feature/{branch-name} && git fetch origin && git merge origin/main
```

- **Clean merge** → continue
- **Conflicts detected** → resolve systematically:
  1. List conflicted files: `git diff --name-only --diff-filter=U`
  2. Read each conflict — understand both the incoming (default-branch) and the current (feature)
     change before resolving
  3. Resolution strategy:
     - Foundation/infrastructure changes from the default branch → prefer the default branch
     - New feature code → preserve the feature branch's intent
     - Logic conflicts (both sides modified the same function) → merge the intent of both; if the
       result is behaviorally ambiguous, ask the user when interactive, or when dispatched choose,
       and record the choice in the PR body
  4. Stage resolved files and complete: `git add {files} && git merge --continue`
  5. Run the project's full test suite to verify the merge
  6. If tests fail after the merge, fix the regressions before proceeding
