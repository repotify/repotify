import sys
from pypdf import PdfReader
for page in PdfReader(sys.argv[1]).pages:
    print(page.extract_text())
