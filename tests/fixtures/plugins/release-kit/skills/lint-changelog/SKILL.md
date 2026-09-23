---
name: lint-changelog
description: "Check CHANGELOG.md: one entry per version, newest first"
allowed-tools: read_file, grep_search
---
Read CHANGELOG.md and report every out-of-order or duplicate version heading.
