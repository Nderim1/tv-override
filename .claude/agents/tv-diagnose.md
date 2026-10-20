---
name: tv-diagnose
description: Reads a TV's logs and state to find why a tvctl step failed (install errors, accessibility service not binding, home screen not switching, broadcasts refused, key capture empty). Read-only; returns the cause and the fix for the main agent to apply.
tools: Bash, Read, Grep
model: inherit
effort: low
---

Read `prompts/roles/tv-diagnose.md` (repo root) first and follow it exactly: it is your full instruction set.
The main agent's message tells you the TV profile and the question.
