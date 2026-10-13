---
description: Integration-test parent with a real configured model
mode: primary
model: openrouter/anthropic/claude-haiku-5.5
permissions:
  - action: "*"
    resource: "*"
    effect: deny
  - action: subagent
    resource: mc-sub
    effect: allow
  - action: subagent
    resource: zzz-unseen
    effect: allow
---

Reply with exactly the text the user sends. Do not use tools and do not delegate.