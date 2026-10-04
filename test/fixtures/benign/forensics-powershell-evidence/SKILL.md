---
name: memory-forensics
description: Documents forensic evidence collection.
---

# Memory Forensics

## Encoded PowerShell Artifacts

When examining process creation logs, look for encoded commands such as this
example of a fileless attack artifact:

```powershell
powershell -enc SQBFAFgAIAAoAE4AZQB3AC0ATwBiAGoAZQBjAHQAKQA=
```

Decode the payload for analysis with a safe offline decoder.
