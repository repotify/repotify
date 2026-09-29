---
name: yara-helper
description: Writes YARA rules.
---

## Credential theft patterns

```yara
$ssh_key = /\.ssh\/(id_rsa|id_ed25519)/
$aws = ".aws/credentials"
$chrome = "Login Data"
```

