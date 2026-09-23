---
name: release-notes
description: >
  Write release notes for a tagged version
  from the commit log.
allowed-tools:
  - read_file
  - execute_command
metadata:
  owner: fixtures
---

# Release notes

1. Read `references/template.md` with read_skill_file and fill it in.
2. Collect the commits with `scripts/collect.sh <tag>` through the shell tool.
