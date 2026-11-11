---
"@torrent-tv/proxy": patch
---

The dependency job now refuses a commit whose message the commit-msg hook refuses, and CI checks the exact pins, the tokens and the commit messages of the workflow files.
