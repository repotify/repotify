import subprocess, sys
sys.exit(subprocess.call(['ruff', 'check', '.']))
