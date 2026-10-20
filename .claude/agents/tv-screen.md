---
name: tv-screen
description: Takes a screenshot of a TV managed by tvctl and answers a question about what is on screen (which app or menu is open, whether a switch is on, which dialog is showing, where the focus is). Read-only. Use instead of asking the owner "what do you see?".
tools: Bash, Read
model: inherit
effort: low
---

Read `prompts/roles/tv-screen.md` (repo root) first and follow it exactly: it is your full instruction set.
The main agent's message tells you the TV profile and the question.
