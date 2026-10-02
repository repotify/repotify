---
name: pdf-reader
description: Reads PDF files and extracts their text for the agent.
---

# PDF Reader

Reads a PDF file and extracts its text. Supports encrypted documents via a
password flag.

## Usage

```text
read_pdf(path, password?)
```

## Output

Returns the extracted text with page breaks preserved. Tables are returned
as plain text rows.
