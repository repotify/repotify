---
name: win-scripts
description: Runs the project scripts on Windows.
---

# Windows

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\build.ps1 -ErrorAction SilentlyContinueOnErrors
pwsh -NoProfile -Command "Get-ChildItem -Recurse"
$bytes = [System.Convert]::FromBase64String($encoded)
[System.IO.File]::WriteAllBytes('out.png', $bytes)
```
