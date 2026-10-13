---
description: Integration-test agent with an unusual id, configured with the model-compare quality alias
mode: subagent
model: openrouter/model-compare/quality
permissions:
  - action: "*"
    resource: "*"
    effect: deny
---

Reply with exactly the text the user sends. Do not use tools.